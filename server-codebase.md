Сервер на golang:
```go
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
```

Клиент на React + TS + Vite:
```tsx
// App.tsx
import React, { useState, useEffect, useRef } from 'react';
import { Routes, Route } from 'react-router-dom';
import AdminPanel from './AdminPanel';
import './styles.css';
import './themes.css';
// Импорт heroicons light-bulb через SVGR
import LightBulbIcon from './assets/heroicons-light-bulb.svg?react';

const DEVICE_ID = "esp32-s3-device"; // фиксируем id устройства

const App: React.FC = () => {
  // themeOptions - список тем для выбора
  const themeOptions = [
    { value: 'mocha', label: 'Catppuccin Mocha' },
    { value: 'latte', label: 'Catppuccin Latte' },
    { value: 'frosted-dark', label: 'Frosted Glass Dark' },
    { value: 'frosted-light', label: 'Frosted Glass Light' },
  ];

  // Тип для темы
  const [theme, setTheme] = useState<'mocha' | 'latte' | 'frosted-dark' | 'frosted-light'>('mocha');
  const [brightness, setBrightness] = useState<number>(50);
  const [r, setR] = useState<number>(255);
  const [g, setG] = useState<number>(255);
  const [b, setB] = useState<number>(255);
  const [autoBrightness, setAutoBrightness] = useState<boolean>(false);
  const [autoPosition, setAutoPosition] = useState<boolean>(false);
  const [p0, setP0] = useState<number>(0);
  const [p1, setP1] = useState<number>(0);
  const [p2, setP2] = useState<number>(0);
  const [p3, setP3] = useState<number>(0);
  const [helpOpen, setHelpOpen] = useState<boolean>(false);
  const [power, setPower] = useState<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Подключение к WebSocket
  useEffect(() => {
    const ws = new WebSocket("ws://meowww.su:80/ws/client");
    wsRef.current = ws;
    ws.onopen = () => {
      // Можно запросить состояние, если нужно
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "state" && msg.id === DEVICE_ID && msg.state) {
          setPower(!!msg.state.power);
          setBrightness(Number(msg.state.brightness));
          setR(Number(msg.state.color?.[0] ?? 0));
          setG(Number(msg.state.color?.[1] ?? 0));
          setB(Number(msg.state.color?.[2] ?? 0));
          setAutoBrightness(!!msg.state.auto_brightness);
          setAutoPosition(!!msg.state.auto_position);
          setP0(Number(msg.state.position?.[0] ?? 0));
          setP1(Number(msg.state.position?.[1] ?? 0));
          setP2(Number(msg.state.position?.[2] ?? 0));
          setP3(Number(msg.state.position?.[3] ?? 0));
        }
      } catch {}
    };
    ws.onclose = () => { wsRef.current = null; };
    return () => { ws.close(); };
  }, []);

  // Отправка состояния на сервер
  const sendControl = (nextState?: Partial<any>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      const state = {
        power,
        color: [r, g, b],
        brightness,
        auto_brightness: autoBrightness,
        position: [p0, p1, p2, p3],
        auto_position: autoPosition,
        ...nextState,
      };
      ws.send(JSON.stringify({ type: "control", id: DEVICE_ID, state }));
    }
  };

  // Обработчики с отправкой
  const handlePower = () => {
    setPower((prev) => {
      sendControl({ power: !prev });
      return !prev;
    });
  };
  const handleBrightness = (v: number) => {
    setBrightness(v);
    sendControl({ brightness: v });
  };
  const handleR = (v: number) => { setR(v); sendControl({ color: [v, g, b] }); };
  const handleG = (v: number) => { setG(v); sendControl({ color: [r, v, b] }); };
  const handleB = (v: number) => { setB(v); sendControl({ color: [r, g, v] }); };
  const handleAutoBrightness = () => {
    setAutoBrightness((prev) => {
      sendControl({ auto_brightness: !prev });
      return !prev;
    });
  };
  const handleAutoPosition = () => {
    setAutoPosition((prev) => {
      sendControl({ auto_position: !prev });
      return !prev;
    });
  };
  const handleP = (idx: number, v: number) => {
    const arr = [p0, p1, p2, p3];
    arr[idx] = v;
    setP0(arr[0]); setP1(arr[1]); setP2(arr[2]); setP3(arr[3]);
    sendControl({ position: arr });
  };

  return (
    <Routes>
      <Route path="/" element={
        <div className={`wrapper theme-${theme}`}>
          <div className="app-container">
            <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
              <select
                value={theme}
                onChange={e => setTheme(e.target.value as any)}
                style={{ marginBottom: 16, borderRadius: 6, padding: '4px 10px', fontFamily: 'inherit' }}
                aria-label="Выбор темы"
              >
                {themeOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="header">
              {/* Иконка лампы с цветом и свечением */}
              <span
                className="lamp-icon"

              >
                <LightBulbIcon style={{
                  color: `rgb(${r},${g},${b})`,
                  filter: `drop-shadow(0px 0px 4px rgba(${r}, ${g}, ${b}, ${brightness}%))`
                }} />
              </span>
              <div className="brightness-display">Яркость: {brightness}%</div>
              <button className="power-button" onClick={handlePower} style={{background: power ? '#4caf50' : '#888'}}>
                Power
              </button>
            </div>
            <div className="toggles">
              <label className="switch-container">
                <input
                  type="checkbox"
                  checked={autoBrightness}
                  onChange={handleAutoBrightness}
                />
                <span className="switch-slider"></span>
                <span className="switch-label">Авто-яркость</span>
              </label>
              <label className="switch-container">
                <input
                  type="checkbox"
                  checked={autoPosition}
                  onChange={handleAutoPosition}
                />
                <span className="switch-slider"></span>
                <span className="switch-label">Авто-позиция</span>
              </label>
            </div>
            <div className="sliders">
              <div className="slider-group">
                <span>R</span>
                <input
                  type="range"
                  min="0"
                  max="255"
                  value={r}
                  onChange={e => setR(Number(e.target.value))}
                  onMouseUp={e => handleR(Number((e.target as HTMLInputElement).value))}
                />
              </div>
              <div className="slider-group">
                <span>G</span>
                <input
                  type="range"
                  min="0"
                  max="255"
                  value={g}
                  onChange={e => setG(Number(e.target.value))}
                  onMouseUp={e => handleG(Number((e.target as HTMLInputElement).value))}
                />
              </div>
              <div className="slider-group">
                <span>B</span>
                <input
                  type="range"
                  min="0"
                  max="255"
                  value={b}
                  onChange={e => setB(Number(e.target.value))}
                  onMouseUp={e => handleB(Number((e.target as HTMLInputElement).value))}
                />
              </div>
              <div className="slider-group">
                <span>Яркость</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={brightness}
                  onChange={e => {
                    setBrightness(Number(e.target.value));
                  }}
                  onMouseUp={e => handleBrightness(Number((e.target as HTMLInputElement).value))}
                />
              </div>
              <div className="slider-group">
                <span>P0</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={p0}
                  onChange={e => setP0(Number(e.target.value))}
                  onMouseUp={e => handleP(0, Number((e.target as HTMLInputElement).value))}
                />
              </div>
              <div className="slider-group">
                <span>P1</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={p1}
                  onChange={e => setP1(Number(e.target.value))}
                  onMouseUp={e => handleP(1, Number((e.target as HTMLInputElement).value))}
                />
              </div>
              <div className="slider-group">
                <span>P2</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={p2}
                  onChange={e => setP2(Number(e.target.value))}
                  onMouseUp={e => handleP(2, Number((e.target as HTMLInputElement).value))}
                />
              </div>
              <div className="slider-group">
                <span>P3</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={p3}
                  onChange={e => setP3(Number(e.target.value))}
                  onMouseUp={e => handleP(3, Number((e.target as HTMLInputElement).value))}
                />
              </div>
            </div>
            <button className="help-button" onClick={() => setHelpOpen(true)}>Помощь</button>
            <button className="admin-link" onClick={() => window.location.href='/admin'}>Админ-панель</button>
            {helpOpen && (
              <div className="help-overlay" onClick={() => setHelpOpen(false)}>
                <div className="help-modal" onClick={(e) => e.stopPropagation()}>
                  <h2>Помощь</h2>
                  <p>Че зыришь? 😡</p>
                  <button onClick={() => setHelpOpen(false)}>Закрыть</button>
                </div>
              </div>
            )}
          </div>
        </div>
      } />
      {/* Передача темы и функции смены темы в AdminPanel */}
      <Route path="/admin" element={<AdminPanel theme={theme} setTheme={(t: string) => setTheme(t as any)} themeOptions={themeOptions} />} />
    </Routes>
  );
};

export default App;
```
```css
/* styles.css */
/* Глобальные стили для body и html */
body, html {
  margin: 0;
  padding: 0;
  height: 100%;
  font-family: 'Segoe UI', Tahoma, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* Центрирование главного контейнера и цвета по теме */
.wrapper {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background-color: var(--bg-color);
  color: var(--fg-color);
}

/* Стили для контейнера приложения с поддержкой frosted glass */
.app-container {
  position: relative;
  max-width: 400px;
  padding: 20px;
  background-color: var(--container-bg);
  border-radius: 16px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

/* Кнопка переключения темы */
.theme-toggle {
  position: absolute;
  top: 10px;
  left: 10px;
  width: 40px;
  height: 40px;
  padding: 0;
}

/* Хедер с иконкой лампы и яркостью */
.header {
  display: flex;
  align-items: center;
  margin-bottom: 20px;
}

/* Иконка лампы */
.lamp-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 60px;
  height: 60px;
  color: inherit;
  /* transition: color 0.3s, filter 0.3s; */
}

.lamp-icon svg {
  width: 60px;
  height: 60px;
  display: block;
  /* Свечение только по линиям лампы */
  /* filter:
    drop-shadow(0 0 8px currentColor)
    drop-shadow(0 0 16px currentColor)
    drop-shadow(0 0 24px currentColor); */
  /* transition: filter 0.3s; */
}

.power-button[style*='#4caf50'] ~ .lamp-icon, .lamp-icon[style*='brightness(100%)'] {
  animation: lampPulse 1.2s infinite cubic-bezier(.4,1.4,.6,1);
}
@keyframes lampPulse {
  0%, 100% { box-shadow: 0 0 15px var(--accent), 0 0 0px var(--accent); }
  50% { box-shadow: 0 0 30px var(--accent), 0 0 12px var(--accent); }
}

/* Отображение яркости */
.brightness-display {
  flex-grow: 1;
  text-align: center;
  font-size: 18px;
}

/* Кнопка питания */
.power-button {
  background-color: var(--accent);
  color: var(--fg-color);
  border: none;
  border-radius: 8px;
  padding: 10px 16px;
  font-size: 16px;
  cursor: pointer;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  transition: transform 0.18s cubic-bezier(.4,1.4,.6,1), filter 0.18s, box-shadow 0.18s;
}

.power-button:hover {
  transform: translateY(-2px);
  filter: brightness(1.1);
}

.power-button:active {
  transform: scale(0.96);
  filter: brightness(0.95);
  box-shadow: 0 2px 8px rgba(0,0,0,0.12);
}

/* Переключатели (тумблеры) */
.toggles {
  display: flex;
  justify-content: center;
  margin-bottom: 20px;
}

.switch-container {
  display: flex;
  align-items: center;
  margin: 0 15px;
}

.switch-slider {
  position: relative;
  width: 40px;
  height: 20px;
  background-color: #ccc;
  border-radius: 10px;
  margin-right: 8px;
  transition: background-color 0.3s, transform 0.3s;
}

.switch-slider::before {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background-color: white;
  border-radius: 50%;
  transition: background-color 0.3s, transform 0.3s;
}

.switch-container input {
  display: none;
}

.switch-container input:checked + .switch-slider {
  background-color: var(--accent);
}

.switch-container input:checked + .switch-slider::before {
  transform: translateX(20px);
}

.switch-label {
  font-size: 14px;
}

/* Слайдеры */
.sliders {
  display: flex;
  flex-direction: column;
}

.slider-group {
  display: flex;
  align-items: center;
  margin: 10px 0;
}

.slider-group span {
  width: 60px;
  font-size: 14px;
}

.slider-group input[type=range] {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  margin: 0 10px;
  transition: background 0.3s;
}

.slider-group input[type=range]:focus {
  outline: none;
}

.slider-group input[type=range]::-webkit-slider-runnable-track {
  width: 100%;
  height: 8px;
  background: var(--slider-track);
  border-radius: 4px;
}

.slider-group input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 24px;
  height: 24px;
  background: var(--accent);
  border: 2px solid var(--button-bg);
  border-radius: 50%;
  margin-top: -8px;
  transition: background 0.3s;
}

.slider-group input[type=range]::-moz-range-track {
  width: 100%;
  height: 8px;
  background: var(--slider-track);
  border-radius: 4px;
}

.slider-group input[type=range]::-moz-range-thumb {
  width: 24px;
  height: 24px;
  background: var(--accent);
  border: 2px solid var(--button-bg);
  border-radius: 50%;
  transition: background 0.3s;
}

/* Кнопка помощи */
.help-button {
  background-color: var(--accent);
  color: var(--fg-color);
  border: none;
  border-radius: 8px;
  padding: 10px;
  font-size: 16px;
  cursor: pointer;
  width: 100%;
  margin-top: 20px;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  transition: transform 0.18s cubic-bezier(.4,1.4,.6,1), filter 0.18s, box-shadow 0.18s;
}

.help-button:hover {
  transform: translateY(-2px);
  filter: brightness(1.1);
}

.help-button:active {
  transform: scale(0.96);
  filter: brightness(0.95);
  box-shadow: 0 2px 8px rgba(0,0,0,0.12);
}

/* Оверлей и модалка помощи */
.help-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(5px);
  display: flex;
  justify-content: center;
  align-items: center;
  animation: fadeInBg 0.3s cubic-bezier(.4,1.4,.6,1);
}

@keyframes fadeInBg {
  from { opacity: 0; }
  to { opacity: 1; }
}

.help-modal {
  background-color: var(--container-bg);
  padding: 20px;
  border-radius: 16px;
  width: 80%;
  max-width: 300px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  animation: fadeScaleIn 0.35s cubic-bezier(.4,1.4,.6,1) both;
}

@keyframes fadeScaleIn {
  0% { opacity: 0; transform: scale(0.92); }
  100% { opacity: 1; transform: scale(1); }
}

.help-modal h2 {
  margin-top: 0;
  text-align: center;
}

.help-modal button {
  background-color: var(--accent);
  color: var(--fg-color);
  border: none;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 14px;
  cursor: pointer;
  margin-top: 15px;
}
```

