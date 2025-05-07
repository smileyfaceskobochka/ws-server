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
    const ws = new WebSocket("ws://localhost:80/ws/client");
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
                style={{
                  color: `rgb(${r},${g},${b})`,
                  filter: `brightness(${brightness}%)`,
                  boxShadow: `0 0 24px 6px rgba(${r},${g},${b},0.7)`
                }}
              >
                <LightBulbIcon />
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
                  onChange={e => setBrightness(Number(e.target.value))}
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
                  <p>Информация о приложении умной лампы...</p>
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
