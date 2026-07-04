import { useEffect, useState } from 'react';
import { Board } from './components/Board';
import { AuthError, fetchTasks, setBoardKey } from './api';
import { resetSocket } from './socket';

interface Member {
  id: string;
  name: string;
}

const STORAGE_KEY = 'ltm_member';

// Load or create the current member identity stored in localStorage
function loadMember(): Member {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) return JSON.parse(raw);
  const fresh = { id: `m_${Math.random().toString(36).slice(2, 9)}`, name: '' };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
  return fresh;
}

type AuthState = 'checking' | 'need_key' | 'ok';

export default function App() {
  const [member, setMember] = useState<Member>(loadMember);
  const [auth, setAuth] = useState<AuthState>('checking');
  const [keyInput, setKeyInput] = useState('');
  const [keyError, setKeyError] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(member));
  }, [member]);

  // Check whether the board requires a key and whether the stored key is still valid
  useEffect(() => {
    fetchTasks()
      .then(() => setAuth('ok'))
      .catch((e) => setAuth(e instanceof AuthError ? 'need_key' : 'ok'));
  }, []);

  async function submitKey(e: React.FormEvent) {
    e.preventDefault();
    setBoardKey(keyInput.trim());
    try {
      await fetchTasks();
      resetSocket(); // reconnect WebSocket with the new key
      setKeyError(false);
      setAuth('ok');
    } catch {
      setKeyError(true);
    }
  }

  if (auth === 'checking') {
    return <p className="app__hint">กำลังเชื่อมต่อ…</p>;
  }

  if (auth === 'need_key') {
    return (
      <div className="app">
        <header className="app__head">
          <h1 className="app__title">Line Task Manager</h1>
        </header>
        <form className="app__login" onSubmit={submitKey}>
          <label htmlFor="board-key">บอร์ดนี้ถูกล็อก ใส่รหัสผ่านเพื่อเข้าใช้งาน</label>
          <input
            id="board-key"
            className="app__me-input"
            type="password"
            value={keyInput}
            placeholder="รหัสผ่านบอร์ด"
            onChange={(e) => setKeyInput(e.target.value)}
            autoFocus
          />
          <button className="card__take" type="submit">เข้าบอร์ด</button>
          {keyError && <p className="board__error">รหัสไม่ถูกต้อง</p>}
        </form>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app__head">
        <div>
          <h1 className="app__title">Line Task Manager</h1>
          <p className="app__sub">Bot ดึงงานจาก LINE → ลากการ์ดผ่าน Todo · In Process · Test · Done</p>
        </div>
        <label className="app__me">
          ฉันคือ
          <input
            className="app__me-input"
            value={member.name}
            placeholder="พิมพ์ชื่อ"
            onChange={(e) => setMember({ ...member, name: e.target.value })}
          />
        </label>
      </header>

      {member.name.trim() ? (
        <Board currentMember={member} />
      ) : (
        <p className="app__hint">ใส่ชื่อด้านบนก่อน แล้วถึงจะกดรับงานได้</p>
      )}
    </div>
  );
}
