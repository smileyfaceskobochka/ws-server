import React, { useState, useEffect, useRef } from 'react';
import { Routes, Route } from 'react-router-dom';
import './styles.css';
import './themes.css';
import LightBulbIcon from './assets/heroicons-light-bulb.svg?react';

const DEVICE_ID = "esp32-s3-device";

type FullState = {
  power: boolean;
  brightness: number;
  color: [number, number, number];
  auto_brightness: boolean;
  position: [number, number, number];
};

const App: React.FC = () => {
  const themeOptions = [
    { value: 'mocha', label: 'Catppuccin Mocha' },
    { value: 'latte', label: 'Catppuccin Latte' },
    { value: 'frosted-dark', label: 'Frosted Glass Dark' },
    { value: 'frosted-light', label: 'Frosted Glass Light' },
  ];
  const [theme, setTheme] = useState<'mocha'|'latte'|'frosted-dark'|'frosted-light'>('mocha');
  const [power, setPower] = useState<boolean>(false);
  const [brightness, setBrightness] = useState<number>(50);
  const [r, setR] = useState<number>(255);
  const [g, setG] = useState<number>(255);
  const [b, setB] = useState<number>(255);
  const [autoBrightness, setAutoBrightness] = useState<boolean>(false);

  // для полей ввода шагов
  const [stepInputs, setStepInputs] = useState<number[]>([0, 0, 0]);
  const [helpOpen, setHelpOpen] = useState<boolean>(false);

  // ws
  const wsRef = useRef<WebSocket|null>(null);

  // единый объект, который шлём в control
  const ctrlRef = useRef<FullState>({
    power: false,
    brightness: 50,
    color: [255, 255, 255],
    auto_brightness: false,
    position: [0, 0, 0],
  });

  // подключение WS
  useEffect(() => {
    const ws = new WebSocket("ws://meowww.su:80/ws/client");
    wsRef.current = ws;
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.type === "state" && msg.id === DEVICE_ID && msg.state) {
        const s = msg.state;
        // подтягиваем в UI
        setPower(!!s.power);
        setBrightness(Number(s.brightness));
        setR(s.color[0] ?? 0);
        setG(s.color[1] ?? 0);
        setB(s.color[2] ?? 0);
        setAutoBrightness(!!s.auto_brightness);
        ctrlRef.current = {
          power: !!s.power,
          brightness: Number(s.brightness),
          color: [s.color[0], s.color[1], s.color[2]],
          auto_brightness: !!s.auto_brightness,
          position: [0, 0, 0],
        };
        setStepInputs([0, 0, 0]);
      }
    };
    return () => { ws.close(); };
  }, []);

  const sendControlFull = () => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "control",
        id: DEVICE_ID,
        state: ctrlRef.current
      }));
    }
  };

  // переключение power
  const togglePower = () => {
    const next = !power;
    setPower(next);
    // фиксируем в ctrlRef
    ctrlRef.current.power = next;
    ctrlRef.current.position = [0, 0, 0];
    sendControlFull();
  };

  // изменение яркости
  const changeBrightness = (v: number) => {
    setBrightness(v);
    ctrlRef.current.brightness = v;
    sendControlFull();
  };

  // изменение цвета
  const changeColor = (idx: 0|1|2, v: number) => {
    const col = [...ctrlRef.current.color] as [number, number, number];
    col[idx] = v;
    setR(col[0]); setG(col[1]); setB(col[2]);
    ctrlRef.current.color = col;
    sendControlFull();
  };

  // авто-яркость
  const toggleAutoBr = () => {
    const next = !autoBrightness;
    setAutoBrightness(next);
    ctrlRef.current.auto_brightness = next;
    sendControlFull();
  };

  // относительный шаг мотора
  const handleStep = (motor: number, delta: number) => {
    const pos: [number, number, number] = [0, 0, 0];
    pos[motor] = delta;
    ctrlRef.current.position = pos;
    sendControlFull();
    setStepInputs([0, 0, 0]);
  };

  return (
    <Routes>
      <Route path="/" element={
        <div className={`wrapper theme-${theme}`}>
          <div className="app-container">

            <div style={{display:'flex', justifyContent:'flex-end'}}>
              <select value={theme} onChange={e=>setTheme(e.target.value as any)}>
                {themeOptions.map(o=>(
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div className="header">
              <LightBulbIcon
                style={{
                  width:'40px',
                  height:'40px',
                  color:`rgb(${r},${g},${b})`,
                  filter:`drop-shadow(0 0 4px rgba(${r},${g},${b},${brightness}%))`
                }}
              />
              <button
                onClick={togglePower}
                style={{background: power ? '#4caf50' : '#888'}}
              >
                Power
              </button>
            </div>

            <div className="toggles">
              <label>
                <input
                  type="checkbox"
                  checked={autoBrightness}
                  onChange={toggleAutoBr}
                /> Авто-яркость
              </label>
            </div>

            <div className="sliders">
              <div>
                R <input type="range" min={0} max={255} value={r}
                         onChange={e=>changeColor(0, +e.target.value)}/>
              </div>
              <div>
                G <input type="range" min={0} max={255} value={g}
                         onChange={e=>changeColor(1, +e.target.value)}/>
              </div>
              <div>
                B <input type="range" min={0} max={255} value={b}
                         onChange={e=>changeColor(2, +e.target.value)}/>
              </div>
              <div>
                Яркость <input type="range" min={0} max={100} value={brightness}
                                onChange={e=>changeBrightness(+e.target.value)}/>
              </div>
            </div>

            <div className="motors-control">
              {[0,1,2].map(idx => (
                <div key={idx} className="motor-row">
                  <span>Motor {idx+1}</span>
                  <button onClick={()=>handleStep(idx, -stepInputs[idx])}>–</button>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    value={stepInputs[idx]}
                    onChange={e=>{
                      const v = Math.max(0, +e.target.value);
                      const arr = [...stepInputs];
                      arr[idx] = v;
                      setStepInputs(arr);
                    }}
                  />
                  <button onClick={()=>handleStep(idx, +stepInputs[idx])}>+</button>
                </div>
              ))}
            </div>

            <button className="wagwpigwpj" onClick={()=>setHelpOpen(true)}>
              Помощь
            </button>

            {helpOpen && (
              <div className="help-overlay" onClick={()=>setHelpOpen(false)}>
                <div className="help-modal" onClick={e=>e.stopPropagation()}>
                  <h2>Помощь</h2>
                  <p>«–»/«+» + поле ввода задают относительный шаг.  
                     Изменения яркости, цвета и power обнуляют предыдущие шаги.</p>
                  <button onClick={()=>setHelpOpen(false)}>Закрыть</button>
                </div>
              </div>
            )}

          </div>
        </div>
      }/>
    </Routes>
  );
};

export default App;
