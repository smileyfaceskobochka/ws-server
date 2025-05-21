package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"path/filepath"
	"sync"

	"github.com/gorilla/websocket"
)

// DeviceState — состояние устройства, включая три относительных шага
type DeviceState struct {
	ID             string   `json:"id"`
	Power          bool     `json:"power"`
	Color          [3]uint8 `json:"color"`
	Brightness     uint8    `json:"brightness"`
	AutoBrightness bool     `json:"auto_brightness"`
	Position       [3]int32 `json:"position"`
	AutoPosition   bool     `json:"auto_position"`
	Distance       float64  `json:"distance"`
}

// Message — общий формат JSON-сообщения
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

	// Читаем регистрацию
	_, raw, err := ws.ReadMessage()
	if err != nil {
		log.Println("invalid register from device:", err)
		h.broadcastLog("invalid register from device: " + err.Error())
		return
	}
	var reg Message
	if err := json.Unmarshal(raw, &reg); err != nil || reg.Type != "register" || reg.ID == "" {
		log.Println("invalid register payload:", string(raw))
		h.broadcastLog("invalid register: " + string(raw))
		return
	}
	id := reg.ID

	// Заменяем старое ws (если было), храним новое
	h.mu.Lock()
	if old, ok := h.devices[id]; ok {
		old.Close()
	}
	h.devices[id] = ws
	// При (ре)подключении шлём ему последнее known state как control
	if st, ok := h.deviceStates[id]; ok {
		_ = ws.WriteJSON(Message{Type: "control", ID: id, State: &st})
	}
	h.mu.Unlock()

	log.Printf("device connected: %s", id)
	h.broadcastLog("device connected: " + id)

	// Обрабатываем сообщения от устройства
	for {
		var msg Message
		if err := ws.ReadJSON(&msg); err != nil {
			log.Printf("device [%s] disconnected: %v", id, err)
			h.broadcastLog("device [" + id + "] disconnected")
			break
		}
		switch msg.Type {
		case "state":
			if msg.State == nil {
				continue
			}
			st := *msg.State
			st.ID = id
			h.mu.Lock()
			h.deviceStates[id] = st
			for c := range h.clients {
				_ = c.WriteJSON(Message{Type: "state", ID: id, State: &st})
			}
			h.mu.Unlock()
			log.Printf("state saved for %s: pos=%v", id, st.Position)
			h.broadcastLog("state saved: " + id)
		case "log":
			if msg.Message != "" {
				h.broadcastLog("[" + id + "] " + msg.Message)
			}
		}
	}

	// Очистка
	h.mu.Lock()
	if cur, ok := h.devices[id]; ok && cur == ws {
		delete(h.devices, id)
		h.broadcastLog("device removed: " + id)
	}
	delete(h.clients, ws)
	h.mu.Unlock()
}

func (h *Hub) handleClient(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade client:", err)
		return
	}
	defer ws.Close()

	// Регистрируем нового UI-клиента и шлём текущее состояние
	h.mu.Lock()
	h.clients[ws] = true
	for id, st := range h.deviceStates {
		_ = ws.WriteJSON(Message{Type: "state", ID: id, State: &st})
	}
	h.mu.Unlock()

	log.Println("client connected")
	for {
		var msg Message
		if err := ws.ReadJSON(&msg); err != nil {
			log.Println("client disconnected:", err)
			break
		}
		// UI прислал control
		if msg.Type == "control" && msg.ID != "" && msg.State != nil {
			h.mu.Lock()
			dev, ok := h.devices[msg.ID]
			if !ok {
				_ = ws.WriteJSON(map[string]string{"type": "error", "message": "Device not found"})
				h.mu.Unlock()
				continue
			}

			// 1) Пересылаем полный control на устройство
			_ = dev.WriteJSON(msg)
			log.Printf("forward to device %s: %+v\n", msg.ID, msg.State)

			// 2) Обнуляем только stored.Position, без рассылки UI-клиентам
			stored := h.deviceStates[msg.ID]
			stored.Position = [3]int32{0, 0, 0}
			h.deviceStates[msg.ID] = stored

			h.mu.Unlock()
		}
	}

	// Удаляем UI-клиента
	h.mu.Lock()
	delete(h.clients, ws)
	h.mu.Unlock()
	log.Println("client removed")
}

func main() {
	addr := flag.String("addr", ":80", "server address")
	staticDir := flag.String("static", "client/dist", "static files dir")
	flag.Parse()

	hub := newHub()
	http.HandleFunc("/ws/device", hub.handleDevice)
	http.HandleFunc("/ws/client", hub.handleClient)

	// Статика
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
