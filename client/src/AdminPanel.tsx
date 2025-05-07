import React, { useState, useEffect, useRef } from 'react';
import './adminpanel.css';

interface AdminPanelProps {
  theme: string;
  setTheme: (t: string) => void;
  themeOptions: { value: string; label: string }[];
}

const SECRET = 'admin'; // можно поменять

const AdminPanel: React.FC<AdminPanelProps> = ({ theme, setTheme, themeOptions }) => {
  const [entered, setEntered] = useState(false);
  const [input, setInput] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!entered) return;
    const ws = new WebSocket('ws://localhost:8080/ws/client');
    wsRef.current = ws;
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'log' && msg.message) {
          setLogs((prev) => [...prev.slice(-199), msg.message]);
        }
      } catch {}
    };
    return () => { ws.close(); };
  }, [entered]);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (input === SECRET) setEntered(true);
    else alert('Неверное секретное слово!');
  };

  if (!entered) {
    return (
      <div className={`admin-login-bg theme-${theme}`}>
        <form className="admin-login-form" onSubmit={handleLogin}>
          <div className="admin-title">Admin Access</div>
          <input
            type="password"
            placeholder="Секретное слово"
            value={input}
            onChange={e => setInput(e.target.value)}
            className="admin-input"
          />
          <button type="submit" className="admin-btn">Войти</button>
          <select
            value={theme}
            onChange={e => setTheme(e.target.value)}
            style={{ marginTop: 16, borderRadius: 6, padding: '4px 10px', fontFamily: 'inherit' }}
            aria-label="Выбор темы"
          >
            {themeOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </form>
      </div>
    );
  }

  return (
    <div className={`admin-terminal-bg theme-${theme}`}>
      <div className="admin-terminal">
        <div className="admin-terminal-header">
          RETRO TERMINAL LOGS
          <select
            value={theme}
            onChange={e => setTheme(e.target.value)}
            style={{ float: 'right', borderRadius: 6, padding: '2px 8px', fontFamily: 'inherit', fontSize: '1rem', background: 'var(--container-bg)', color: 'var(--fg-color)', border: 'var(--glass-border)' }}
            aria-label="Выбор темы"
          >
            {themeOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="admin-terminal-body">
          {logs.map((line, i) => (
            <div key={i} className="admin-terminal-line">{line}</div>
          ))}
          <div className="admin-terminal-cursor">█</div>
        </div>
      </div>
    </div>
  );
};

export default AdminPanel;
