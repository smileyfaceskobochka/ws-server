import React, { useState, useEffect, useRef } from 'react';
import { Routes, Route } from 'react-router-dom';
import AdminPanel from './AdminPanel';
import './styles.css';
import './themes.css';
import LightBulbIcon from './assets/heroicons-light-bulb.svg?react';

const DEVICE_ID = 'esp32-s3-device';

const App: React.FC = () => {
  const themeOptions = [
    { value: 'mocha', label: 'Catppuccin Mocha' },
    { value: 'latte', label: 'Catppuccin Latte' },
    { value: 'frosted-dark', label: 'Frosted Glass Dark' },
    { value: 'frosted-light', label: 'Frosted Glass Light' },
  ];

  const [theme, setTheme] = useState<'mocha' | 'latte' | 'frosted-dark' | 'frosted-light'>('mocha');
  const [power, setPower] = useState(false);
  const [brightness, setBrightness] = useState(50);
  const [r, setR] = useState(255);
  const [g, setG] = useState(255);
  const [b, setB] = useState(255);
  const [autoBrightness, setAutoBrightness] = useState(false);
  const [autoPosition, setAutoPosition] = useState(false);
  const [p0, setP0] = useState(0);
  const [p1, setP1] = useState(0);
  const [p2, setP2] = useState(0);
  const [p3, setP3] = useState(0);
  const [distance, setDistance] = useState<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket('ws://meowww.su/ws/client');
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[WS] connection opened');
      // Optional: request state
      // ws.send(JSON.stringify({ type: 'get_state', id: DEVICE_ID }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'state' && msg.id === DEVICE_ID && msg.state) {
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
          if (typeof msg.state.distance === 'number') {
            setDistance(msg.state.distance);
            console.log('Distance:', msg.state.distance, 'cm');
          }
        }
      } catch (err) {
        console.error('Failed to parse WS message', err);
      }
    };

    ws.onerror = (err) => console.error('[WS] error', err);
    ws.onclose = (e) => console.warn(`[WS] closed, code=${e.code}`);

    return () => {
      ws.close();
    };
  }, []);

  const sendControl = (nextState?: Partial<any>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const state = {
        power,
        color: [r, g, b],
        brightness,
        auto_brightness: autoBrightness,
        position: [p0, p1, p2, p3],
        auto_position: autoPosition,
        ...nextState,
      };
      ws.send(JSON.stringify({ type: 'control', id: DEVICE_ID, state }));
    }
  };

  const handlePower = () => {
    setPower(prev => {
      sendControl({ power: !prev });
      return !prev;
    });
  };

  const handleBrightness = (v: number) => {
    setBrightness(v);
    sendControl({ brightness: v });
  };

  const handleColor = (idx: number, v: number) => {
    const vals = [r, g, b];
    vals[idx] = v;
    setR(vals[0]); setG(vals[1]); setB(vals[2]);
    sendControl({ color: vals });
  };

  const handleAutoBrightness = () => {
    setAutoBrightness(prev => {
      sendControl({ auto_brightness: !prev });
      return !prev;
    });
  };

  const handleAutoPosition = () => {
    setAutoPosition(prev => {
      sendControl({ auto_position: !prev });
      return !prev;
    });
  };

  const handleP = (idx: number, v: number) => {
    const vals = [p0, p1, p2, p3];
    vals[idx] = v;
    setP0(vals[0]); setP1(vals[1]); setP2(vals[2]); setP3(vals[3]);
    sendControl({ position: vals });
  };

  return (
    <Routes>
      <Route path="/" element={
        <div className={`wrapper theme-${theme}`}>
          <div className="app-container">
            <div className="flex justify-end w-full mb-4">
              <select
                value={theme}
                onChange={e => setTheme(e.target.value as any)}
                className="border rounded p-2 font-inherit"
                aria-label="Выбор темы"
              >
                {themeOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="header flex items-center space-x-4">
              <span className="lamp-icon">
                <LightBulbIcon
                  style={{
                    color: `rgb(${r},${g},${b})`,
                    filter: `drop-shadow(0 0 4px rgba(${r},${g},${b},${brightness / 100}))`,
                  }}
                />
              </span>
              <div className="brightness-display">
                Яркость: {brightness}%
                {distance !== null && (
                  <span className="ml-4">Расстояние: {distance.toFixed(1)} см</span>
                )}
              </div>
              <button
                onClick={handlePower}
                className={`px-4 py-2 rounded ${power ? 'bg-green-500' : 'bg-gray-500'}`}
              >
                Power
              </button>
            </div>

            <div className="toggles mt-4 grid grid-cols-2 gap-4">
              <label className="switch-container">
                <input
                  type="checkbox"
                  checked={autoBrightness}
                  onChange={handleAutoBrightness}
                />
                <span className="switch-slider" />
                <span className="switch-label">Авто-яркость</span>
              </label>
              <label className="switch-container">
                <input
                  type="checkbox"
                  checked={autoPosition}
                  onChange={handleAutoPosition}
                />
                <span className="switch-slider" />
                <span className="switch-label">Авто-позиция</span>
              </label>
            </div>

            <div className="sliders mt-6 space-y-4">
              {[{ label: 'R', val: r }, { label: 'G', val: g }, { label: 'B', val: b }].map((c, i) => (
                <div className="slider-group flex items-center space-x-2" key={i}>
                  <span>{c.label}</span>
                  <input
                    type="range"
                    min={0}
                    max={255}
                    value={c.val}
                    onChange={e => {
                      const v = Number(e.target.value);
                      if (i === 0) setR(v);
                      if (i === 1) setG(v);
                      if (i === 2) setB(v);
                    }}
                    onMouseUp={e => handleColor(i, Number((e.target as HTMLInputElement).value))}
                    className="flex-1"
                  />
                </div>
              ))}
              {[{ label: 'Яркость', val: brightness, max: 100, onSet: handleBrightness }].map((s, i) => (
                <div className="slider-group flex items-center space-x-2" key={i}>
                  <span>{s.label}</span>
                  <input
                    type="range"
                    min={0}
                    max={s.max}
                    value={s.val}
                    onChange={e => s.onSet(Number(e.target.value))}
                    className="flex-1"
                  />
                </div>
              ))}
              {Array.from({ length: 4 }, (_, i) => (
                <div className="slider-group flex items-center space-x-2" key={i}>
                  <span>P{i}</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={[p0, p1, p2, p3][i]}
                    onChange={e => setP0(e.target.value as any)}
                    onMouseUp={e => handleP(i, Number((e.target as HTMLInputElement).value))}
                    className="flex-1"
                  />
                </div>
              ))}
            </div>

            <div className="mt-6 flex space-x-4">
              <button onClick={() => setHelpOpen(true)} className="help-button px-4 py-2 border rounded">
                Помощь
              </button>
              <button onClick={() => window.location.href = '/admin'} className="admin-link px-4 py-2 border rounded">
                Админ-панель
              </button>
            </div>

            {helpOpen && (
              <div className="help-overlay fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center" onClick={() => setHelpOpen(false)}>
                <div className="help-modal bg-white p-6 rounded-lg" onClick={e => e.stopPropagation()}>
                  <h2 className="text-xl font-bold mb-4">Помощь</h2>
                  <p className="mb-4">Че зыришь? 😡</p>
                  <button onClick={() => setHelpOpen(false)} className="px-4 py-2 bg-blue-500 text-white rounded">
                    Закрыть
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      } />

      <Route path="/admin" element={
        <AdminPanel
          theme={theme}
          setTheme={t => setTheme(t as any)}
          themeOptions={themeOptions}
        />
      } />
    </Routes>
  );
};

export default App;
