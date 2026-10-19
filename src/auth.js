import crypto from 'node:crypto';
import { config } from './config.js';
import { get, run, getSetting, setSetting } from './db.js';
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
const joinListeners = [];
/** Хтось зайшов за посиланням-запрошенням або при відкритому доступі. */
export const onJoin = (fn) => joinListeners.push(fn);

export const INVITE_ROLES = ['admin', 'finance', 'member', 'viewer'];

/** Код запрошення: t.me/<bot>?start=join_<code>. Створюється при першому зверненні. */
export function inviteCode() {
  let code = getSetting('invite_code');
  if (!code) {
    code = crypto.randomBytes(6).toString('hex');
    setSetting('invite_code', code);
  }
  return code;
}
export function resetInviteCode() {
  const code = crypto.randomBytes(6).toString('hex');
  setSetting('invite_code', code);
  return code;
}
export const inviteRole = () => (INVITE_ROLES.includes(getSetting('invite_role')) ? getSetting('invite_role') : 'admin');
export function inviteLink() {
  const bot = getSetting('bot_username') || 'KKLabSystemBot';
  return `https://t.me/${bot}?start=join_${inviteCode()}`;
}
/** Відкритий доступ: кожен, хто натиснув /start, одразу отримує роль open_role (за замовчуванням — адмін). */
export const openAccess = () => getSetting('open_access') === '1';
export const openRole = () => (INVITE_ROLES.includes(getSetting('open_role')) ? getSetting('open_role') : 'admin');
const validInvite = (code) => Boolean(code) && code === getSetting('invite_code');

/** Finds or registers a Telegram user. Users from ADMIN_IDS become active admins automatically. */
export function upsertTelegramUser(tg, opts = {}) {
  const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ') || tg.username || `ID ${tg.id}`;
  const isAdmin = config.adminIds.includes(Number(tg.id)) || (config.devMode && !config.adminIds.length);
  const invited = validInvite(opts.invite);
  let user = get('SELECT * FROM users WHERE tg_id = ?', tg.id);
  if (!user) {
    const auto = invited ? inviteRole() : openAccess() ? openRole() : null;
    const r = run(
      'INSERT INTO users(tg_id, name, username, role, status) VALUES(?,?,?,?,?)',
      tg.id,
      name,
      tg.username || null,
      isAdmin ? 'admin' : auto || 'member',
      isAdmin || auto ? 'active' : 'pending',
    );
    user = get('SELECT * FROM users WHERE id = ?', r.lastInsertRowid);
    audit(user.id, 'register', 'user', user.id, { tg_id: tg.id, username: tg.username, via: invited ? 'invite' : auto ? 'open' : 'request' });
    if (!isAdmin && !auto) for (const fn of listeners) Promise.resolve(fn(user)).catch(() => {});
    if (!isAdmin && auto) for (const fn of joinListeners) Promise.resolve(fn(user, invited ? 'invite' : 'open')).catch(() => {});
  } else {
    if (isAdmin && (user.role !== 'admin' || user.status !== 'active')) {
      run("UPDATE users SET role='admin', status='active' WHERE id=?", user.id);
    } else if (invited && user.status !== 'blocked' && (user.status !== 'active' || INVITE_ROLES.indexOf(inviteRole()) < INVITE_ROLES.indexOf(user.role))) {
      // запрошення підвищує роль (або активує заявку), але не знімає блокування
      run("UPDATE users SET role=?, status='active' WHERE id=?", inviteRole(), user.id);
      audit(user.id, 'invite', 'user', user.id, { role: inviteRole() });
      const fresh = get('SELECT * FROM users WHERE id = ?', user.id);
      for (const fn of joinListeners) Promise.resolve(fn(fresh, 'invite')).catch(() => {});
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
  const sessRaw = header.startsWith('sess ') ? header.slice(5).trim() : (req.get('x-kk-session') || '').trim();
  if (!tg && sessRaw) {
    const s = verifySession(sessRaw);
    if (s) {
      const known = get('SELECT name, username FROM users WHERE tg_id = ?', s.id);
      tg = { id: s.id, first_name: known?.name || (config.adminIds.includes(s.id) ? 'Ангеліна' : `User ${s.id}`), username: known?.username || undefined };
    }
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
