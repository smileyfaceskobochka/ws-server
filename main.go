package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// -----------------------------
// Модель данных
// -----------------------------

// DeviceState представляет состояние одного устройства
type DeviceState struct {
	ID             string   `json:"id"`
	Power          bool     `json:"power"`
	Color          [3]uint8 `json:"color"`
	Brightness     uint8    `json:"brightness"`
	AutoBrightness bool     `json:"auto_brightness"`
	Position       [4]uint8 `json:"position"`
	AutoPosition   bool     `json:"auto_position"`
}

// Message — обёртка для JSON-сообщений
type Message struct {
	Type    string       `json:"type"`
	ID      string       `json:"id,omitempty"`
	State   *DeviceState `json:"state,omitempty"`
	Message string       `json:"message,omitempty"`
}

// -----------------------------
// Серверная логика
// -----------------------------

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// Hub хранит устройства и веб-клиентов
type Hub struct {
	mu           sync.Mutex
	devices      map[string]*websocket.Conn // id→устройство
	deviceStates map[string]DeviceState     // id→последнее состояние
	clients      map[*websocket.Conn]bool   // веб-клиенты
}

func newHub() *Hub {
	return &Hub{
		devices:      make(map[string]*websocket.Conn),
		deviceStates: make(map[string]DeviceState),
		clients:      make(map[*websocket.Conn]bool),
	}
}

// broadcastLog отправляет лог всем клиентам
func (h *Hub) broadcastLog(line string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	msg := map[string]interface{}{"type": "log", "message": line}
	for c := range h.clients {
		_ = c.WriteJSON(msg)
	}
}

// handleDevice — WS-эндпоинт для ESP32
func (h *Hub) handleDevice(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade device:", err)
		h.broadcastLog("upgrade device: " + err.Error())
		return
	}
	defer ws.Close()

	// Читаем первое сообщение как текст
	_, rawPayload, err := ws.ReadMessage()
	if err != nil {
		log.Println("invalid register from device (read error):", err)
		h.broadcastLog("invalid register from device (read error): " + err.Error())
		return
	}
	log.Printf("raw register payload from device: %s\n", string(rawPayload))
	h.broadcastLog("raw register payload from device: " + string(rawPayload))
	var msg Message
	if err := json.Unmarshal(rawPayload, &msg); err != nil || msg.Type != "register" || msg.ID == "" {
		log.Printf("invalid register from device (json or type/id): err=%v, msg=%+v, raw=%s\n", err, msg, string(rawPayload))
		h.broadcastLog("invalid register from device (json or type/id): " + string(rawPayload))
		return
	}
	id := msg.ID

	// Сохраняем соединение, старое убираем
	h.mu.Lock()
	if old, ok := h.devices[id]; ok {
		log.Printf("device [%s] reconnect: closing old connection\n", id)
		h.broadcastLog("device [" + id + "] reconnect: closing old connection")
		old.Close()
	}
	h.devices[id] = ws

	// Если есть сохранённое состояние — шлём его устройству
	if st, ok := h.deviceStates[id]; ok {
		ctrl := Message{Type: "control", State: &st}
		ctrl.State.ID = id
		data, _ := json.Marshal(ctrl)
		log.Printf("send last state to device [%s]: %+v\n", id, st)
		h.broadcastLog("send last state to device [" + id + "]: " + string(data))
		ws.WriteMessage(websocket.TextMessage, data)
	}
	h.mu.Unlock()

	log.Printf("device connected: %s\n", id)
	h.broadcastLog("device connected: " + id)
	// Слушаем дальнейшие сообщения
	for {
		var m Message
		if err := ws.ReadJSON(&m); err != nil {
			log.Printf("device [%s] disconnected: %v\n", id, err)
			h.broadcastLog("device [" + id + "] disconnected: " + err.Error())
			break
		}
		log.Printf("from device [%s]: %v\n", id, m)
		if m.Type == "state" && m.State != nil {
			st := *m.State
			st.ID = id
			// Сохраняем состояние
			h.mu.Lock()
			h.deviceStates[id] = st
			// Рассылаем всем веб-клиентам
			for c := range h.clients {
				_ = c.WriteJSON(Message{Type: "state", ID: id, State: &st})
			}
			h.mu.Unlock()
			log.Printf("state saved and broadcast: %s → %+v\n", id, st)
			h.broadcastLog("state saved and broadcast: " + id)
		}
		if m.Type == "log" && m.ID == id && m.State == nil {
			// Лог от устройства
			if m.ID != "" && m.Message != "" {
				h.broadcastLog("[" + id + "] " + m.Message)
			}
		}
	}

	// cleanup
	h.mu.Lock()
	delete(h.devices, id)
	h.mu.Unlock()
	log.Printf("device removed: %s (delayed)\n", id)
	h.broadcastLog("device removed: " + id)
	time.Sleep(2 * time.Second)
	// Здесь можно добавить дополнительную очистку, если потребуется
}

// handleClient — WS-эндпоинт для браузеров
func (h *Hub) handleClient(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade client:", err)
		return
	}
	defer ws.Close()

	// Регистрируем клиента
	h.mu.Lock()
	h.clients[ws] = true
	// Отправляем ему текущее состояние всех устройств
	for id, st := range h.deviceStates {
		_ = ws.WriteJSON(Message{Type: "state", ID: id, State: &st})
	}
	h.mu.Unlock()

	log.Println("client connected")
	// Слушаем команды от клиента
	for {
		var m Message
		if err := ws.ReadJSON(&m); err != nil {
			log.Println("client disconnected:", err)
			break
		}
		log.Println("from client:", m)
		if m.Type == "control" && m.ID != "" && m.State != nil {
			h.mu.Lock()
			if dev, ok := h.devices[m.ID]; ok {
				// Переправляем команду устройству
				_ = dev.WriteJSON(m)
				log.Printf("forward to device %s: %v\n", m.ID, m)
			} else {
				// Нет такого устройства
				_ = ws.WriteJSON(map[string]string{"type": "error", "message": "Device not found"})
				log.Printf("error: device %s not found\n", m.ID)
			}
			h.mu.Unlock()
		}
	}

	// cleanup
	h.mu.Lock()
	delete(h.clients, ws)
	h.mu.Unlock()
	log.Println("client removed")
}

// -----------------------------
// main + статические файлы
// -----------------------------

func main() {
	addr := flag.String("addr", ":80", "адрес сервера")
	staticDir := flag.String("static", "client/dist", "путь к React-сборке")
	flag.Parse()

	hub := newHub()

	// WS для устройств и веб-клиентов
	http.HandleFunc("/ws/device", hub.handleDevice)
	http.HandleFunc("/ws/client", hub.handleClient)

	// Статика React
	fs := http.FileServer(http.Dir(*staticDir))
	http.Handle("/static/", fs)

	// SPA-fallback: остальные GET → index.html
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if f, err := http.Dir(*staticDir).Open(r.URL.Path); err == nil {
			f.Close()
			fs.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(*staticDir, "index.html"))
	})

	log.Printf("Listening on %s, static at %s\n", *addr, *staticDir)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
