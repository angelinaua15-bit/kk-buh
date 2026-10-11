import crypto from 'node:crypto';
import { config } from './config.js';
import { get, run } from './db.js';
import { audit } from './services/finance.js';

const MAX_AGE_SEC = 24 * 3600;

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

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
  if (!safeEqual(calc, hash)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SEC) return null;
  try {
    return JSON.parse(params.get('user'));
  } catch {
    return null;
  }
}

export function sessionToken(tgId, days = 30) {
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  const payload = `${Number(tgId)}.${exp}`;
  const sig = crypto.createHmac('sha256', config.botToken).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(token) {
  if (!token || !config.botToken) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  const expected = crypto.createHmac('sha256', config.botToken).update(`${id}.${exp}`).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  if (!Number(exp) || Number(exp) < Date.now() / 1000) return null;
  const tgId = Number(id);
  return tgId ? { id: tgId } : null;
}

/** Clean HTTPS URL only — Telegram Mini Apps often fail to open web_app links with query strings. */
export function appUrl(_tgId) {
  const base = (config.webAppUrl || '').replace(/\/$/, '');
  return base ? `${base}/` : '';
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
  if (!tg && header.startsWith('sess ')) {
    const s = verifySession(header.slice(5).trim());
    if (s) tg = { id: s.id, first_name: config.adminIds.includes(s.id) ? 'Ангеліна' : `User ${s.id}` };
  }
  if (!tg && config.devMode && req.get('x-dev-user')) {
    const id = Number(req.get('x-dev-user'));
    tg = { id, first_name: id === config.adminIds[0] ? 'Ангеліна' : `Dev ${id}`, username: `dev${id}` };
  }
  if (!tg) return res.status(401).json({ error: 'Відкрийте застосунок через Telegram-бота', needTelegram: true });
  const user = upsertTelegramUser(tg);
  if (user.status === 'blocked') return res.status(403).json({ error: 'Доступ заблоковано адміністратором', status: 'blocked' });
  if (user.status !== 'active') return res.status(403).json({ error: 'Заявку на доступ надіслано адміну. Очікуйте підтвердження.', status: 'pending', user });
  req.user = user;
  next();
}