### Устройство (esp32s3)
```cpp
// main.cpp
#include "DeviceClient.h"
#include <FastLED.h>
#include <Arduino.h>

#define L_LED_PIN   5
#define L_LED_COUNT 32
#define R_LED_PIN   6
#define R_LED_COUNT 32
#define PHOTO_PIN   10

Network knownNets[] = {
    {"HUAWEI-FR71E3", "0123456789"}, {"aRolf", "Chilllll"}, {"SSID", "PASS"}};

DeviceClient lamp(knownNets, sizeof(knownNets) / sizeof(knownNets[0]),
                  "esp32-s3-device");

CRGB ledsL[L_LED_COUNT];
CRGB ledsR[R_LED_COUNT];

void setup() {
  Serial.begin(115200);
  Serial.println("Starting...");

  FastLED.addLeds<WS2812B, L_LED_PIN, GRB>(ledsL, L_LED_COUNT);
  FastLED.addLeds<WS2812B, R_LED_PIN, GRB>(ledsR, R_LED_COUNT);

  fill_solid(ledsL, L_LED_COUNT, CRGB::Black);
  fill_solid(ledsR, R_LED_COUNT, CRGB::Black);
  FastLED.setBrightness(0);

  pinMode(PHOTO_PIN, INPUT);

  lamp.onStateUpdated([](const State &s) {
    Serial.printf("State update:\n");
    Serial.printf("  id: %s\n", s.id.c_str());
    Serial.printf("  power: %s\n", s.power ? "ON" : "OFF");
    Serial.printf("  color: [%u, %u, %u]\n", s.color[0], s.color[1],
                  s.color[2]);
    Serial.printf("  brightness: %u\n", s.brightness);
    Serial.printf("  auto_brightness: %s\n", s.auto_brightness ? "ON" : "OFF");
  });

  lamp.begin("meowww.su", 80);
}

void loop() {
  lamp.loop();

  int photoValue = analogRead(PHOTO_PIN); // Read photoresistor
  State state = lamp.getState();

  uint8_t brightness;
  if (state.auto_brightness) {
    brightness = map(photoValue, 0, 4095, 255, 0);
  } else {
    brightness = state.brightness;
  }

  FastLED.setBrightness(brightness);

  if (state.power) {
    CRGB color = CRGB(state.color[0], state.color[1], state.color[2]);

    fill_solid(ledsL, L_LED_COUNT, color);
    fill_solid(ledsR, R_LED_COUNT, color);

    FastLED.show();
  } else {
    // Turn off LEDs
    FastLED.clear();
    FastLED.show();
  }

  delay(100);
}

// DeviceClient.cpp
#include "DeviceClient.h"
#include <esp_task_wdt.h>

DeviceClient::DeviceClient(const Network *nets, uint8_t count,
                           const String &deviceId)
    : networks(nets), netCount(count), wsConnected(false), lastReconnect(0),
      lastPing(0) {
  state.id = deviceId;
  state.power = false;
  state.color[0] = state.color[1] = state.color[2] = 0;
  state.brightness = 0;
  state.auto_brightness = false;
  for (int i = 0; i < 4; ++i)
    state.position[i] = 0;
  state.auto_position = false;
  state.distance = 0.0f;
}

void DeviceClient::begin(const char *host, uint16_t port) {
  wsHost = host;
  wsPort = port;

  esp_task_wdt_init(10, true);
  esp_task_wdt_add(nullptr);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);

  WiFi.onEvent([this](WiFiEvent_t ev, WiFiEventInfo_t) {
    if (ev == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
      Serial.println("[WiFi] Disconnected, reconnecting...");
      WiFi.reconnect();
    } else if (ev == ARDUINO_EVENT_WIFI_STA_CONNECTED) {
      Serial.println("[WiFi] Connected");
    }
  });

  connectWiFi();
  connectWS();
}

void DeviceClient::connectWiFi() {
  static unsigned long lastAttempt = 0;
  const unsigned long retryInterval = 5000;
  const unsigned long timeoutConnect = 10000;

  if (WiFi.status() == WL_CONNECTED)
    return;
  unsigned long now = millis();
  if (now - lastAttempt < retryInterval)
    return;
  lastAttempt = now;

  for (uint8_t i = 0; i < netCount; ++i) {
    Serial.printf("[WiFi] Try `%s`...\n", networks[i].ssid);
    WiFi.disconnect(true);
    delay(50);
    WiFi.begin(networks[i].ssid, networks[i].password);

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutConnect) {
      ws.poll();
      esp_task_wdt_reset();
      delay(50);
    }

    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("[WiFi] Connected to `%s`, IP=%s\n", networks[i].ssid,
                    WiFi.localIP().toString().c_str());
      return;
    }
    Serial.println("[WiFi] Failed, next");
  }
  Serial.println("[WiFi] All networks failed; will retry");
}

void DeviceClient::connectWS() {
  if (wsConnected)
    ws.close();

  String uri = String("ws://") + wsHost + ":" + wsPort + "/ws/device";

  ws.onEvent([this](WebsocketsEvent event, String) {
    if (event == WebsocketsEvent::ConnectionOpened) {
      Serial.println("[WS] Opened");
      // ArduinoJson 7: use JsonDocument
      JsonDocument doc;
      JsonObject root = doc.to<JsonObject>();
      root["type"] = "register";
      root["id"] = state.id;
      String out;
      serializeJson(doc, out);
      ws.send(out);
      wsConnected = true;
    } else if (event == WebsocketsEvent::ConnectionClosed) {
      Serial.println("[WS] Closed");
      wsConnected = false;
    } else if (event == WebsocketsEvent::GotPing) {
      Serial.println("[WS] GotPing");
    } else if (event == WebsocketsEvent::GotPong) {
      Serial.println("[WS] GotPong");
    }
  });

  ws.onMessage([this](WebsocketsMessage msg) {
    JsonDocument doc;
    auto err = deserializeJson(doc, msg.data());
    if (err) {
      Serial.println("[WS] JSON parse error");
      return;
    }
    if (doc["type"] == "control") {
      JsonObject s = doc["state"].as<JsonObject>();
      JsonVariantConst cmd = doc["command"];
      processControl(s, cmd);
      if (stateCb)
        stateCb(state);
      if (cmd.is<const char *>() && String((const char *)cmd) == "restart") {
        Serial.println("[CMD] Restarting now...");
        delay(100);
        ESP.restart();
      }
    }
  });

  ws.connect(uri);
  lastReconnect = millis();
}

void DeviceClient::loop() {
  esp_task_wdt_reset();

  connectWiFi();

  if (WiFi.status() == WL_CONNECTED) {
    if (!wsConnected && millis() - lastReconnect > 5000) {
      Serial.println("[Loop] WS reconnect");
      connectWS();
    }
    ws.poll();
    if (millis() - lastPing > 15000) {
      ws.ping();
      lastPing = millis();
    }
  }
}

void DeviceClient::processControl(const JsonObject &s, const JsonVariantConst) {
  state.power = s["power"];
  for (int i = 0; i < 3; ++i)
    state.color[i] = s["color"][i];
  state.brightness = s["brightness"];
  state.auto_brightness = s["auto_brightness"];
  for (int i = 0; i < 4; ++i)
    state.position[i] = s["position"][i];
  state.auto_position = s["auto_position"];
}

void DeviceClient::onStateUpdated(std::function<void(const State &)> cb) {
  stateCb = cb;
}

const State &DeviceClient::getState() const { return state; }

void DeviceClient::sendState() {
  JsonDocument doc;
  JsonObject root = doc.to<JsonObject>();
  root["type"] = "state";
  root["id"] = state.id;
  JsonObject s = root["state"].to<JsonObject>();
  s["power"] = state.power;
  JsonArray col = s["color"].to<JsonArray>();
  for (int i = 0; i < 3; ++i)
    col.add(state.color[i]);
  s["brightness"] = state.brightness;
  s["auto_brightness"] = state.auto_brightness;
  JsonArray pos = s["position"].to<JsonArray>();
  for (int i = 0; i < 4; ++i)
    pos.add(state.position[i]);
  s["auto_position"] = state.auto_position;
  s["distance"] = state.distance;
  String out;
  serializeJson(doc, out);
  ws.send(out);
}

void DeviceClient::setPower(bool on, bool sendNow) {
  state.power = on;
  if (sendNow)
    sendState();
}
void DeviceClient::setBrightness(uint8_t b, bool sendNow) {
  state.brightness = b;
  if (sendNow)
    sendState();
}
void DeviceClient::setColor(uint8_t r, uint8_t g, uint8_t b, bool sendNow) {
  state.color[0] = r;
  state.color[1] = g;
  state.color[2] = b;
  if (sendNow)
    sendState();
}
void DeviceClient::setAutoBrightness(bool en, bool sendNow) {
  state.auto_brightness = en;
  if (sendNow)
    sendState();
}
void DeviceClient::setPosition(const uint8_t posArr[4], bool sendNow) {
  for (int i = 0; i < 4; ++i)
    state.position[i] = posArr[i];
  if (sendNow)
    sendState();
}
void DeviceClient::setAutoPosition(bool en, bool sendNow) {
  state.auto_position = en;
  if (sendNow)
    sendState();
}
void DeviceClient::setDistance(float d, bool sendNow) {
  state.distance = d;
  if (sendNow)
    sendState();
}
```