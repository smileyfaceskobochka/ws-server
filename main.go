package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"path/filepath"
	"sync"

	//"time"

	"github.com/gorilla/websocket"
)

// DeviceState now includes Distance
type DeviceState struct {
	ID             string   `json:"id"`
	Power          bool     `json:"power"`
	Color          [3]uint8 `json:"color"`
	Brightness     uint8    `json:"brightness"`
	AutoBrightness bool     `json:"auto_brightness"`
	Position       [4]uint8 `json:"position"`
	AutoPosition   bool     `json:"auto_position"`
	Distance       float64  `json:"distance"`
}

type Message struct {
	Type    string       `json:"type"`
	ID      string       `json:"id,omitempty"`
	State   *DeviceState `json:"state,omitempty"`
	Message string       `json:"message,omitempty"`
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

type Hub struct {
	mu           sync.Mutex
	devices      map[string]*websocket.Conn
	deviceStates map[string]DeviceState
	clients      map[*websocket.Conn]bool
}

func newHub() *Hub {
	return &Hub{
		devices:      make(map[string]*websocket.Conn),
		deviceStates: make(map[string]DeviceState),
		clients:      make(map[*websocket.Conn]bool),
	}
}

func (h *Hub) broadcastLog(line string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	msg := map[string]interface{}{"type": "log", "message": line}
	for c := range h.clients {
		_ = c.WriteJSON(msg)
	}
}

func (h *Hub) handleDevice(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade device:", err)
		h.broadcastLog("upgrade device: " + err.Error())
		return
	}
	defer ws.Close()

	// First message should be register
	_, rawPayload, err := ws.ReadMessage()
	if err != nil {
		log.Println("invalid register from device (read error):", err)
		h.broadcastLog("invalid register from device: " + err.Error())
		return
	}
	var msg Message
	if err := json.Unmarshal(rawPayload, &msg); err != nil || msg.Type != "register" || msg.ID == "" {
		log.Println("invalid register from device (json or type/id):", string(rawPayload))
		h.broadcastLog("invalid register from device: " + string(rawPayload))
		return
	}
	id := msg.ID

	// Store connection, closing old if exists
	h.mu.Lock()
	if old, ok := h.devices[id]; ok {
		old.Close()
	}
	h.devices[id] = ws

	// Send last known state (if any) to device
	if st, ok := h.deviceStates[id]; ok {
		ctrl := Message{Type: "control", State: &st}
		ctrl.State.ID = id
		data, _ := json.Marshal(ctrl)
		ws.WriteMessage(websocket.TextMessage, data)
	}
	h.mu.Unlock()

	log.Printf("device connected: %s\n", id)
	h.broadcastLog("device connected: " + id)

	// Read further messages from device
	for {
		var m Message
		if err := ws.ReadJSON(&m); err != nil {
			log.Printf("device [%s] disconnected: %v\n", id, err)
			h.broadcastLog("device [" + id + "] disconnected")
			break
		}
		if m.Type == "state" && m.State != nil {
			st := *m.State
			st.ID = id
			// Extract and remove distance
			dist := st.Distance
			st.Distance = 0
			// Save state without distance
			h.mu.Lock()
			h.deviceStates[id] = st
			// Broadcast to all web-clients with distance
			for c := range h.clients {
				stateToSend := st
				stateToSend.Distance = dist
				_ = c.WriteJSON(Message{Type: "state", ID: id, State: &stateToSend})
			}
			h.mu.Unlock()
			log.Printf("state saved and broadcast for device %s: %+v\n", id, st)
			h.broadcastLog("state saved and broadcast: " + id)
		}
		if m.Type == "log" && m.ID == id && m.Message != "" {
			// Log from device
			h.broadcastLog("[" + id + "] " + m.Message)
		}
	}

	// Cleanup on disconnect
	h.mu.Lock()
	if cur, ok := h.devices[id]; ok && cur == ws {
		delete(h.devices, id)
		log.Printf("device removed: %s\n", id)
		h.broadcastLog("device removed: " + id)
	} else {
		log.Printf("cleanup skipped for %s: another connection is active\n", id)
	}
	h.mu.Unlock()
}

func (h *Hub) handleClient(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade client:", err)
		return
	}
	defer ws.Close()

	h.mu.Lock()
	h.clients[ws] = true
	for id, st := range h.deviceStates {
		_ = ws.WriteJSON(Message{Type: "state", ID: id, State: &st})
	}
	h.mu.Unlock()

	log.Println("client connected")
	// Listen for control messages from client
	for {
		var m Message
		if err := ws.ReadJSON(&m); err != nil {
			log.Println("client disconnected:", err)
			break
		}
		if m.Type == "control" && m.ID != "" && m.State != nil {
			h.mu.Lock()
			if dev, ok := h.devices[m.ID]; ok {
				// Forward to device
				_ = dev.WriteJSON(m)
				log.Printf("forward to device %s: %v\n", m.ID, m)
			} else {
				// No such device
				_ = ws.WriteJSON(map[string]string{"type": "error", "message": "Device not found"})
			}
			h.mu.Unlock()
		}
	}
	h.mu.Lock()
	delete(h.clients, ws)
	h.mu.Unlock()
	log.Println("client removed")
}

func main() {
	addr := flag.String("addr", ":80", "server address")
	staticDir := flag.String("static", "client/dist", "path to static files")
	flag.Parse()

	hub := newHub()

	http.HandleFunc("/ws/device", hub.handleDevice)
	http.HandleFunc("/ws/client", hub.handleClient)
	fs := http.FileServer(http.Dir(*staticDir))
	http.Handle("/static/", fs)
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if f, err := http.Dir(*staticDir).Open(r.URL.Path); err == nil {
			f.Close()
			fs.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(*staticDir, "index.html"))
	})

	log.Printf("Listening on %s\n", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
