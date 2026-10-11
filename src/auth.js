import crypto from 'node:crypto';
import { config } from './config.js';
import { get, run } from './db.js';
import { audit } from './services/finance.js';

const MAX_AGE_SEC = 24 * 3600;

export function verifyInitData(initData) {
  if (!initData || !config.botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SEC) return null;
  try {
    return JSON.parse(params.get('user'));
  } catch {
    return null;
  }
}

const listeners = [];
export const onNewUser = (fn) => listeners.push(fn);

/** Finds or registers a Telegram user. Users from ADMIN_IDS become active admins automatically. */
export function upsertTelegramUser(tg) {
  const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ') || tg.username || `ID ${tg.id}`;
  const isAdmin = config.adminIds.includes(Number(tg.id)) || (config.devMode && !config.adminIds.length);
  let user = get('SELECT * FROM users WHERE tg_id = ?', tg.id);
  if (!user) {
    const r = run(
      'INSERT INTO users(tg_id, name, username, role, status) VALUES(?,?,?,?,?)',
      tg.id,
      name,
      tg.username || null,
      isAdmin ? 'admin' : 'member',
      isAdmin ? 'active' : 'pending',
    );
    user = get('SELECT * FROM users WHERE id = ?', r.lastInsertRowid);
    audit(user.id, 'register', 'user', user.id, { tg_id: tg.id, username: tg.username });
    if (!isAdmin) for (const fn of listeners) Promise.resolve(fn(user)).catch(() => {});
  } else {
    if (isAdmin && (user.role !== 'admin' || user.status !== 'active')) {
      run("UPDATE users SET role='admin', status='active' WHERE id=?", user.id);
    }
    run("UPDATE users SET username = ?, last_seen = datetime('now') WHERE id = ?", tg.username || user.username, user.id);
    user = get('SELECT * FROM users WHERE id = ?', user.id);
  }
  return user;
}

export function authMiddleware(req, res, next) {
  const header = req.get('authorization') || '';
  let tg = null;
  if (header.startsWith('tma ')) tg = verifyInitData(header.slice(4));
  if (!tg && config.devMode && req.get('x-dev-user')) {
    const id = Number(req.get('x-dev-user'));
    tg = { id, first_name: id === config.adminIds[0] ? 'Admin' : `Dev ${id}`, username: `dev${id}` };
  }
  if (!tg) return res.status(401).json({ error: 'Відкрийте застосунок через Telegram-бота' });
  const user = upsertTelegramUser(tg);
  if (user.status === 'blocked') return res.status(403).json({ error: 'Доступ заблоковано адміністратором', status: 'blocked' });
  if (user.status !== 'active') return res.status(403).json({ error: 'Заявку на доступ надіслано адміну. Очікуйте підтвердження.', status: 'pending', user });
  req.user = user;
  next();
}
