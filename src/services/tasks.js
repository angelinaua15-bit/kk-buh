/**
 * Задачі та сторінки «як у Notion»: кожна задача — це сторінка з властивостями
 * (статус, відповідальний, дедлайн, пріоритет, проєкт, теги) і блоковим вмістом.
 * Звичайні сторінки (kind='page') — нотатки/документи, можуть бути вкладеними.
 */
import { all, db, get, run, tx } from '../db.js';
import { HttpError, audit, today } from './finance.js';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db.js';

{ const cols = all('PRAGMA table_info(users)').map((c) => c.name); if (!cols.includes('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT'); }
db.exec(`
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','page')),
  title TEXT NOT NULL DEFAULT '',
  icon TEXT,
  cover TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT,
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  due TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  blocks TEXT NOT NULL DEFAULT '[]',
  sort REAL NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS pages_kind ON pages(kind, deleted_at);
CREATE INDEX IF NOT EXISTS pages_parent ON pages(parent_id);
CREATE INDEX IF NOT EXISTS pages_assignee ON pages(assignee_id);
CREATE INDEX IF NOT EXISTS pages_project ON pages(project_id);

CREATE TABLE IF NOT EXISTS page_comments (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS page_comments_page ON page_comments(page_id);
`);

export const STATUSES = [
  { id: 'todo', name: 'Не почато', color: 'gray' },
  { id: 'doing', name: 'В роботі', color: 'blue' },
  { id: 'review', name: 'На перевірці', color: 'amber' },
  { id: 'done', name: 'Готово', color: 'green' },
];
export const PRIORITIES = [
  { id: 'low', name: 'Низький', color: 'gray' },
  { id: 'mid', name: 'Середній', color: 'blue' },
  { id: 'high', name: 'Високий', color: 'amber' },
  { id: 'urgent', name: 'Терміново', color: 'red' },
];
const STATUS_IDS = STATUSES.map((s) => s.id);
const PRIORITY_IDS = PRIORITIES.map((p) => p.id);
export const BLOCK_TYPES = ['p', 'h1', 'h2', 'h3', 'todo', 'bullet', 'number', 'quote', 'callout', 'divider', 'code', 'toggle', 'page'];
/**
 * Відповідальним можна призначити будь-кого з команди або контактів (крім заблокованих).
 * Контакт (status='contact') — людина, яку додали з Telegram / телефонної книги; доступу до бухгалтерії не має.
 */
// відповідальні — лише ті, хто є в боті (має Telegram) і має підтверджений доступ
const ASSIGNABLE_SQL = "tg_id IS NOT NULL AND status = 'active'";
export const assignable = () => all(`SELECT id, name, username, phone, role, status, tg_id IS NOT NULL AS has_tg,
    (tg_id IS NOT NULL AND status != 'contact') AS in_bot,
    (SELECT COUNT(*) FROM pages p WHERE p.assignee_id = users.id AND p.deleted_at IS NULL) AS tasks
  FROM users WHERE ${ASSIGNABLE_SQL} ORDER BY status = 'active' DESC, tasks DESC, name`);
export const canBeAssignee = (id) => Boolean(id && get(`SELECT id FROM users WHERE id = ? AND ${ASSIGNABLE_SQL}`, Number(id)));

/** Новий контакт: «@nick», «+380…» або просто імʼя. Повертає наявного, якщо вже є. */
export function addPerson({ name, username, phone, tg_id } = {}, actor = null) {
  let n = String(name || '').trim().slice(0, 80);
  let u = String(username || '').trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
  let ph = String(phone || '').replace(/[^\d+]/g, '');
  const m = n.match(/^(?:@|https?:\/\/t\.me\/)([\w\d_]{3,32})$/i);
  if (m && !u) { u = m[1]; n = ''; }
  if (!ph && /^\+?[\d\s()-]{9,}$/.test(n)) { ph = n.replace(/[^\d+]/g, ''); n = ''; }
  if (u && !/^[\w\d_]{3,32}$/.test(u)) throw bad('Невірний нік у Telegram');
  if (ph && ph.replace(/\D/g, '').length < 9) throw bad('Невірний номер телефону');
  if (ph && !ph.startsWith('+')) ph = ph.startsWith('380') ? `+${ph}` : ph.startsWith('0') ? `+38${ph}` : `+${ph}`;
  if (!n && !u && !ph && !tg_id) throw bad('Вкажи імʼя, @нік або телефон');
  const found = (tg_id && get('SELECT * FROM users WHERE tg_id = ?', Number(tg_id)))
    || (u && get('SELECT * FROM users WHERE lower(username) = lower(?)', u))
    || (ph && get('SELECT * FROM users WHERE phone = ?', ph));
  if (found) {
    if (ph && !found.phone) run('UPDATE users SET phone = ? WHERE id = ?', ph, found.id);
    if (found.status === 'blocked') throw bad(`${found.name} заблокований(а) — розблокуй у «Доступах»`);
    return { ...get('SELECT * FROM users WHERE id = ?', found.id), existed: true };
  }
  const r = run("INSERT INTO users(tg_id, name, username, phone, role, status, notify) VALUES(?,?,?,?, 'member', 'contact', 1)",
    tg_id ? Number(tg_id) : null, n || (u ? `@${u}` : ph), u || null, ph || null);
  audit(actor?.id, 'create', 'contact', Number(r.lastInsertRowid), { name: n, username: u, phone: ph });
  return get('SELECT * FROM users WHERE id = ?', r.lastInsertRowid);
}
export const COVERS = ['violet', 'blue', 'pink', 'green', 'amber', 'night', 'sunset'];

const bad = (m) => new HttpError(400, m);
export const statusName = (id) => STATUSES.find((s) => s.id === id)?.name || id;
export const priorityName = (id) => PRIORITIES.find((p) => p.id === id)?.name || '';

/* ───────── санітизація вмісту ───────── */
const SAFE_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'code', 'a', 'br', 'mark']);
function safeHref(h) {
  const v = String(h || '').trim().replace(/&amp;/g, '&');
  return /^(https?:|mailto:|tg:)/i.test(v) ? v.replace(/"/g, '%22') : '';
}
/** Лишає тільки базове форматування (жирний, курсив, код, посилання). */
export function cleanHtml(s, max = 20000) {
  let out = String(s ?? '').slice(0, max);
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<(script|style|iframe|object|embed|svg|math|template)[\s\S]*?<\/\1\s*>/gi, '');
  out = out.replace(/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi, (_m, close, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!SAFE_TAGS.has(t)) return '';
    if (close) return `</${t}>`;
    if (t === 'a') {
      const m = attrs.match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const href = safeHref(m ? m[2] ?? m[3] ?? m[4] : '');
      return href ? `<a href="${href}" target="_blank" rel="noopener">` : '<a>';
    }
    return t === 'br' ? '<br>' : `<${t}>`;
  });
  // усе, що не є нашим безпечним тегом, — екрануємо
  const parts = out.split(SAFE_OUT);
  const tags = out.match(SAFE_OUT) || [];
  return parts.map((s, i) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;') + (tags[i] || '')).join('');
}
const SAFE_OUT = /<\/?(?:b|strong|i|em|u|s|strike|code|mark)>|<br>|<a href="[^"<>]*" target="_blank" rel="noopener">|<a>|<\/a>/g;
const plain = (html) => String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

let blockSeq = 0;
const newBlockId = () => `b${Date.now().toString(36)}${(blockSeq++).toString(36)}`;

function cleanBlocks(list, depth = 0) {
  if (!Array.isArray(list)) throw bad('Невірний вміст сторінки');
  if (list.length > 2000) throw bad('Забагато блоків на одній сторінці');
  return list.map((b) => {
    const type = BLOCK_TYPES.includes(b?.type) ? b.type : 'p';
    const out = { id: /^[\w-]{1,40}$/.test(b?.id || '') ? b.id : newBlockId(), type };
    if (type !== 'divider' && type !== 'page') out.text = cleanHtml(b.text);
    if (type === 'todo') out.checked = Boolean(b.checked);
    if (type === 'callout') out.icon = typeof b.icon === 'string' ? [...b.icon].slice(0, 2).join('') : '💡';
    if (type === 'toggle') {
      out.open = Boolean(b.open);
      out.body = cleanHtml(b.body);
    }
    if (type === 'page') out.page_id = Number(b.page_id) || null;
    if (b.indent && depth === 0) out.indent = Math.max(0, Math.min(3, Number(b.indent) || 0));
    return out;
  });
}

function cleanTags(tags) {
  if (tags == null) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(',');
  return [...new Set(arr.map((t) => String(t).trim().replace(/^#/, '').slice(0, 30)).filter(Boolean))].slice(0, 12);
}

function validDate(d) {
  if (d === '' || d == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) throw bad('Дата має бути у форматі РРРР-ММ-ДД');
  return String(d);
}

/* ───────── читання ───────── */
const LIST_COLS = `p.id, p.parent_id, p.kind, p.title, p.icon, p.cover, p.status, p.priority, p.assignee_id, p.project_id, p.due, p.tags,
  p.sort, p.created_by, p.created_at, p.updated_at, p.done_at, p.deleted_at, p.blocks,
  ua.name AS assignee_name, ua.username AS assignee_username, uc.name AS created_by_name,
  pr.name AS project_name,
  (SELECT COUNT(*) FROM page_comments c WHERE c.page_id = p.id) AS comments`;
const FROM = `FROM pages p
  LEFT JOIN users ua ON ua.id = p.assignee_id
  LEFT JOIN users uc ON uc.id = p.created_by
  LEFT JOIN projects pr ON pr.id = p.project_id`;

function shape(row, { withBlocks = false } = {}) {
  if (!row) return null;
  let blocks = [];
  try { blocks = JSON.parse(row.blocks || '[]'); } catch {}
  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch {}
  const todos = blocks.filter((b) => b.type === 'todo');
  const preview = plain(blocks.find((b) => b.text && plain(b.text))?.text || '').slice(0, 140);
  const out = {
    ...row, tags,
    checklist: todos.length ? { done: todos.filter((b) => b.checked).length, total: todos.length } : null,
    preview,
    overdue: Boolean(row.kind === 'task' && row.due && row.status !== 'done' && row.due < today()),
  };
  if (withBlocks) out.blocks = blocks;
  else delete out.blocks;
  return out;
}

export function listPages(q = {}) {
  const where = [];
  const p = [];
  where.push(q.trash ? 'p.deleted_at IS NOT NULL' : 'p.deleted_at IS NULL');
  if (q.kind) { where.push('p.kind = ?'); p.push(q.kind); }
  if (q.status) { where.push('p.status = ?'); p.push(q.status); }
  if (q.open) where.push("p.status != 'done'");
  if (q.assignee_id) { where.push('p.assignee_id = ?'); p.push(Number(q.assignee_id)); }
  if (q.unassigned) where.push('p.assignee_id IS NULL');
  if (q.project_id) { where.push('p.project_id = ?'); p.push(Number(q.project_id)); }
  if (q.parent_id !== undefined) {
    if (q.parent_id === null) where.push('p.parent_id IS NULL');
    else { where.push('p.parent_id = ?'); p.push(Number(q.parent_id)); }
  }
  if (q.due_to) { where.push('p.due IS NOT NULL AND p.due <= ?'); p.push(q.due_to); }
  if (q.due_from) { where.push('p.due >= ?'); p.push(q.due_from); }
  if (q.tag) { where.push('EXISTS (SELECT 1 FROM json_each(p.tags) j WHERE j.value = ?)'); p.push(String(q.tag)); }
  if (q.q) {
    where.push('(p.title LIKE ? OR p.blocks LIKE ? OR p.tags LIKE ?)');
    const like = `%${String(q.q).slice(0, 80)}%`;
    p.push(like, like, like);
  }
  const order = q.kind === 'page' ? 'p.sort, p.id' : `CASE p.status ${STATUS_IDS.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} ELSE 9 END, p.sort, p.id`;
  const limit = Math.min(Number(q.limit) || 1000, 2000);
  return all(`SELECT ${LIST_COLS} ${FROM} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`, ...p).map((r) => shape(r));
}

export function getPage(id) {
  const row = get(`SELECT ${LIST_COLS} ${FROM} WHERE p.id = ?`, id);
  if (!row) throw new HttpError(404, 'Сторінку не знайдено');
  const page = shape(row, { withBlocks: true });
  page.children = all(`SELECT id, kind, title, icon, status, deleted_at FROM pages WHERE parent_id = ? ORDER BY sort, id`, id).filter((c) => !c.deleted_at);
  const crumbs = [];
  let cur = row.parent_id;
  for (let i = 0; cur && i < 10; i++) {
    const r = get('SELECT id, parent_id, title, icon, kind FROM pages WHERE id = ?', cur);
    if (!r) break;
    crumbs.unshift({ id: r.id, title: r.title, icon: r.icon, kind: r.kind });
    cur = r.parent_id;
  }
  page.crumbs = crumbs;
  page.comments_list = listComments(id);
  return page;
}

export function tagList() {
  return all(`SELECT j.value AS tag, COUNT(*) AS n FROM pages p, json_each(p.tags) j WHERE p.deleted_at IS NULL GROUP BY j.value ORDER BY n DESC, j.value LIMIT 60`).map((r) => r.tag);
}

/* ───────── запис ───────── */
const FIELDS = ['title', 'icon', 'cover', 'status', 'priority', 'assignee_id', 'project_id', 'due', 'tags', 'blocks', 'parent_id', 'kind', 'sort'];

function normalize(body, existing) {
  const out = {};
  for (const k of FIELDS) {
    if (!(k in body)) continue;
    const v = body[k];
    switch (k) {
      case 'title': out.title = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 300); break;
      case 'icon': out.icon = v ? [...String(v)].slice(0, 2).join('') : null; break;
      case 'cover': out.cover = COVERS.includes(v) ? v : null; break;
      case 'status':
        if (!STATUS_IDS.includes(v)) throw bad('Невідомий статус');
        out.status = v; break;
      case 'priority':
        if (v && !PRIORITY_IDS.includes(v)) throw bad('Невідомий пріоритет');
        out.priority = v || null; break;
      case 'assignee_id':
        if (v && !canBeAssignee(v) && Number(v) !== existing?.assignee_id) throw bad('Цю людину не можна призначити (заблокована або не існує)');
        out.assignee_id = v ? Number(v) : null; break;
      case 'project_id':
        if (v && !get('SELECT id FROM projects WHERE id = ?', Number(v))) throw bad('Проєкт не знайдено');
        out.project_id = v ? Number(v) : null; break;
      case 'due': out.due = validDate(v); break;
      case 'tags': out.tags = JSON.stringify(cleanTags(v)); break;
      case 'blocks': out.blocks = JSON.stringify(cleanBlocks(v)); break;
      case 'kind':
        if (!['task', 'page'].includes(v)) throw bad('Невідомий тип');
        out.kind = v; break;
      case 'sort': if (Number.isFinite(Number(v))) out.sort = Number(v); break;
      case 'parent_id': {
        const pid = v ? Number(v) : null;
        if (pid) {
          if (!get('SELECT id FROM pages WHERE id = ? AND deleted_at IS NULL', pid)) throw bad('Батьківську сторінку не знайдено');
          // не можна вкласти сторінку саму в себе або в свою дочірню
          let cur = pid;
          for (let i = 0; cur && i < 20; i++) {
            if (existing && cur === existing.id) throw bad('Не можна перемістити сторінку саму в себе');
            cur = get('SELECT parent_id FROM pages WHERE id = ?', cur)?.parent_id;
          }
        }
        out.parent_id = pid; break;
      }
      default: break;
    }
  }
  return out;
}

export function createPage(body, user) {
  const data = normalize({ kind: 'task', ...body }, null);
  data.kind ||= 'task';
  if (data.kind === 'task') data.status ||= 'todo';
  if (data.sort === undefined) {
    const max = get(`SELECT MAX(sort) AS m FROM pages WHERE kind = ? AND ${data.kind === 'task' ? 'status = ?' : 'COALESCE(parent_id,0) = ?'}`, data.kind, data.kind === 'task' ? data.status : data.parent_id || 0)?.m;
    data.sort = (max ?? 0) + 1;
  }
  if (data.status === 'done') data.done_at = new Date().toISOString();
  data.created_by = user?.id ?? null;
  data.updated_by = user?.id ?? null;
  const cols = Object.keys(data);
  const r = run(`INSERT INTO pages(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...cols.map((c) => data[c]));
  const id = Number(r.lastInsertRowid);
  audit(user?.id, 'create', 'page', id, { title: data.title, kind: data.kind });
  return getPage(id);
}

/** Повертає { page, before } — щоб API вирішив, кого сповістити. */
export function updatePage(id, body, user) {
  const before = get('SELECT * FROM pages WHERE id = ?', id);
  if (!before) throw new HttpError(404, 'Сторінку не знайдено');
  const data = normalize(body, before);
  if (!Object.keys(data).length) return { page: getPage(id), before };
  if (data.status && data.status !== before.status) data.done_at = data.status === 'done' ? new Date().toISOString() : null;
  data.updated_by = user?.id ?? null;
  const cols = Object.keys(data);
  run(`UPDATE pages SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...cols.map((c) => data[c]), id);
  const significant = cols.filter((c) => !['blocks', 'sort', 'updated_by'].includes(c));
  if (significant.length) audit(user?.id, 'update', 'page', id, Object.fromEntries(significant.map((c) => [c, data[c]])));
  return { page: getPage(id), before };
}

function descendants(id) {
  const out = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of all('SELECT id FROM pages WHERE parent_id = ?', cur)) {
      out.push(c.id);
      stack.push(c.id);
    }
  }
  return out;
}

export function trashPage(id, user) {
  if (!get('SELECT id FROM pages WHERE id = ?', id)) throw new HttpError(404, 'Сторінку не знайдено');
  const ids = [id, ...descendants(id)];
  tx(() => { for (const i of ids) run("UPDATE pages SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL", i); });
  audit(user?.id, 'delete', 'page', id, { n: ids.length });
  return { ok: true, n: ids.length };
}

export function restorePage(id, user) {
  const p = get('SELECT * FROM pages WHERE id = ?', id);
  if (!p) throw new HttpError(404, 'Сторінку не знайдено');
  const ids = [id, ...descendants(id)];
  tx(() => {
    for (const i of ids) run('UPDATE pages SET deleted_at = NULL WHERE id = ?', i);
    // якщо батька видалено — повертаємо на верхній рівень
    if (p.parent_id && get('SELECT deleted_at FROM pages WHERE id = ?', p.parent_id)?.deleted_at) run('UPDATE pages SET parent_id = NULL WHERE id = ?', id);
  });
  audit(user?.id, 'restore', 'page', id);
  return getPage(id);
}

export function purgePage(id, user) {
  const p = get('SELECT deleted_at FROM pages WHERE id = ?', id);
  if (!p) throw new HttpError(404, 'Сторінку не знайдено');
  if (!p.deleted_at) throw bad('Спочатку перемісти сторінку в кошик');
  run('DELETE FROM pages WHERE id = ?', id);
  audit(user?.id, 'purge', 'page', id);
  return { ok: true };
}

export function duplicatePage(id, user) {
  const p = get('SELECT * FROM pages WHERE id = ?', id);
  if (!p) throw new HttpError(404, 'Сторінку не знайдено');
  let blocks = [];
  try { blocks = JSON.parse(p.blocks); } catch {}
  return createPage({
    kind: p.kind, title: `${p.title || 'Без назви'} (копія)`, icon: p.icon, cover: p.cover, status: p.kind === 'task' ? 'todo' : undefined,
    priority: p.priority, assignee_id: p.assignee_id, project_id: p.project_id, due: p.due, tags: JSON.parse(p.tags || '[]'),
    blocks: blocks.filter((b) => b.type !== 'page'), parent_id: p.parent_id, sort: p.sort + 0.001,
  }, user);
}

/* ───────── коментарі ───────── */
export function listComments(pageId) {
  return all(`SELECT c.id, c.text, c.created_at, c.user_id, u.name AS user_name FROM page_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.page_id = ? ORDER BY c.id`, pageId);
}
export function addComment(pageId, text, user) {
  if (!get('SELECT id FROM pages WHERE id = ?', pageId)) throw new HttpError(404, 'Сторінку не знайдено');
  const t = String(text || '').trim().slice(0, 4000);
  if (!t) throw bad('Порожній коментар');
  const r = run('INSERT INTO page_comments(page_id, user_id, text) VALUES(?,?,?)', pageId, user?.id ?? null, t);
  run("UPDATE pages SET updated_at = datetime('now') WHERE id = ?", pageId);
  return get('SELECT c.*, u.name AS user_name FROM page_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?', r.lastInsertRowid);
}
export function deleteComment(id, user, isAdmin) {
  const c = get('SELECT * FROM page_comments WHERE id = ?', id);
  if (!c) throw new HttpError(404, 'Коментар не знайдено');
  if (c.user_id !== user.id && !isAdmin) throw new HttpError(403, 'Можна видаляти лише свої коментарі');
  run('DELETE FROM page_comments WHERE id = ?', id);
  return { ok: true };
}

/* ───────── шаблони нових сторінок ───────── */
const b = (type, text = '', extra = {}) => ({ id: newBlockId(), type, text, ...extra });
export const PAGE_TEMPLATES = {
  blank: () => ({}),
  checklist: () => ({ icon: '✅', blocks: [b('h3', 'Що зробити'), b('todo', ''), b('todo', ''), b('todo', ''), b('h3', 'Нотатки'), b('p', '')] }),
  brief: () => ({
    icon: '📋', kind: 'task', tags: ['ТЗ'],
    blocks: [
      b('callout', 'Коротко: що робимо, для кого і навіщо.', { icon: '🎯' }),
      b('h2', 'Задача'), b('p', ''), b('h2', 'Що входить'), b('bullet', ''), b('bullet', ''),
      b('h2', 'Матеріали від клієнта'), b('todo', 'Логотип / брендбук'), b('todo', 'Тексти'), b('todo', 'Доступи'),
      b('h2', 'Терміни та оплата'), b('p', ''),
    ],
  }),
  meeting: () => ({
    icon: '🗓', kind: 'page', title: `Зустріч ${today().split('-').reverse().join('.')}`,
    blocks: [b('h3', 'Учасники'), b('p', ''), b('h3', 'Обговорили'), b('bullet', ''), b('h3', 'Наступні кроки'), b('todo', ''), b('todo', '')],
  }),
  bug: () => ({
    icon: '🐞', kind: 'task', priority: 'high', tags: ['баг'],
    blocks: [b('h3', 'Що сталося'), b('p', ''), b('h3', 'Як повторити'), b('number', ''), b('number', ''), b('h3', 'Як має бути'), b('p', '')],
  }),
};

/* ───────── швидке створення з тексту (бот) ───────── */
const WEEKDAYS = { 'пн': 1, 'понеділок': 1, 'вт': 2, 'вівторок': 2, 'ср': 3, 'середа': 3, 'середу': 3, 'чт': 4, 'четвер': 4, 'пт': 5, "п'ятниця": 5, 'пʼятниця': 5, "п'ятницю": 5, 'пʼятницю': 5, 'сб': 6, 'субота': 6, 'суботу': 6, 'нд': 0, 'неділя': 0, 'неділю': 0 };
function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/**
 * «Зробити банер для ABV @olena завтра !! #дизайн» →
 * { title: 'Зробити банер для ABV', assignee_id, due, priority: 'urgent', tags: ['дизайн'] }
 */
export function parseTaskText(text, now = today()) {
  let t = ` ${String(text || '').trim()} `;
  const out = { tags: [] };
  t = t.replace(/\s#([\p{L}\d_-]{1,30})/gu, (_m, tag) => { out.tags.push(tag); return ' '; });
  t = t.replace(/\s(!{1,3})(?=\s)/g, (_m, ex) => { out.priority = ex.length >= 2 ? 'urgent' : 'high'; return ' '; });
  t = t.replace(/\s@([\w\d_]{2,32})/g, (m, uname) => {
    const u = get(`SELECT id FROM users WHERE ${ASSIGNABLE_SQL} AND (lower(username) = lower(?) OR lower(name) = lower(?) OR lower(name) LIKE lower(?))`, uname, uname, `${uname} %`);
    if (u) { out.assignee_id = u.id; return ' '; }
    return m;
  });
  const dateRe = /\s(?:до\s+|на\s+|в\s+|у\s+)?(сьогодні|завтра|післязавтра|(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?|пн|вт|ср|чт|пт|сб|нд|понеділок|вівторок|середу|середа|четвер|п['ʼ]ятницю|п['ʼ]ятниця|суботу|субота|неділю|неділя)(?=[\s,.!?]|$)/iu;
  const m = t.match(dateRe);
  if (m) {
    const w = m[1].toLowerCase().replace("'", 'ʼ');
    if (w === 'сьогодні') out.due = now;
    else if (w === 'завтра') out.due = addDays(now, 1);
    else if (w === 'післязавтра') out.due = addDays(now, 2);
    else if (m[2]) {
      const y = m[4] ? (m[4].length === 2 ? `20${m[4]}` : m[4]) : now.slice(0, 4);
      let iso = `${y}-${m[3].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
      if (!m[4] && iso < now) iso = `${Number(y) + 1}${iso.slice(4)}`;
      if (!Number.isNaN(Date.parse(iso))) out.due = iso;
    } else {
      const target = WEEKDAYS[w] ?? WEEKDAYS[w.replace('ʼ', "'")];
      if (target !== undefined) {
        const cur = new Date(`${now}T12:00:00Z`).getUTCDay();
        out.due = addDays(now, ((target - cur + 7) % 7) || 7);
      }
    }
    if (out.due) t = t.replace(m[0], ' ');
  }
  out.title = t.replace(/\s+/g, ' ').trim().replace(/[,;:\s]+$/, '').slice(0, 300);
  return out;
}

/** Задачі людини, які горять: прострочені + сьогодні + завтра. */
export function dueDigest(userId, now = today()) {
  return listPages({ kind: 'task', open: true, assignee_id: userId, due_to: addDays(now, 1) });
}

export function myOpenTasks(userId, limit = 15) {
  return listPages({ kind: 'task', open: true, assignee_id: userId, limit: 200 })
    .sort((a, b) => (a.due || '9999') .localeCompare(b.due || '9999') || STATUS_IDS.indexOf(b.status) - STATUS_IDS.indexOf(a.status))
    .slice(0, limit);
}

export function taskLine(p) {
  const st = { todo: '⚪️', doing: '🔵', review: '🟡', done: '✅' }[p.status] || '•';
  const due = p.due ? ` · ${p.overdue ? '🔴 ' : '📅 '}${p.due.slice(8, 10)}.${p.due.slice(5, 7)}` : '';
  const pr = p.priority === 'urgent' ? ' · ‼️' : p.priority === 'high' ? ' · ❗️' : '';
  return `${st} ${p.icon ? `${p.icon} ` : ''}${p.title || 'Без назви'}${due}${pr}${p.assignee_name ? ` · ${p.assignee_name}` : ''}`;
}

/** Посилання для людини, якій призначили задачу: t.me/<бот>?start=task_<id>_<підпис>. */
function linkSecret() {
  let s = getSetting('task_link_secret');
  if (!s) { s = crypto.randomBytes(16).toString('hex'); setSetting('task_link_secret', s); }
  return s;
}
export const taskToken = (pageId, userId) => crypto.createHmac('sha256', linkSecret()).update(`${pageId}:${userId}`).digest('hex').slice(0, 10);
export function taskInviteLink(pageId, userId) {
  const bot = getSetting('bot_username') || 'KKLabSystemBot';
  return `https://t.me/${bot}?start=task_${pageId}_${taskToken(pageId, userId)}`;
}
/**
 * Людина відкрила посилання на свою задачу. Якщо задачу призначено на контакт без Telegram,
 * привʼязуємо цей Telegram-акаунт до контакту (і прибираємо щойно створений дубль).
 */
export function claimTaskLink(pageId, token, user) {
  const page = get('SELECT id, assignee_id FROM pages WHERE id = ? AND deleted_at IS NULL', pageId);
  if (!page?.assignee_id || token !== taskToken(pageId, page.assignee_id)) return null;
  if (page.assignee_id === user.id) return user;
  const contact = get('SELECT * FROM users WHERE id = ?', page.assignee_id);
  if (!contact || contact.tg_id || contact.status !== 'contact') return null;
  const fresh = get("SELECT * FROM users WHERE id = ? AND created_at >= datetime('now', '-10 minutes')", user.id);
  const used = fresh && (get('SELECT 1 FROM transactions WHERE created_by = ? OR member_id = ? LIMIT 1', user.id, user.id) || get('SELECT 1 FROM pages WHERE assignee_id = ? OR created_by = ? LIMIT 1', user.id, user.id));
  if (!fresh || used) return null;
  tx(() => {
    run('DELETE FROM audit WHERE entity = ? AND entity_id = ?', 'user', user.id);
    run('DELETE FROM users WHERE id = ?', user.id);
    run("UPDATE users SET tg_id = ?, username = COALESCE(?, username), status = ?, role = ?, notify = 1, last_seen = datetime('now'), name = CASE WHEN name LIKE '@%' OR name LIKE '+%' THEN ? ELSE name END WHERE id = ?",
      user.tg_id, user.username, user.status === 'active' ? 'active' : 'pending', user.role, user.name, contact.id);
  });
  return get('SELECT * FROM users WHERE id = ?', contact.id);
}

export const pageAppUrl = (id) => {
  const base = (config.webAppUrl || '').replace(/\/$/, '');
  return base ? `${base}/?page=${id}` : '';
};
