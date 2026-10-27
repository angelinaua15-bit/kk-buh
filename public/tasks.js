/* ═══════════════ Задачі та сторінки «як у Notion» ═══════════════
 * Дошка (канбан), таблиця, календар, дерево сторінок і блоковий редактор.
 * Підключається після app.js і користується його api(), esc(), toast(), state.
 */
const TK = {
  meta: null,
  rows: [],
  page: null,
  saveTimer: null,
  saving: false,
  dirty: false,
};
state.tk = Object.assign({ view: 'board', who: 'all', project: '', q: '', hideDone: false, sort: '', dir: 1, cal: ymNow(), open: {} }, (() => {
  try { return JSON.parse(localStorage.getItem('kk_tk') || '{}'); } catch { return {}; }
})());
function tkRemember() {
  try {
    const { view, who, hideDone, sort, dir, open } = state.tk;
    localStorage.setItem('kk_tk', JSON.stringify({ view, who, hideDone, sort, dir, open }));
  } catch {}
}

const ST_COLOR = { todo: 'gray', doing: 'blue', review: 'amber', done: 'green' };
const PR_ICON = { low: '↓', mid: '•', high: '!', urgent: '‼' };
const COVER_BG = {
  violet: 'linear-gradient(120deg,#3b1e9e,#7B5CFF 55%,#D400FF)',
  blue: 'linear-gradient(120deg,#0b2a7a,#2700EE 60%,#2AABEE)',
  pink: 'linear-gradient(120deg,#6d0f4f,#D400FF 60%,#FF7AC6)',
  green: 'linear-gradient(120deg,#064e3b,#10b981 60%,#a7f3d0)',
  amber: 'linear-gradient(120deg,#7c2d12,#f59e0b 60%,#fde68a)',
  night: 'radial-gradient(circle at 20% 30%,#2a2470,transparent 40%),radial-gradient(circle at 80% 70%,#4b0f6b,transparent 45%),#0b0924',
  sunset: 'linear-gradient(120deg,#1e1b4b,#be185d 55%,#fb923c)',
};
const EMOJIS = '📝✅📋🗓🐞💡🎯🚀🔥⭐️📌📎📁🗂📊📈💰💳🧾🤝👥🦍🎨🖌🖥📱🤖🌐🔍📣🧩🛠⚙️🔒📦🎁🏁⏰⌛️📅💬📞✉️🧠✨💎🏆🎉❤️⚡️🌱☕️🍕✈️🏠'.match(/\p{Extended_Pictographic}️?/gu);

const BLOCK_MENU = [
  { type: 'p', icon: 'Aa', name: 'Текст', hint: 'звичайний абзац', keys: 'text текст p абзац' },
  { type: 'h1', icon: 'H1', name: 'Заголовок 1', hint: '#', keys: 'h1 heading заголовок' },
  { type: 'h2', icon: 'H2', name: 'Заголовок 2', hint: '##', keys: 'h2 heading заголовок' },
  { type: 'h3', icon: 'H3', name: 'Заголовок 3', hint: '###', keys: 'h3 heading заголовок' },
  { type: 'todo', icon: '☑', name: 'Чекліст', hint: '[]', keys: 'todo чекліст задача check' },
  { type: 'bullet', icon: '•', name: 'Маркований список', hint: '-', keys: 'bullet список list' },
  { type: 'number', icon: '1.', name: 'Нумерований список', hint: '1.', keys: 'number нумерований list' },
  { type: 'toggle', icon: '▸', name: 'Розгортання', hint: 'прихований текст', keys: 'toggle розгортання' },
  { type: 'quote', icon: '❝', name: 'Цитата', hint: '>', keys: 'quote цитата' },
  { type: 'callout', icon: '💡', name: 'Виноска', hint: 'важливе', keys: 'callout виноска note' },
  { type: 'code', icon: '</>', name: 'Код', hint: '```', keys: 'code код' },
  { type: 'divider', icon: '—', name: 'Роздільник', hint: '---', keys: 'divider роздільник лінія' },
  { type: 'page', icon: '📄', name: 'Сторінка', hint: 'вкладена сторінка', keys: 'page сторінка subpage' },
];
const PH = { p: 'Пиши або натисни «/» для команд', h1: 'Заголовок 1', h2: 'Заголовок 2', h3: 'Заголовок 3', todo: 'Пункт', bullet: 'Пункт списку', number: 'Пункт списку', quote: 'Цитата', callout: 'Виноска', code: 'код', toggle: 'Розгортання' };
const isListType = (t) => t === 'todo' || t === 'bullet' || t === 'number';
const canWritePages = () => state.me?.user?.role !== 'viewer';
const iCanBeAssignee = () => Boolean(TK.meta?.members.some((m) => m.id === state.me?.user?.id));
const uid = () => 'c' + Math.random().toString(36).slice(2, 10);
const ddmm = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '');
function addDaysIso(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function relDate(iso) {
  if (!iso) return '';
  const t = today();
  if (iso === t) return 'Сьогодні';
  if (iso === addDaysIso(t, 1)) return 'Завтра';
  if (iso === addDaysIso(t, -1)) return 'Вчора';
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short', ...(iso.slice(0, 4) !== t.slice(0, 4) ? { year: 'numeric' } : {}) });
}
const initials = (n) => String(n || '?').replace(/^[@+]/, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
function avatar(name, cls = '') {
  if (!name) return '';
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="av ${cls}" style="--h:${h}" title="${esc(name)}">${esc(initials(name))}</span>`;
}
const stPill = (id) => {
  const s = TK.meta?.statuses.find((x) => x.id === id);
  return `<span class="pill pill-${ST_COLOR[id] || 'gray'}"><i></i>${esc(s?.name || id)}</span>`;
};
const prPill = (id) => {
  if (!id) return '';
  const p = TK.meta?.priorities.find((x) => x.id === id);
  return `<span class="pill pill-${p?.color || 'gray'} pill-pr">${PR_ICON[id] || ''} ${esc(p?.name || id)}</span>`;
};
const tagPills = (tags) => (tags || []).map((t) => `<span class="pill pill-tag" style="--h:${[...t].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7)}">${esc(t)}</span>`).join('');

/* ───────── безпечний inline-HTML (повторює серверну санітизацію) ───────── */
const INLINE_OK = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'CODE', 'A', 'BR', 'MARK']);
function cleanInline(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  const walk = (node) => {
    [...node.childNodes].forEach((n) => {
      if (n.nodeType === 3) return;
      if (n.nodeType !== 1) { n.remove(); return; }
      walk(n);
      if (!INLINE_OK.has(n.tagName)) {
        if (n.tagName === 'DIV' || n.tagName === 'P') n.after(document.createElement('br'));
        n.replaceWith(...n.childNodes);
        return;
      }
      const href = n.tagName === 'A' ? n.getAttribute('href') : null;
      [...n.attributes].forEach((a) => n.removeAttribute(a.name));
      if (href && /^(https?:|mailto:|tg:)/i.test(href.trim())) { n.setAttribute('href', href.trim()); n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener'); }
    });
  };
  walk(tpl.content);
  return tpl.innerHTML.replace(/(<br>)+$/, '');
}
const textOf = (html) => { const d = document.createElement('div'); d.innerHTML = html || ''; return d.textContent.replace(/ /g, ' '); };

/* ───────── дані ───────── */
async function tkMeta(force) {
  if (!TK.meta || force) TK.meta = await api('/pages/meta');
  return TK.meta;
}
async function tkLoad() {
  const f = state.tk;
  const p = new URLSearchParams({ kind: 'task' });
  if (f.who === 'me') p.set('assignee', 'me');
  if (f.who === 'none') p.set('assignee', 'none');
  if (f.project) { if (f.project.startsWith('l:')) p.set('project_label', f.project.slice(2)); else p.set('project_id', f.project); }
  if (f.q) p.set('q', f.q);
  TK.rows = await api('/pages?' + p);
  if (f.hideDone) TK.rows = TK.rows.filter((r) => r.status !== 'done' || (r.done_at && Date.now() - Date.parse(r.done_at) < 864e5));
  return TK.rows;
}

/* ═══════════════ Екран «Задачі» ═══════════════ */
async function renderTasks() {
  await tkMeta();
  const f = state.tk;
  const v = view();
  const views = [['board', '▦ Дошка'], ['table', '☰ Таблиця'], ['calendar', '▤ Календар'], ['pages', '📄 Сторінки']];
  v.innerHTML = `<div class="tk-head">
      <h1>${f.view === 'pages' ? 'Сторінки' : 'Задачі'}</h1>
      ${canWritePages() ? `<button class="tk-new" data-tk="new-menu">＋ Нова</button>` : ''}
    </div>
    <div class="tk-views">${views.map(([id, l]) => `<button class="${f.view === id ? 'on' : ''}" data-tk="view" data-v="${id}">${l}</button>`).join('')}</div>
    ${f.view === 'pages' ? '' : `<div class="tk-filters">
      <div class="tk-seg">${[['all', 'Усі'], ['me', 'Мої'], ['none', 'Без відпов.']].map(([id, l]) => `<button class="${f.who === id ? 'on' : ''}" data-tk="who" data-v="${id}">${l}</button>`).join('')}</div>
      <button class="tk-chip ${f.project ? 'on' : ''}" data-tk="f-project">📁 ${esc(f.project ? (f.project.startsWith('l:') ? f.project.slice(2) : TK.meta.projects.find((p) => String(p.id) === String(f.project))?.name || 'Проєкт') : 'Проєкт')}</button>
      <button class="tk-chip ${f.hideDone ? 'on' : ''}" data-tk="hide-done">${f.hideDone ? '◌ Без готових' : '◉ З готовими'}</button>
      <input class="tk-search" id="tkSearch" placeholder="Пошук…" value="${esc(f.q)}" autocomplete="off">
    </div>`}
    <div id="tkBody" class="tk-body"></div>`;
  const s = $('tkSearch');
  if (s) s.oninput = () => { clearTimeout(s._t); s._t = setTimeout(() => { state.tk.q = s.value.trim(); tkBody(); }, 250); };
  await tkBody();
}
async function tkBody() {
  const f = state.tk;
  const box = $('tkBody');
  if (!box) return;
  if (f.view === 'pages') return renderPagesTree(box);
  await tkLoad();
  if (f.view === 'table') return renderTable(box);
  if (f.view === 'calendar') return renderCalendar(box);
  return renderBoard(box);
}

/* ───────── Дошка ───────── */
function taskCardHtml(t) {
  const meta = [
    t.due ? `<span class="tc-due ${t.overdue ? 'late' : t.due === today() ? 'today' : ''}">📅 ${esc(relDate(t.due))}</span>` : '',
    t.priority && t.priority !== 'low' ? prPill(t.priority) : '',
    t.checklist ? `<span class="tc-meta ${t.checklist.done === t.checklist.total ? 'ok' : ''}">☑ ${t.checklist.done}/${t.checklist.total}</span>` : '',
    t.comments ? `<span class="tc-meta">💬 ${t.comments}</span>` : '',
  ].filter(Boolean).join('');
  return `<div class="tc ${t.status === 'done' ? 'is-done' : ''}" data-page="${t.id}" data-id="${t.id}">
    ${t.cover ? `<div class="tc-cover" style="background:${COVER_BG[t.cover] || ''}"></div>` : ''}
    <div class="tc-title">${t.icon ? `<span class="tc-ic">${esc(t.icon)}</span>` : ''}${esc(t.title || 'Без назви')}</div>
    ${t.project_name ? `<div class="tc-proj">📁 ${esc(t.project_name)}</div>` : ''}
    ${t.tags?.length ? `<div class="tc-tags">${tagPills(t.tags)}</div>` : ''}
    ${meta || t.assignee_name ? `<div class="tc-foot"><div class="tc-metas">${meta}</div>${avatar(t.assignee_name)}</div>` : ''}
  </div>`;
}
function renderBoard(box) {
  const cols = TK.meta.statuses;
  box.innerHTML = `<div class="kb" id="kb">${cols.map((c) => {
    const items = TK.rows.filter((r) => r.status === c.id);
    return `<section class="kb-col" data-st="${c.id}">
      <header>${stPill(c.id)}<b>${items.length}</b></header>
      <div class="kb-list" data-st="${c.id}">${items.map(taskCardHtml).join('') || ''}</div>
      ${canWritePages() ? `<button class="kb-add" data-tk="quick-add" data-st="${c.id}">＋ Нова</button>` : ''}
    </section>`;
  }).join('')}</div>
  ${TK.rows.length ? '' : `<div class="tk-empty"><div>🦍</div><b>Поки що порожньо</b><p>Створи першу задачу — кнопка «＋ Нова» або в боті: <code>/task текст @нік завтра</code></p></div>`}`;
  if (canWritePages()) enableBoardDrag($('kb'));
}

function quickAdd(btn) {
  const status = btn.dataset.st;
  const wrap = document.createElement('div');
  wrap.className = 'kb-quick';
  wrap.innerHTML = `<textarea rows="2" placeholder="Назва задачі… (@нік, завтра, ! — як у боті)"></textarea><div class="row"><button class="chip" data-x="cancel">Скасувати</button><button class="chip on" data-x="ok">Додати</button></div>`;
  btn.replaceWith(wrap);
  const ta = wrap.querySelector('textarea');
  ta.focus();
  const done = async (keep) => {
    const title = ta.value.trim();
    if (!title) { if (!keep) tkBody(); return; }
    ta.disabled = true;
    try {
      const body = { kind: 'task', status, title };
      if (state.tk.who === 'me' && iCanBeAssignee()) body.assignee_id = state.me.user.id;
      if (state.tk.project) Object.assign(body, projFilterBody());
      const smart = parseQuick(title);
      Object.assign(body, smart);
      await api('/pages', { method: 'POST', body });
      await tkBody();
      if (keep) document.querySelector(`.kb-add[data-st="${status}"]`)?.click();
    } catch (e) { toast(e.message); ta.disabled = false; }
  };
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(true); }
    if (e.key === 'Escape') tkBody();
  };
  wrap.querySelector('[data-x=ok]').onclick = () => done(false);
  wrap.querySelector('[data-x=cancel]').onclick = () => tkBody();
}
/** Те саме, що бот: @нік, завтра/пт/30.10, ! / !!, #тег. */
function parseQuick(text) {
  let t = ` ${text} `;
  const out = {};
  const tags = [];
  t = t.replace(/\s#([\p{L}\d_-]{1,30})/gu, (_m, g) => { tags.push(g); return ' '; });
  if (tags.length) out.tags = tags;
  t = t.replace(/\s(!{1,3})(?=\s)/g, (_m, ex) => { out.priority = ex.length >= 2 ? 'urgent' : 'high'; return ' '; });
  t = t.replace(/\s@([\w\d_]{2,32})/g, (m, u) => {
    const found = TK.meta.members.find((x) => (x.username || '').toLowerCase() === u.toLowerCase() || x.name.toLowerCase() === u.toLowerCase() || x.name.toLowerCase().startsWith(u.toLowerCase() + ' '));
    if (found) { out.assignee_id = found.id; return ' '; }
    return m;
  });
  const now = today();
  const wd = { пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6, нд: 0 };
  const m = t.match(/\s(?:до\s+|на\s+)?(сьогодні|завтра|післязавтра|пн|вт|ср|чт|пт|сб|нд|(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?)(?=[\s,.!?]|$)/iu);
  if (m) {
    const w = m[1].toLowerCase();
    if (w === 'сьогодні') out.due = now;
    else if (w === 'завтра') out.due = addDaysIso(now, 1);
    else if (w === 'післязавтра') out.due = addDaysIso(now, 2);
    else if (m[2]) {
      const y = m[4] ? (m[4].length === 2 ? `20${m[4]}` : m[4]) : now.slice(0, 4);
      let iso = `${y}-${m[3].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
      if (!m[4] && iso < now) iso = `${Number(y) + 1}${iso.slice(4)}`;
      if (!Number.isNaN(Date.parse(iso))) out.due = iso;
    } else if (w in wd) {
      const cur = new Date(`${now}T12:00:00Z`).getUTCDay();
      out.due = addDaysIso(now, ((wd[w] - cur + 7) % 7) || 7);
    }
    if (out.due) t = t.replace(m[0], ' ');
  }
  out.title = t.replace(/\s+/g, ' ').trim() || text;
  return out;
}

/** Перетягування карток: мишкою одразу, на телефоні — після короткого утримання. */
function enableBoardDrag(board) {
  if (!board) return;
  let drag = null;
  const lists = () => [...board.querySelectorAll('.kb-list')];
  const start = (card, e) => {
    const r = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add('tc-ghost');
    ghost.style.width = `${r.width}px`;
    document.body.appendChild(ghost);
    const ph = document.createElement('div');
    ph.className = 'tc-ph';
    ph.style.height = `${r.height}px`;
    card.after(ph);
    card.classList.add('tc-hidden');
    drag = { card, ghost, ph, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: true };
    navigator.vibrate?.(8);
    try { tgWebApp()?.HapticFeedback?.impactOccurred('light'); } catch {}
    move(e);
  };
  const move = (e) => {
    if (!drag?.ghost) return;
    drag.ghost.style.transform = `translate(${e.clientX - drag.dx}px, ${e.clientY - drag.dy}px) rotate(2deg)`;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const list = el?.closest('.kb-list') || el?.closest('.kb-col')?.querySelector('.kb-list');
    if (list) {
      const after = [...list.querySelectorAll('.tc:not(.tc-hidden)')].find((c) => {
        const b = c.getBoundingClientRect();
        return e.clientY < b.top + b.height / 2;
      });
      if (after) after.before(drag.ph); else list.appendChild(drag.ph);
    }
    // автопрокрутка дошки біля країв
    const br = board.getBoundingClientRect();
    clearInterval(drag.scroll);
    const edge = 40;
    const dir = e.clientX > br.right - edge ? 1 : e.clientX < br.left + edge ? -1 : 0;
    if (dir) drag.scroll = setInterval(() => { board.scrollLeft += dir * 12; }, 16);
  };
  const end = async () => {
    if (!drag?.ghost) { drag = null; return; }
    const { card, ghost, ph } = drag;
    clearInterval(drag.scroll);
    const list = ph.closest('.kb-list');
    const status = list?.dataset.st;
    ph.replaceWith(card);
    card.classList.remove('tc-hidden');
    ghost.remove();
    drag = null;
    if (!status) return;
    const siblings = [...list.querySelectorAll('.tc')];
    const i = siblings.indexOf(card);
    const sortOf = (el) => TK.rows.find((r) => String(r.id) === el?.dataset.id)?.sort;
    const prev = sortOf(siblings[i - 1]);
    const next = sortOf(siblings[i + 1]);
    const sort = prev != null && next != null ? (prev + next) / 2 : prev != null ? prev + 1 : next != null ? next - 1 : 1;
    const id = Number(card.dataset.id);
    const row = TK.rows.find((r) => r.id === id);
    if (row && row.status === status && row.sort === sort) return;
    try {
      const upd = await api('/pages/' + id, { method: 'PATCH', body: { status, sort } });
      Object.assign(row, upd);
      if (status === 'done' && row) confettiAt(card);
      renderBoard($('tkBody'));
    } catch (e) { toast(e.message); tkBody(); }
  };
  let press = null;
  board.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.tc');
    if (!card || e.button > 0) return;
    const touch = e.pointerType !== 'mouse';
    press = { card, x: e.clientX, y: e.clientY, e, touch, timer: touch ? setTimeout(() => { if (!press) return; press.ready = true; start(card, press.last || e); try { board.setPointerCapture(e.pointerId); } catch {} }, 260) : null, ready: !touch };
  });
  board.addEventListener('pointermove', (e) => {
    if (drag?.ghost) { e.preventDefault(); move(e); return; }
    if (!press) return;
    press.last = e;
    const dist = Math.hypot(e.clientX - press.x, e.clientY - press.y);
    if (!press.touch && dist > 6 && !drag) { start(press.card, e); try { board.setPointerCapture(e.pointerId); } catch {} }
    else if (press.touch && dist > 10 && !press.ready) { clearTimeout(press.timer); press = null; }
  });
  const up = () => {
    if (press) clearTimeout(press.timer);
    const wasDrag = Boolean(drag?.ghost);
    press = null;
    if (wasDrag) { board._suppressClick = Date.now(); end(); }
  };
  board.addEventListener('pointerup', up);
  board.addEventListener('pointercancel', up);
  board.addEventListener('touchmove', (e) => { if (drag?.ghost) e.preventDefault(); }, { passive: false });
  board.addEventListener('contextmenu', (e) => { if (e.target.closest('.tc')) e.preventDefault(); });
}
function confettiAt(el) {
  const r = el.getBoundingClientRect();
  for (let i = 0; i < 14; i++) {
    const s = document.createElement('i');
    s.className = 'confetti';
    s.style.left = `${r.left + r.width / 2}px`;
    s.style.top = `${r.top + 16}px`;
    s.style.setProperty('--x', `${(Math.random() - 0.5) * 160}px`);
    s.style.setProperty('--y', `${-40 - Math.random() * 90}px`);
    s.style.setProperty('--c', ['#7B5CFF', '#D400FF', '#34D399', '#FBBF24', '#2AABEE'][i % 5]);
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 900);
  }
}

/* ───────── Таблиця ───────── */
const TBL_COLS = [
  { id: 'title', name: 'Назва' },
  { id: 'status', name: 'Статус' },
  { id: 'assignee_id', name: 'Відповідальний' },
  { id: 'due', name: 'Дедлайн' },
  { id: 'priority', name: 'Пріоритет' },
  { id: 'project_id', name: 'Проєкт' },
  { id: 'tags', name: 'Теги' },
];
function renderTable(box) {
  const f = state.tk;
  let rows = [...TK.rows];
  if (f.sort) {
    const order = { status: TK.meta.statuses.map((s) => s.id), priority: ['urgent', 'high', 'mid', 'low', null] };
    const key = (r) => {
      if (f.sort === 'status' || f.sort === 'priority') return order[f.sort].indexOf(r[f.sort] ?? null);
      if (f.sort === 'assignee_id') return r.assignee_name || '￿';
      if (f.sort === 'project_id') return r.project_name || '￿';
      if (f.sort === 'due') return r.due || '9999';
      if (f.sort === 'tags') return (r.tags || []).join(',') || '￿';
      return (r.title || '').toLowerCase();
    };
    rows.sort((a, b) => { const x = key(a); const y = key(b); return (x > y ? 1 : x < y ? -1 : 0) * f.dir; });
  }
  box.innerHTML = `<div class="ntbl-wrap"><table class="ntbl">
    <thead><tr>${TBL_COLS.map((c) => `<th data-tk="sort" data-v="${c.id}">${c.name}${f.sort === c.id ? (f.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr data-id="${r.id}" class="${r.status === 'done' ? 'is-done' : ''}">
      <td class="c-title" data-page="${r.id}"><span>${r.icon ? esc(r.icon) + ' ' : ''}${esc(r.title || 'Без назви')}</span>${r.checklist ? `<small>☑ ${r.checklist.done}/${r.checklist.total}</small>` : ''}</td>
      <td data-prop="status">${stPill(r.status)}</td>
      <td data-prop="assignee_id">${r.assignee_name ? `${avatar(r.assignee_name, 'sm')} ${esc(r.assignee_name)}` : '<span class="ph">—</span>'}</td>
      <td data-prop="due" class="${r.overdue ? 'late' : ''}">${r.due ? esc(relDate(r.due)) : '<span class="ph">—</span>'}</td>
      <td data-prop="priority">${prPill(r.priority) || '<span class="ph">—</span>'}</td>
      <td data-prop="project_id">${r.project_name ? esc(r.project_name) : '<span class="ph">—</span>'}</td>
      <td data-prop="tags">${tagPills(r.tags) || '<span class="ph">—</span>'}</td>
    </tr>`).join('')}
    ${canWritePages() ? `<tr class="ntbl-add"><td colspan="${TBL_COLS.length}"><input id="tblNew" placeholder="＋ Нова задача — Enter, щоб додати"></td></tr>` : ''}
    </tbody></table></div>
    <p class="muted tk-count">${rows.length} ${plural(rows.length, 'задача', 'задачі', 'задач')}</p>`;
  const inp = $('tblNew');
  if (inp) inp.onkeydown = (e) => {
    if (e.key !== 'Enter' || !inp.value.trim()) return;
    safe(async () => {
      const body = { kind: 'task', status: 'todo', ...parseQuick(inp.value.trim()) };
      if (state.tk.who === 'me' && iCanBeAssignee()) body.assignee_id ??= state.me.user.id;
      if (state.tk.project) Object.assign(body, projFilterBody());
      await api('/pages', { method: 'POST', body });
      await tkBody();
      $('tblNew')?.focus();
    });
  };
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

/* ───────── Календар ───────── */
function renderCalendar(box) {
  const ym = state.tk.cal;
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const shift = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const t = today();
  const byDay = {};
  TK.rows.forEach((r) => { if (r.due) (byDay[r.due] ||= []).push(r); });
  const cells = [];
  for (let i = 0; i < shift; i++) cells.push('<div class="cal-d out"></div>');
  for (let d = 1; d <= days; d++) {
    const iso = `${ym}-${String(d).padStart(2, '0')}`;
    const items = byDay[iso] || [];
    cells.push(`<div class="cal-d ${iso === t ? 'today' : ''}" data-tk="cal-day" data-v="${iso}">
      <span class="cal-n">${d}</span>
      ${items.slice(0, 3).map((r) => `<span class="cal-t ${r.status === 'done' ? 'is-done' : ''} ${r.overdue ? 'late' : ''}" data-page="${r.id}">${esc(r.icon || '')}${esc(r.title || 'Без назви')}</span>`).join('')}
      ${items.length > 3 ? `<span class="cal-more">+${items.length - 3}</span>` : ''}
    </div>`);
  }
  const nodate = TK.rows.filter((r) => !r.due && r.status !== 'done');
  const label = first.toLocaleDateString('uk-UA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  box.innerHTML = `<div class="cal-head"><button class="chip" data-tk="cal" data-d="-1">‹</button><b>${label[0].toUpperCase() + label.slice(1)}</b><button class="chip" data-tk="cal" data-d="1">›</button><button class="chip" data-tk="cal" data-d="0">Сьогодні</button></div>
    <div class="cal">${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'].map((d) => `<div class="cal-w">${d}</div>`).join('')}${cells.join('')}</div>
    ${nodate.length ? `<h2>Без дати · ${nodate.length}</h2><div class="nd-list">${nodate.map((r) => `<div class="nd" data-page="${r.id}">${stPill(r.status)}<span>${esc(r.icon || '')} ${esc(r.title || 'Без назви')}</span>${avatar(r.assignee_name, 'sm')}</div>`).join('')}</div>` : ''}`;
}

/* ───────── Сторінки (дерево) ───────── */
async function renderPagesTree(box) {
  const list = await api('/pages?kind=page' + (state.tk.q ? '&q=' + encodeURIComponent(state.tk.q) : ''));
  const kids = {};
  list.forEach((p) => (kids[p.parent_id || 0] ||= []).push(p));
  const ids = new Set(list.map((p) => p.id));
  // якщо батько — задача або його не видно, показуємо на верхньому рівні
  list.forEach((p) => { if (p.parent_id && !ids.has(p.parent_id)) (kids[0] ||= []).push(p); });
  const open = state.tk.open || {};
  const tree = (pid, depth) => (kids[pid] || []).filter((p) => pid !== 0 || !p.parent_id || !ids.has(p.parent_id)).map((p) => {
    const has = (kids[p.id] || []).length;
    return `<div class="tr-row" style="--d:${depth}">
      <button class="tr-tog ${has ? '' : 'empty'}" data-tk="tree-tog" data-v="${p.id}">${has ? (open[p.id] ? '▾' : '▸') : '•'}</button>
      <div class="tr-title" data-page="${p.id}"><span>${esc(p.icon || '📄')}</span>${esc(p.title || 'Без назви')}</div>
      ${canWritePages() ? `<button class="tr-add" data-tk="tree-add" data-v="${p.id}" title="Вкладена сторінка">＋</button>` : ''}
    </div>${has && open[p.id] ? tree(p.id, depth + 1) : ''}`;
  }).join('');
  box.innerHTML = `<div class="tk-filters"><input class="tk-search" id="tkSearchP" placeholder="Пошук по сторінках…" value="${esc(state.tk.q)}" autocomplete="off"></div>
    <div class="tree">${tree(0, 0) || `<div class="tk-empty"><div>📄</div><b>Сторінок ще немає</b><p>Тут зручно тримати ТЗ, нотатки зустрічей, інструкції та бази знань команди.</p></div>`}</div>
    ${canWritePages() ? `<button class="tr-new" data-tk="new-page">＋ Нова сторінка</button>` : ''}
    <button class="tr-trash" data-tk="trash">🗑 Кошик</button>`;
  const s = $('tkSearchP');
  s.oninput = () => { clearTimeout(s._t); s._t = setTimeout(() => { state.tk.q = s.value.trim(); renderPagesTree(box).then(() => { const n = $('tkSearchP'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); }, 300); };
}

async function openTrash() {
  const rows = await api('/pages?trash=1');
  openModal(`<div class="handle"></div><h3>🗑 Кошик</h3>
    ${rows.length ? rows.map((r) => `<div class="row trash-row"><span>${esc(r.icon || (r.kind === 'task' ? '📝' : '📄'))} ${esc(r.title || 'Без назви')}</span>
      <span><button class="chip" data-x="restore" data-v="${r.id}">Відновити</button> <button class="chip" data-x="purge" data-v="${r.id}">✕</button></span></div>`).join('') : '<div class="empty">Кошик порожній</div>'}`, (el) => {
    el.onclick = (e) => {
      const b = e.target.closest('[data-x]');
      if (!b) return;
      safe(async () => {
        if (b.dataset.x === 'restore') { await api(`/pages/${b.dataset.v}/restore`, { method: 'POST' }); toast('Відновлено'); }
        else { if (!(await ask('Видалити назавжди? Це не можна скасувати.'))) return; await api(`/pages/${b.dataset.v}/purge`, { method: 'DELETE' }); toast('Видалено назавжди'); }
        closeModal(); openTrash(); tkBody();
      });
    };
  });
}

/** Проєкти для вибору: вписані вручну + з бухгалтерії. id ручних — «l:Назва». */
function projectItems(emptyLabel) {
  const m = TK.meta;
  return [
    { id: '', label: emptyLabel, html: `<span class="ph">${esc(emptyLabel)}</span>` },
    ...(m.project_labels || []).map((l) => ({ id: `l:${l}`, label: l, html: `✎ ${esc(l)}` })),
    ...m.projects.map((p) => ({ id: p.id, label: p.name || `#${p.id}`, hint: p.section || '' })),
  ];
}
function projFilterBody() {
  const v = state.tk.project;
  return v.startsWith('l:') ? { project_label: v.slice(2) } : { project_id: Number(v) };
}

/* ═══════════════ Пікер (випадаюче меню) ═══════════════ */
function picker({ title, items, multi, search, value, onPick, extra, onCreate, anchor, createLabel }) {
  closePicker();
  const box = document.createElement('div');
  box.className = 'pk-wrap';
  box.innerHTML = `<div class="pk">${title ? `<div class="pk-title">${esc(title)}</div>` : ''}
    ${search ? `<input class="pk-search" placeholder="${onCreate ? 'Знайти або створити…' : 'Пошук…'}">` : ''}
    <div class="pk-list"></div>${extra || ''}</div>`;
  document.body.appendChild(box);
  const pk = box.querySelector('.pk');
  if (anchor && window.innerWidth > 700) {
    const r = anchor.getBoundingClientRect();
    box.classList.add('pk-float');
    pk.style.left = `${Math.min(r.left, window.innerWidth - 300)}px`;
    pk.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 360)}px`;
  }
  const sel = new Set(multi ? value || [] : []);
  const listEl = box.querySelector('.pk-list');
  const input = box.querySelector('.pk-search');
  const draw = () => {
    const q = (input?.value || '').trim().toLowerCase();
    const shown = items.filter((i) => !q || i.label.toLowerCase().includes(q) || (i.keys || '').includes(q));
    listEl.innerHTML = shown.map((i) => `<button class="pk-it ${(multi ? sel.has(i.id) : value === i.id) ? 'on' : ''}" data-v="${esc(String(i.id ?? ''))}">
      ${i.html || esc(i.label)}${i.hint ? `<small>${esc(i.hint)}</small>` : ''}${(multi ? sel.has(i.id) : value === i.id) ? '<em>✓</em>' : ''}</button>`).join('')
      + (onCreate && q && !items.some((i) => i.label.toLowerCase() === q) ? `<button class="pk-it pk-create" data-create="1">${createLabel ? createLabel(input.value.trim()) : `＋ Створити «${esc(input.value.trim())}»`}</button>` : '')
      + (!shown.length && !onCreate && items.length ? '<div class="pk-empty">Нічого не знайдено</div>' : '');
  };
  draw();
  input?.addEventListener('input', draw);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); listEl.querySelector('.pk-it')?.click(); }
    if (e.key === 'Escape') closePicker();
  });
  if (input && window.innerWidth > 700) setTimeout(() => input.focus(), 30);
  listEl.addEventListener('click', (e) => {
    const b = e.target.closest('.pk-it');
    if (!b) return;
    if (b.dataset.create) { onCreate(input.value.trim()); if (multi) { sel.add(input.value.trim()); items.push({ id: input.value.trim(), label: input.value.trim() }); input.value = ''; draw(); } else closePicker(); return; }
    const item = items.find((i) => String(i.id ?? '') === b.dataset.v);
    if (multi) {
      if (sel.has(item.id)) sel.delete(item.id); else sel.add(item.id);
      draw();
      onPick([...sel]);
    } else {
      closePicker();
      onPick(item.id);
    }
  });
  box.addEventListener('pointerdown', (e) => { if (e.target === box) { e.preventDefault(); closePicker(); } });
  return box;
}
function closePicker() { document.querySelectorAll('.pk-wrap').forEach((x) => x.remove()); }

function propPicker(prop, row, anchor, apply) {
  const m = TK.meta;
  if (prop === 'status') return picker({ title: 'Статус', anchor, value: row.status, items: m.statuses.map((s) => ({ id: s.id, label: s.name, html: stPill(s.id) })), onPick: (v) => apply({ status: v }) });
  if (prop === 'priority') return picker({ title: 'Пріоритет', anchor, value: row.priority || '', items: [{ id: '', label: 'Без пріоритету', html: '<span class="ph">Без пріоритету</span>' }, ...m.priorities.map((p) => ({ id: p.id, label: p.name, html: prPill(p.id) }))], onPick: (v) => apply({ priority: v || null }) });
  if (prop === 'assignee_id') {
    return picker({
      title: 'Відповідальний', anchor, search: m.members.length > 6, value: row.assignee_id || '',
      items: [{ id: '', label: 'Нікого', html: '<span class="ph">Нікого</span>' }, ...m.members.map((u) => ({ id: u.id, label: u.name, keys: (u.username || '').toLowerCase(), html: `${avatar(u.name, 'sm')} ${esc(u.name)}${u.username ? ` <small>@${esc(u.username)}</small>` : ''}${u.id === state.me.user.id ? ' <small>(я)</small>' : ''}${u.status !== 'active' ? ' <small title="Користується ботом, але доступ до бухгалтерії ще не підтверджено">⏳</small>' : ''}` }))],
      onPick: (v) => apply({ assignee_id: v || null }),
      extra: '<div class="pk-note">Тут усі, хто писав боту. ⏳ — доступ до бухгалтерії ще не підтверджено (задачу людина все одно отримає). Нових людей запрошуй: /invite.</div>',
    });
  }
  if (prop === 'project_id') return picker({
    title: 'Проєкт', anchor, search: true,
    value: row.project_id || (row.project_label ? `l:${row.project_label}` : ''),
    items: projectItems('Без проєкту'),
    onPick: (v) => apply(String(v).startsWith('l:') ? { project_label: String(v).slice(2) } : { project_id: v || null, project_label: null }),
    onCreate: (q) => { if (!(m.project_labels ||= []).includes(q)) m.project_labels.unshift(q); apply({ project_label: q }); },
    createLabel: (q) => `✎ Вписати «${esc(q)}»`,
    extra: '<div class="pk-note">Немає в списку — просто впиши назву і натисни «Вписати».</div>',
  });
  if (prop === 'tags') {
    const all = [...new Set([...(m.tags || []), ...(row.tags || [])])];
    let cur = [...(row.tags || [])];
    return picker({
      title: 'Теги', anchor, search: true, multi: true, value: cur, items: all.map((t) => ({ id: t, label: t, html: tagPills([t]) })),
      onPick: (v) => { cur = v; apply({ tags: v }, true); },
      onCreate: (t) => { cur = [...new Set([...cur, t])]; if (!m.tags.includes(t)) m.tags.push(t); apply({ tags: cur }, true); },
    });
  }
  if (prop === 'due') {
    const t = today();
    const nextMon = addDaysIso(t, ((8 - new Date(`${t}T12:00:00Z`).getUTCDay()) % 7) || 7);
    const box = picker({
      title: 'Дедлайн', anchor, value: row.due || '',
      items: [{ id: t, label: 'Сьогодні' }, { id: addDaysIso(t, 1), label: 'Завтра' }, { id: addDaysIso(t, 2), label: 'Післязавтра' }, { id: nextMon, label: 'Наступний понеділок' }, { id: addDaysIso(t, 7), label: 'Через тиждень' }, { id: '', label: 'Без дати', html: '<span class="ph">Без дати</span>' }],
      onPick: (v) => apply({ due: v || null }),
      extra: `<label class="pk-date">Обрати дату<input type="date" value="${row.due || ''}"></label>`,
    });
    box.querySelector('.pk-date input').onchange = (e) => { closePicker(); apply({ due: e.target.value || null }); };
    return box;
  }
}

/* делегування кліків для розділу задач */
document.body.addEventListener('click', (e) => {
  const kb = document.getElementById('kb');
  if (kb && kb._suppressClick && Date.now() - kb._suppressClick < 400 && e.target.closest('.tc')) { e.stopPropagation(); return; }
  const cell = e.target.closest('.ntbl td[data-prop]');
  if (cell && canWritePages()) {
    const id = Number(cell.closest('tr').dataset.id);
    const row = TK.rows.find((r) => r.id === id);
    return propPicker(cell.dataset.prop, row, cell, async (patch, keep) => {
      try {
        const upd = await api('/pages/' + id, { method: 'PATCH', body: patch });
        Object.assign(row, upd);
        if (upd.assignee_invite) showInvite(upd);
        if (!keep) renderTable($('tkBody'));
        else cell.innerHTML = tagPills(upd.tags) || '<span class="ph">—</span>';
      } catch (err) { toast(err.message); }
    });
  }
  const pg = e.target.closest('[data-page]');
  if (pg && !e.target.closest('.pg')) { e.stopPropagation(); return openPage(Number(pg.dataset.page)); }
  const b = e.target.closest('[data-tk]');
  if (!b) return;
  const act = b.dataset.tk;
  const f = state.tk;
  if (act === 'view') { f.view = b.dataset.v; f.q = ''; tkRemember(); return renderTasks(); }
  if (act === 'who') { f.who = b.dataset.v; tkRemember(); return renderTasks(); }
  if (act === 'hide-done') { f.hideDone = !f.hideDone; tkRemember(); return renderTasks(); }
  if (act === 'f-project') return picker({ title: 'Фільтр за проєктом', anchor: b, search: true, value: f.project ? (f.project.startsWith('l:') ? f.project : Number(f.project)) : '', items: projectItems('Усі проєкти'), onPick: (v) => { f.project = v ? String(v) : ''; renderTasks(); } });
  if (act === 'sort') { if (f.sort === b.dataset.v) { if (f.dir < 0) { f.sort = ''; f.dir = 1; } else f.dir = -1; } else { f.sort = b.dataset.v; f.dir = 1; } tkRemember(); return renderTable($('tkBody')); }
  if (act === 'quick-add') return quickAdd(b);
  if (act === 'cal') { f.cal = b.dataset.d === '0' ? ymNow() : shiftMonth(f.cal, Number(b.dataset.d)); return renderCalendar($('tkBody')); }
  if (act === 'cal-day' && canWritePages()) return newPageFlow({ kind: 'task', due: b.dataset.v });
  if (act === 'tree-tog') { f.open[b.dataset.v] = !f.open[b.dataset.v]; tkRemember(); return renderPagesTree($('tkBody')); }
  if (act === 'tree-add') { f.open[b.dataset.v] = true; tkRemember(); return newPageFlow({ kind: 'page', parent_id: Number(b.dataset.v) }); }
  if (act === 'new-page') return newPageFlow({ kind: 'page' });
  if (act === 'trash') return safe(openTrash);
  if (act === 'new-menu') return newMenu(b);
}, true);

function newMenu(anchor) {
  const isPages = state.tk.view === 'pages';
  picker({
    title: 'Створити', anchor,
    items: [
      { id: 'task', label: 'Задача', html: '📝 Задача', hint: 'з дедлайном і відповідальним' },
      { id: 'page', label: 'Сторінка', html: '📄 Сторінка', hint: 'нотатки, документ, база знань' },
      { id: 't:checklist', label: 'Чекліст', html: '✅ Задача з чеклістом' },
      { id: 't:brief', label: 'ТЗ', html: '📋 ТЗ проєкту' },
      { id: 't:bug', label: 'Баг', html: '🐞 Баг / правка' },
      { id: 't:meeting', label: 'Зустріч', html: '🗓 Нотатки зустрічі' },
    ].sort((a, b) => (isPages ? (a.id === 'page' ? -1 : b.id === 'page' ? 1 : 0) : 0)),
    onPick: (v) => {
      if (v.startsWith('t:')) return newPageFlow({ template: v.slice(2), kind: v === 't:meeting' ? 'page' : 'task' });
      return newPageFlow({ kind: v });
    },
  });
}

async function newPageFlow(body = {}) {
  if (!canWritePages()) return toast('У режимі перегляду не можна створювати');
  try {
    const b = { ...body };
    if (b.kind !== 'page') {
      b.status ||= 'todo';
      if (state.tk.who === 'me' && !b.assignee_id && iCanBeAssignee()) b.assignee_id = state.me.user.id;
      if (state.tk.project && !b.project_id && !b.project_label) Object.assign(b, projFilterBody());
    }
    const p = await api('/pages', { method: 'POST', body: b });
    await openPage(p.id, { fresh: true });
  } catch (e) { toast(e.message); }
}

/* ═══════════════ Сторінка (редактор) ═══════════════ */
function pageShell() {
  let el = document.getElementById('pageView');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pageView';
    el.className = 'pg hidden';
    document.body.appendChild(el);
  }
  return el;
}

async function openPage(id, opts = {}) {
  await flushSave();
  closePicker();
  await tkMeta();
  let p;
  try { p = await api('/pages/' + id); } catch (e) { return toast(e.message); }
  if (!opts.back) TK.navStack = [];
  TK.page = p;
  const el = pageShell();
  el.classList.remove('hidden');
  document.body.classList.add('pg-open');
  if (!p.blocks.length) p.blocks = [{ id: uid(), type: 'p', text: '' }];
  drawPage(el);
  const bb = tgWebApp()?.BackButton;
  try { bb?.show(); bb?.onClick(pageBack); } catch {}
  if (opts.fresh) setTimeout(() => { const t = el.querySelector('.pg-title'); t?.focus(); }, 60);
  setUrlParam('page', id);
}
function setUrlParam(k, v) {
  const q = new URLSearchParams(location.search);
  if (v == null || v === '') q.delete(k); else q.set(k, v);
  q.delete('tab');
  const s = q.toString();
  history.replaceState({}, '', location.pathname + (s ? `?${s}` : ''));
}
function pageBack() {
  if (TK.navStack?.length) return openPage(TK.navStack.pop(), { back: true });
  closePage();
}
async function closePage() {
  await flushSave();
  closePicker();
  hideSlash();
  hideFmt();
  const el = document.getElementById('pageView');
  el?.classList.add('hidden');
  document.body.classList.remove('pg-open');
  if (el) el.innerHTML = '';
  TK.page = null;
  TK.navStack = [];
  try { const bb = tgWebApp()?.BackButton; bb?.offClick(pageBack); bb?.hide(); } catch {}
  setUrlParam('page', null);
  if (state.tab === 'tasks') tkBody().catch(() => {});
  else if (state.tab === 'dash') refresh();
}
function goChild(id, fresh = false) {
  (TK.navStack ||= []).push(TK.page.id);
  openPage(id, { back: true, fresh });
}

function drawPage(el) {
  const p = TK.page;
  const ro = !canWritePages();
  const isTask = p.kind === 'task';
  const props = isTask ? [
    ['status', '◷', 'Статус', stPill(p.status)],
    ['assignee_id', '👤', 'Відповідальний', p.assignee_name ? `${avatar(p.assignee_name, 'sm')} ${esc(p.assignee_name)}` : '<span class="ph">Нікого</span>'],
    ['due', '📅', 'Дедлайн', p.due ? `<span class="${p.overdue ? 'late' : ''}">${esc(relDate(p.due))}${p.due !== today() && p.due !== addDaysIso(today(), 1) ? '' : ` · ${ddmm(p.due)}`}</span>` : '<span class="ph">Порожньо</span>'],
    ['priority', '⚑', 'Пріоритет', prPill(p.priority) || '<span class="ph">Порожньо</span>'],
    ['project_id', '📁', 'Проєкт', p.project_name ? esc(p.project_name) : '<span class="ph">Порожньо</span>'],
    ['tags', '#', 'Теги', tagPills(p.tags) || '<span class="ph">Порожньо</span>'],
  ] : [];
  el.innerHTML = `<div class="pg-bar">
      <button class="pg-back" data-pg="back">‹</button>
      <div class="pg-crumbs">${(p.crumbs || []).map((c) => `<a data-pg="crumb" data-v="${c.id}">${esc(c.icon || '📄')} ${esc(c.title || 'Без назви')}</a><i>/</i>`).join('')}<span>${esc(p.icon || (isTask ? '📝' : '📄'))} ${esc(p.title || 'Без назви')}</span></div>
      <span class="pg-saved" id="pgSaved"></span>
      <button class="pg-more" data-pg="menu">⋯</button>
    </div>
    <div class="pg-scroll" id="pgScroll">
      ${p.cover ? `<div class="pg-cover" style="background:${COVER_BG[p.cover]}">${ro ? '' : '<button data-pg="cover">Змінити обкладинку</button>'}</div>` : ''}
      <div class="pg-inner ${p.cover ? 'has-cover' : ''}">
        ${p.icon ? `<button class="pg-icon" data-pg="icon">${esc(p.icon)}</button>` : ''}
        ${ro ? '' : `<div class="pg-addons">${p.icon ? '' : '<button data-pg="icon">☺ Іконка</button>'}${p.cover ? '' : '<button data-pg="cover">▭ Обкладинка</button>'}</div>`}
        <h1 class="pg-title" ${ro ? '' : 'contenteditable="true"'} data-ph="Без назви" spellcheck="true">${esc(p.title)}</h1>
        ${isTask ? `<div class="pg-props">${props.map(([k, ic, name, val]) => `<div class="pp" data-prop="${k}"><span class="pp-k"><i>${ic}</i>${name}</span><span class="pp-v">${val}</span></div>`).join('')}
          <div class="pp pp-ro"><span class="pp-k"><i>✎</i>Створено</span><span class="pp-v muted">${esc(p.created_by_name || '—')} · ${esc(relDate(p.created_at?.slice(0, 10)))}</span></div></div>` : ''}
        <div class="pg-blocks" id="pgBlocks"></div>
        ${ro ? '' : '<button class="pg-addblock" data-pg="add-end">＋ Додати блок</button>'}
        ${orphanChildren(p)}
        <section class="pg-comments">
          <h4>Коментарі ${p.comments_list.length ? `· ${p.comments_list.length}` : ''}</h4>
          ${p.comments_list.map((c) => `<div class="cm">${avatar(c.user_name || '?', 'sm')}<div><b>${esc(c.user_name || '—')}</b> <small>${esc(relDate(c.created_at.slice(0, 10)))} ${esc(c.created_at.slice(11, 16))}</small>${c.user_id === state.me.user.id || state.me.user.role === 'admin' ? ` <button class="cm-del" data-pg="cm-del" data-v="${c.id}">✕</button>` : ''}<p>${esc(c.text).replace(/\n/g, '<br>')}</p></div></div>`).join('')}
          ${ro ? '' : `<div class="cm-new">${avatar(state.me.user.name, 'sm')}<textarea id="cmText" rows="1" placeholder="Додати коментар…"></textarea><button data-pg="cm-send">↑</button></div>`}
        </section>
      </div>
    </div>
    <div class="pg-kbar hidden" id="pgKbar">
      <button data-k="plus" title="Тип блоку">＋</button><button data-k="todo">☑</button><button data-k="bullet">•</button><button data-k="h2">H</button>
      <button data-k="bold"><b>B</b></button><button data-k="italic"><i>I</i></button><button data-k="strike"><s>S</s></button><button data-k="link">🔗</button>
      <button data-k="outdent">⇤</button><button data-k="indent">⇥</button><button data-k="up">↑</button><button data-k="down">↓</button><button data-k="hide">⌄</button>
    </div>`;
  renderBlocks();
  wirePage(el);
}
function orphanChildren(p) {
  const linked = new Set(p.blocks.filter((b) => b.type === 'page').map((b) => b.page_id));
  const rest = (p.children || []).filter((c) => !linked.has(c.id));
  if (!rest.length) return '';
  return `<div class="pg-children"><h4>Вкладені сторінки</h4>${rest.map((c) => `<a class="blk-pagelink" data-pg="child" data-v="${c.id}">${esc(c.icon || (c.kind === 'task' ? '📝' : '📄'))} <u>${esc(c.title || 'Без назви')}</u></a>`).join('')}</div>`;
}

function blockHtml(b, num) {
  const ro = !canWritePages();
  const ce = ro ? '' : `contenteditable="${b.type === 'code' ? 'plaintext-only' : 'true'}"`;
  const handle = ro ? '' : '<button class="blk-h" tabindex="-1" aria-label="Блок">⋮⋮</button>';
  const ind = b.indent ? ` style="--ind:${b.indent}"` : '';
  if (b.type === 'divider') return `<div class="blk blk-divider" data-id="${b.id}"${ind}>${handle}<hr></div>`;
  if (b.type === 'page') {
    const c = (TK.page.children || []).find((x) => x.id === b.page_id);
    return `<div class="blk blk-page" data-id="${b.id}"${ind}>${handle}<a class="blk-pagelink" data-pg="child" data-v="${b.page_id}">${esc(c?.icon || '📄')} <u>${esc(c ? c.title || 'Без назви' : 'Сторінку видалено')}</u></a></div>`;
  }
  let pre = '';
  if (b.type === 'todo') pre = `<button class="blk-chk ${b.checked ? 'on' : ''}" data-pg="check" tabindex="-1">${b.checked ? '✓' : ''}</button>`;
  if (b.type === 'bullet') pre = `<span class="blk-dot">${['•', '◦', '▪', '•'][b.indent || 0]}</span>`;
  if (b.type === 'number') pre = `<span class="blk-num">${num}.</span>`;
  if (b.type === 'callout') pre = `<button class="blk-ci" data-pg="callout-icon" tabindex="-1">${esc(b.icon || '💡')}</button>`;
  if (b.type === 'toggle') pre = `<button class="blk-tg ${b.open ? 'on' : ''}" data-pg="toggle" tabindex="-1">▸</button>`;
  const body = b.type === 'toggle' && b.open ? `<div class="blk-body" ${ce} data-ph="Порожній вміст. Натисни, щоб писати.">${cleanInline(b.body)}</div>` : '';
  return `<div class="blk blk-${b.type} ${b.type === 'todo' && b.checked ? 'is-checked' : ''}" data-id="${b.id}"${ind}>${handle}${pre}<div class="blk-main"><div class="blk-text" ${ce} data-ph="${PH[b.type] || ''}" spellcheck="${b.type === 'code' ? 'false' : 'true'}">${b.type === 'code' ? b.text || '' : cleanInline(b.text)}</div>${body}</div></div>`;
}
function renderBlocks() {
  const box = document.getElementById('pgBlocks');
  if (!box) return;
  let n = 0;
  let prevType = null;
  let prevInd = 0;
  box.innerHTML = TK.page.blocks.map((b) => {
    if (b.type === 'number') n = prevType === 'number' && (b.indent || 0) === prevInd ? n + 1 : (prevType === 'number' && (b.indent || 0) > prevInd ? 1 : prevType === 'number' ? n + 1 : 1);
    prevType = b.type;
    prevInd = b.indent || 0;
    return blockHtml(b, n);
  }).join('');
}
const blockIndex = (id) => TK.page.blocks.findIndex((b) => b.id === id);
const blockEl = (id) => document.querySelector(`#pgBlocks .blk[data-id="${id}"]`);
const textEl = (id) => blockEl(id)?.querySelector('.blk-text');

/* каретка */
function caretOffset(el) {
  const sel = getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) return 0;
  const r = sel.getRangeAt(0);
  const pre = r.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}
function setCaret(el, pos = 'end') {
  if (!el) return;
  el.focus({ preventScroll: false });
  const sel = getSelection();
  const r = document.createRange();
  if (pos === 'end' || pos == null) { r.selectNodeContents(el); r.collapse(false); }
  else if (pos === 0) { r.selectNodeContents(el); r.collapse(true); }
  else {
    let left = pos;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    let placed = false;
    while ((node = w.nextNode())) {
      if (left <= node.length) { r.setStart(node, left); r.collapse(true); placed = true; break; }
      left -= node.length;
    }
    if (!placed) { r.selectNodeContents(el); r.collapse(false); }
  }
  sel.removeAllRanges();
  sel.addRange(r);
  el.closest('.blk')?.scrollIntoView({ block: 'nearest' });
}
function splitHtml(el) {
  const sel = getSelection();
  const r = sel.getRangeAt(0);
  r.deleteContents();
  const a = document.createRange();
  a.selectNodeContents(el);
  a.setEnd(r.startContainer, r.startOffset);
  const z = document.createRange();
  z.selectNodeContents(el);
  z.setStart(r.startContainer, r.startOffset);
  const d1 = document.createElement('div'); d1.appendChild(a.cloneContents());
  const d2 = document.createElement('div'); d2.appendChild(z.cloneContents());
  return [d1.innerHTML, d2.innerHTML];
}
const htmlOf = (el, type) => (type === 'code' ? esc(el.textContent) : cleanInline(el.innerHTML));

/* збереження */
function markDirty() {
  TK.dirty = true;
  const s = document.getElementById('pgSaved');
  if (s) s.textContent = '…';
  clearTimeout(TK.saveTimer);
  TK.saveTimer = setTimeout(() => flushSave(), 700);
}
async function flushSave() {
  clearTimeout(TK.saveTimer);
  if (!TK.dirty || !TK.page) return;
  if (TK.saving) { await TK.saving; return flushSave(); }
  TK.dirty = false;
  const p = TK.page;
  const body = { title: p.title, blocks: p.blocks };
  TK.saving = api('/pages/' + p.id, { method: 'PATCH', body }).then((upd) => {
    // зберігаємо локальні id/вміст; підтягуємо лише прапорці
    if (TK.page && TK.page.id === upd.id) { TK.page.updated_at = upd.updated_at; TK.page.children = upd.children; }
    const s = document.getElementById('pgSaved');
    if (s && !TK.dirty) s.textContent = 'Збережено';
  }).catch((e) => { TK.dirty = true; toast('Не зберіглося: ' + e.message); }).finally(() => { TK.saving = false; });
  await TK.saving;
}
async function patchPage(patch) {
  await flushSave();
  try {
    const upd = await api('/pages/' + TK.page.id, { method: 'PATCH', body: patch });
    if (upd.assignee_invite) showInvite(upd);
    const blocks = TK.page.blocks;
    TK.page = { ...upd, blocks };
    const scroll = document.getElementById('pgScroll')?.scrollTop;
    drawPage(pageShell());
    if (scroll) document.getElementById('pgScroll').scrollTop = scroll;
    if (patch.status === 'done') confettiAt(document.querySelector('.pp[data-prop=status]') || document.body);
  } catch (e) { toast(e.message); }
}

/* операції з блоками */
function insertBlock(after, block, focus = 0) {
  const i = after == null ? TK.page.blocks.length - 1 : blockIndex(after);
  TK.page.blocks.splice(i + 1, 0, block);
  renderBlocks();
  markDirty();
  if (focus !== false) setCaret(textEl(block.id), focus);
  return block;
}
function setType(id, type, keepFocus = true) {
  const b = TK.page.blocks[blockIndex(id)];
  if (!b) return;
  if (type === 'divider') {
    b.type = 'divider';
    delete b.text;
    renderBlocks();
    markDirty();
    const i = blockIndex(id);
    const next = TK.page.blocks[i + 1];
    if (next && next.type !== 'divider' && next.type !== 'page') setCaret(textEl(next.id), 0);
    else insertBlock(id, { id: uid(), type: 'p', text: '' });
    return;
  }
  b.type = type;
  if (type === 'todo') b.checked = Boolean(b.checked);
  if (type === 'callout') b.icon ||= '💡';
  if (type === 'toggle') { b.open = true; b.body ||= ''; }
  if (type === 'code') b.text = esc(textOf(b.text));
  renderBlocks();
  markDirty();
  if (keepFocus) setCaret(textEl(id), 'end');
}
async function createChildPage(blockId) {
  try {
    await flushSave();
    const child = await api('/pages', { method: 'POST', body: { kind: 'page', parent_id: TK.page.id, title: '' } });
    const b = TK.page.blocks[blockIndex(blockId)];
    const nb = { id: uid(), type: 'page', page_id: child.id };
    if (b && b.type !== 'page' && b.type !== 'divider' && !textOf(b.text).trim()) Object.assign(b, nb, { id: b.id }), delete b.text;
    else TK.page.blocks.splice(blockIndex(blockId) + 1, 0, nb);
    TK.page.children = [...(TK.page.children || []), child];
    TK.dirty = true;
    await flushSave();
    goChild(child.id, true);
  } catch (e) { toast(e.message); }
}
function removeBlock(id, focusPrev = true) {
  const i = blockIndex(id);
  if (i < 0) return;
  TK.page.blocks.splice(i, 1);
  if (!TK.page.blocks.length) TK.page.blocks.push({ id: uid(), type: 'p', text: '' });
  renderBlocks();
  markDirty();
  if (focusPrev) {
    const prev = TK.page.blocks[Math.max(0, i - 1)];
    setCaret(textEl(prev.id), 'end');
  }
}
function moveBlock(id, d) {
  const i = blockIndex(id);
  const j = i + d;
  if (i < 0 || j < 0 || j >= TK.page.blocks.length) return;
  const [b] = TK.page.blocks.splice(i, 1);
  TK.page.blocks.splice(j, 0, b);
  renderBlocks();
  markDirty();
  setCaret(textEl(id), 'end');
}
function indentBlock(id, d) {
  const b = TK.page.blocks[blockIndex(id)];
  if (!b) return;
  const off = textEl(id) ? caretOffset(textEl(id)) : 0;
  b.indent = Math.max(0, Math.min(3, (b.indent || 0) + d));
  if (!b.indent) delete b.indent;
  renderBlocks();
  markDirty();
  setCaret(textEl(id), off);
}

/* слеш-меню */
let slash = null;
function showSlash(id, query) {
  const items = BLOCK_MENU.filter((m) => !query || m.name.toLowerCase().includes(query) || m.keys.includes(query));
  if (!items.length) return hideSlash();
  let box = document.getElementById('slashMenu');
  if (!box) {
    box = document.createElement('div');
    box.id = 'slashMenu';
    box.className = 'slash';
    document.body.appendChild(box);
    box.addEventListener('pointerdown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      const it = e.target.closest('[data-type]');
      if (it) applySlash(it.dataset.type);
    });
  }
  slash = { id, query, items, i: Math.min(slash?.id === id ? slash.i : 0, items.length - 1) };
  box.innerHTML = `<div class="slash-h">Блоки</div>${items.map((m, k) => `<button class="slash-it ${k === slash.i ? 'on' : ''}" data-type="${m.type}"><span class="slash-ic">${m.icon}</span><span><b>${m.name}</b><small>${esc(m.hint)}</small></span></button>`).join('')}`;
  const el = textEl(id);
  const r = el.getBoundingClientRect();
  const vv = window.visualViewport;
  const vh = vv ? vv.height + vv.offsetTop : window.innerHeight;
  box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 268))}px`;
  const below = r.bottom + 6;
  box.style.top = below + 280 > vh ? `${Math.max(8, r.top - 286)}px` : `${below}px`;
  box.classList.remove('hidden');
  box.querySelector('.slash-it.on')?.scrollIntoView({ block: 'nearest' });
}
function hideSlash() { slash = null; document.getElementById('slashMenu')?.classList.add('hidden'); }
function applySlash(type) {
  if (!slash) return;
  const { id } = slash;
  const el = textEl(id);
  const b = TK.page.blocks[blockIndex(id)];
  hideSlash();
  if (!el || !b) return;
  // прибираємо «/запит» з тексту
  const txt = el.innerHTML.replace(/\/[^/<>\s]*(\s|&nbsp;)?$/, '').replace(/\/([\p{L}\d]*)(?=<\/[a-z]+>$)/u, '');
  b.text = cleanInline(txt);
  if (type === 'page') return createChildPage(id);
  if (!textOf(b.text).trim() || b.type === 'p') return setType(id, type);
  // у непорожньому блоці (не абзаці) — новий блок нижче
  insertBlock(id, { id: uid(), type, text: '', ...(type === 'todo' ? { checked: false } : {}) });
  if (type === 'divider') setType(TK.page.blocks[blockIndex(id) + 1].id, 'divider');
}

/* панель форматування виділення */
function showFmt() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return hideFmt();
  const r = sel.getRangeAt(0);
  const host = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
  const txt = host?.closest('.blk-text, .blk-body');
  if (!txt || txt.closest('.blk-code')) return hideFmt();
  let bar = document.getElementById('fmtBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'fmtBar';
    bar.className = 'fmt';
    bar.innerHTML = '<button data-f="bold"><b>B</b></button><button data-f="italic"><i>I</i></button><button data-f="underline"><u>U</u></button><button data-f="strike"><s>S</s></button><button data-f="code">&lt;/&gt;</button><button data-f="mark">🖍</button><button data-f="link">🔗</button>';
    document.body.appendChild(bar);
    bar.addEventListener('pointerdown', (e) => e.preventDefault());
    bar.addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (b) fmt(b.dataset.f); });
  }
  const rect = r.getBoundingClientRect();
  if (!rect.width && !rect.height) return hideFmt();
  bar.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - 140, window.innerWidth - 288))}px`;
  bar.style.top = `${Math.max(8, rect.top - 46)}px`;
  bar.classList.remove('hidden');
}
function hideFmt() { document.getElementById('fmtBar')?.classList.add('hidden'); }
function wrapSelection(tag) {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const r = sel.getRangeAt(0);
  const host = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
  const existing = host.closest(tag);
  if (existing) { existing.replaceWith(...existing.childNodes); return; }
  const w = document.createElement(tag);
  w.appendChild(r.extractContents());
  r.insertNode(w);
  sel.removeAllRanges();
  const nr = document.createRange();
  nr.selectNodeContents(w);
  sel.addRange(nr);
}
function fmt(f) {
  const sel = getSelection();
  const host = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
  const txt = host?.closest('.blk-text, .blk-body');
  if (!txt) return;
  if (f === 'bold' || f === 'italic' || f === 'underline') document.execCommand(f);
  if (f === 'strike') document.execCommand('strikeThrough');
  if (f === 'code') wrapSelection('code');
  if (f === 'mark') wrapSelection('mark');
  if (f === 'link') {
    const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const anchorA = host.closest('a');
    linkPrompt(anchorA?.getAttribute('href') || '', (url) => {
      if (!range) return;
      sel.removeAllRanges();
      sel.addRange(range);
      if (!url) { if (anchorA) anchorA.replaceWith(...anchorA.childNodes); else document.execCommand('unlink'); }
      else {
        const u = /^(https?:|mailto:|tg:)/i.test(url) ? url : `https://${url}`;
        if (range.collapsed) document.execCommand('insertHTML', false, `<a href="${esc(u)}">${esc(url)}</a>`);
        else document.execCommand('createLink', false, u);
      }
      txt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return;
  }
  txt.dispatchEvent(new Event('input', { bubbles: true }));
  setTimeout(showFmt, 0);
}
function linkPrompt(value, done) {
  const box = picker({ title: 'Посилання', items: [], extra: `<form class="pk-link"><input type="url" inputmode="url" placeholder="https://…" value="${esc(value)}"><button class="chip on">OK</button>${value ? '<button type="button" class="chip" data-x="rm">Прибрати</button>' : ''}</form>` });
  const form = box.querySelector('form');
  const inp = form.querySelector('input');
  setTimeout(() => inp.focus(), 30);
  form.onsubmit = (e) => { e.preventDefault(); closePicker(); done(inp.value.trim()); };
  form.querySelector('[data-x=rm]')?.addEventListener('click', () => { closePicker(); done(''); });
}

/* меню блоку (⋮⋮) */
function blockMenu(id, anchor) {
  const b = TK.page.blocks[blockIndex(id)];
  if (!b) return;
  picker({
    title: 'Блок', anchor,
    items: [
      { id: 'turn', label: 'Перетворити на…', html: '↻ Перетворити на…' },
      { id: 'dup', label: 'Дублювати', html: '⧉ Дублювати' },
      { id: 'up', label: 'Вгору', html: '↑ Вгору' },
      { id: 'down', label: 'Вниз', html: '↓ Вниз' },
      { id: 'indent', label: 'Відступ', html: '⇥ Збільшити відступ' },
      { id: 'outdent', label: 'Прибрати відступ', html: '⇤ Зменшити відступ' },
      { id: 'task', label: 'Зробити задачею', html: '📝 Винести в окрему задачу' },
      { id: 'del', label: 'Видалити', html: '<span class="minus">🗑 Видалити</span>' },
    ].filter((x) => (x.id !== 'task' || (b.text && textOf(b.text).trim())) && (x.id !== 'turn' || (b.type !== 'divider' && b.type !== 'page'))),
    onPick: (v) => {
      if (v === 'turn') return picker({ title: 'Перетворити на', items: BLOCK_MENU.filter((m) => m.type !== 'page' && m.type !== 'divider').map((m) => ({ id: m.type, label: m.name, html: `<span class="slash-ic sm">${m.icon}</span> ${m.name}` })), value: b.type, onPick: (t) => setType(id, t) });
      if (v === 'dup') return insertBlock(id, { ...structuredClone(b), id: uid() }, 'end');
      if (v === 'up') return moveBlock(id, -1);
      if (v === 'down') return moveBlock(id, 1);
      if (v === 'indent') return indentBlock(id, 1);
      if (v === 'outdent') return indentBlock(id, -1);
      if (v === 'del') return removeBlock(id);
      if (v === 'task') return safe(async () => {
        const t = await api('/pages', { method: 'POST', body: { kind: 'task', status: 'todo', title: textOf(b.text).trim().slice(0, 300), project_id: TK.page.project_id || null, parent_id: TK.page.id } });
        Object.assign(b, { type: 'page', page_id: t.id });
        delete b.text;
        TK.page.children = [...(TK.page.children || []), t];
        renderBlocks();
        markDirty();
        toast('Задачу створено');
      });
    },
  });
}

/* перетягування блоків за ⋮⋮ */
function blockDrag(handle, e) {
  const blk = handle.closest('.blk');
  const id = blk.dataset.id;
  const sx = e.clientX;
  const sy = e.clientY;
  let dragging = false;
  let line = null;
  let target = null;
  const onMove = (ev) => {
    if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) {
      dragging = true;
      blk.classList.add('dragging');
      line = document.createElement('div');
      line.className = 'blk-drop';
      document.getElementById('pgBlocks').appendChild(line);
    }
    if (!dragging) return;
    ev.preventDefault();
    const els = [...document.querySelectorAll('#pgBlocks .blk')];
    const box = document.getElementById('pgBlocks').getBoundingClientRect();
    target = els.find((x) => ev.clientY < x.getBoundingClientRect().top + x.offsetHeight / 2) || null;
    const y = target ? target.getBoundingClientRect().top : els[els.length - 1].getBoundingClientRect().bottom;
    line.style.top = `${y - box.top - 1}px`;
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    blk.classList.remove('dragging');
    line?.remove();
    if (!dragging) return blockMenu(id, handle);
    const from = blockIndex(id);
    const [b] = TK.page.blocks.splice(from, 1);
    let to = target ? blockIndex(target.dataset.id) : TK.page.blocks.length;
    if (to < 0) to = TK.page.blocks.length;
    TK.page.blocks.splice(to, 0, b);
    renderBlocks();
    markDirty();
  };
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
}

/* ───────── події редактора ───────── */
function currentBlockId() {
  const a = document.activeElement;
  return a?.closest?.('#pgBlocks .blk')?.dataset.id || TK.lastBlock || null;
}
function wirePage(el) {
  const ro = !canWritePages();
  const title = el.querySelector('.pg-title');
  if (!ro) {
    title.addEventListener('input', () => { TK.page.title = title.textContent.replace(/\s+/g, ' ').trim(); markDirty(); const c = el.querySelector('.pg-crumbs > span'); if (c) c.textContent = `${TK.page.icon || (TK.page.kind === 'task' ? '📝' : '📄')} ${TK.page.title || 'Без назви'}`; });
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = TK.page.blocks[0];
        if (first && first.type === 'p' && !textOf(first.text).trim()) setCaret(textEl(first.id), 0);
        else { TK.page.blocks.unshift({ id: uid(), type: 'p', text: '' }); renderBlocks(); markDirty(); setCaret(textEl(TK.page.blocks[0].id), 0); }
      }
    });
    title.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\s+/g, ' ')); });
  }
  const blocks = el.querySelector('#pgBlocks');
  blocks.addEventListener('input', (e) => {
    const t = e.target.closest('.blk-text, .blk-body');
    if (!t) return;
    const id = t.closest('.blk').dataset.id;
    const b = TK.page.blocks[blockIndex(id)];
    if (!b) return;
    if (t.classList.contains('blk-body')) { b.body = cleanInline(t.innerHTML); markDirty(); return; }
    b.text = htmlOf(t, b.type);
    markDirty();
    if (b.type === 'code') return;
    const plainTxt = t.textContent.replace(/ /g, ' ');
    // markdown-скорочення: «# », «- », «[] », «> », «---» …
    if (b.type === 'p') {
      const md = [[/^###\s/, 'h3'], [/^##\s/, 'h2'], [/^#\s/, 'h1'], [/^[-*]\s/, 'bullet'], [/^1[.)]\s/, 'number'], [/^\[[\sx]?\]\s/i, 'todo'], [/^>\s/, 'quote'], [/^\+\s/, 'toggle'], [/^```$/, 'code'], [/^---$/, 'divider']];
      for (const [re, type] of md) {
        const hit = plainTxt.match(re);
        if (!hit) continue;
        const checked = /^\[x\]/i.test(plainTxt);
        const rest = document.createElement('div');
        rest.innerHTML = t.innerHTML;
        // відрізаємо префікс з першого текстового вузла
        let left = hit[0].length;
        const w = document.createTreeWalker(rest, NodeFilter.SHOW_TEXT);
        let node;
        while (left > 0 && (node = w.nextNode())) {
          const cut = Math.min(left, node.length);
          node.textContent = node.textContent.slice(cut);
          left -= cut;
        }
        b.text = cleanInline(rest.innerHTML);
        if (type === 'todo') b.checked = checked;
        setType(id, type, false);
        if (type !== 'divider') setCaret(textEl(id), 0);
        return;
      }
    }
    const m = plainTxt.slice(0, caretOffset(t)).match(/(?:^|\s)\/([\p{L}\d]{0,20})$/u);
    if (m) showSlash(id, m[1].toLowerCase()); else hideSlash();
  });
  blocks.addEventListener('beforeinput', (e) => {
    const t = e.target.closest?.('.blk-text');
    if (!t) return;
    const id = t.closest('.blk').dataset.id;
    const b = TK.page.blocks[blockIndex(id)];
    if (!b) return;
    if (e.inputType === 'insertParagraph') {
      if (b.type === 'code') return; // Enter у коді — новий рядок
      e.preventDefault();
      if (slash) return applySlash(slash.items[slash.i].type);
      const empty = !t.textContent.replace(/ /g, ' ').trim();
      if (empty && (isListType(b.type) || b.type === 'quote' || b.type === 'callout' || b.type === 'toggle')) {
        if (b.indent) return indentBlock(id, -1);
        return setType(id, 'p');
      }
      const [before, after] = splitHtml(t);
      b.text = cleanInline(before);
      t.innerHTML = b.text;
      const type = isListType(b.type) ? b.type : 'p';
      const nb = { id: uid(), type, text: cleanInline(after) };
      if (type === 'todo') nb.checked = false;
      if (b.indent && isListType(type)) nb.indent = b.indent;
      return insertBlock(id, nb, 0);
    }
    if (e.inputType === 'deleteContentBackward') {
      const sel = getSelection();
      if (!sel.isCollapsed || caretOffset(t) !== 0) return;
      e.preventDefault();
      if (b.type !== 'p') return setType(id, 'p');
      if (b.indent) return indentBlock(id, -1);
      const i = blockIndex(id);
      if (i === 0) {
        if (!textOf(b.text).trim() && TK.page.blocks.length > 1) removeBlock(id, false), setCaret(textEl(TK.page.blocks[0].id), 0);
        else setCaret(title, 'end');
        return;
      }
      const prev = TK.page.blocks[i - 1];
      if (prev.type === 'divider' || prev.type === 'page') { TK.page.blocks.splice(i - 1, 1); renderBlocks(); markDirty(); return setCaret(textEl(id), 0); }
      const prevLen = textOf(prev.text).length;
      prev.text = cleanInline((prev.text || '') + (b.text || ''));
      TK.page.blocks.splice(i, 1);
      renderBlocks();
      markDirty();
      return setCaret(textEl(prev.id), prevLen);
    }
  });
  blocks.addEventListener('keydown', (e) => {
    const t = e.target.closest?.('.blk-text');
    if (!t) return;
    const id = t.closest('.blk').dataset.id;
    if (slash) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        slash.i = (slash.i + (e.key === 'ArrowDown' ? 1 : -1) + slash.items.length) % slash.items.length;
        return showSlash(slash.id, slash.query);
      }
      if (e.key === 'Escape') return hideSlash();
      if (e.key === 'Enter') { e.preventDefault(); return applySlash(slash.items[slash.i].type); }
    }
    if (e.key === 'Tab') { e.preventDefault(); return indentBlock(id, e.shiftKey ? -1 : 1); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return fmt('link'); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      const b = TK.page.blocks[blockIndex(id)];
      if (b?.type === 'todo') { e.preventDefault(); b.checked = !b.checked; renderBlocks(); markDirty(); return setCaret(textEl(id), 'end'); }
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); return moveBlock(id, e.key === 'ArrowUp' ? -1 : 1); }
    const nav = (d) => {
      let i = blockIndex(id) + d;
      while (TK.page.blocks[i] && !textEl(TK.page.blocks[i].id)) i += d;
      const n = TK.page.blocks[i];
      if (n) { e.preventDefault(); setCaret(textEl(n.id), d < 0 ? 'end' : 0); }
      else if (d < 0) { e.preventDefault(); setCaret(title, 'end'); }
    };
    if (e.key === 'ArrowUp' && caretOffset(t) === 0) return nav(-1);
    if (e.key === 'ArrowDown' && caretOffset(t) === t.textContent.length) return nav(1);
    // запасний варіант для старих WebView без beforeinput
    if (e.key === 'Enter' && !e.shiftKey && !('onbeforeinput' in t)) {
      e.preventDefault();
      t.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true }));
    }
  });
  blocks.addEventListener('paste', (e) => {
    const t = e.target.closest('.blk-text, .blk-body');
    if (!t) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain') || '';
    const id = t.closest('.blk').dataset.id;
    const b = TK.page.blocks[blockIndex(id)];
    const lines = text.replace(/\r/g, '').split('\n');
    if (lines.length < 2 || b.type === 'code' || t.classList.contains('blk-body')) {
      document.execCommand('insertText', false, text);
      return;
    }
    // багаторядкова вставка — кожен рядок окремим блоком з розпізнаванням markdown
    document.execCommand('insertText', false, lines[0]);
    let last = id;
    lines.slice(1).forEach((ln) => {
      let type = isListType(b.type) ? b.type : 'p';
      let txt = ln;
      const md = [[/^#{3}\s/, 'h3'], [/^#{2}\s/, 'h2'], [/^#\s/, 'h1'], [/^[-*•]\s/, 'bullet'], [/^\d+[.)]\s/, 'number'], [/^\[\s?\]\s/, 'todo'], [/^>\s/, 'quote']];
      for (const [re, tp] of md) if (re.test(ln)) { type = tp; txt = ln.replace(re, ''); break; }
      if (/^-{3,}$/.test(ln.trim())) { const nb = { id: uid(), type: 'divider' }; TK.page.blocks.splice(blockIndex(last) + 1, 0, nb); last = nb.id; return; }
      const nb = { id: uid(), type, text: esc(txt), ...(type === 'todo' ? { checked: false } : {}) };
      TK.page.blocks.splice(blockIndex(last) + 1, 0, nb);
      last = nb.id;
    });
    b.text = htmlOf(t, b.type);
    renderBlocks();
    markDirty();
    setCaret(textEl(last), 'end');
  });
  blocks.addEventListener('focusin', (e) => {
    const blk = e.target.closest('.blk');
    if (blk) TK.lastBlock = blk.dataset.id;
    if (!ro && e.target.closest('.blk-text, .blk-body') && matchMedia('(pointer: coarse)').matches) showKbar();
  });
  blocks.addEventListener('focusout', () => setTimeout(() => { if (!document.activeElement?.closest?.('#pgBlocks, .pg-title')) { hideKbar(); hideSlash(); } }, 120));
  blocks.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.blk-h');
    if (h) { e.preventDefault(); blockDrag(h, e); }
  });
  // клік у порожнє місце під блоками — фокус в останній
  el.querySelector('.pg-inner').addEventListener('click', (e) => {
    if (ro || e.target !== e.currentTarget) return;
    const last = TK.page.blocks[TK.page.blocks.length - 1];
    if (last && textEl(last.id) && !textOf(last.text).trim()) setCaret(textEl(last.id), 'end');
  });
  el.querySelector('#pgKbar').addEventListener('pointerdown', (e) => e.preventDefault());
  el.querySelector('#pgKbar').addEventListener('click', (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (!k) return;
    const id = currentBlockId();
    if (k === 'hide') { document.activeElement?.blur(); return hideKbar(); }
    if (['bold', 'italic', 'strike', 'link'].includes(k)) return fmt(k);
    if (!id) return;
    if (k === 'plus') {
      const t = textEl(id);
      if (t) { t.focus(); slash = null; return showSlash(id, ''); }
    }
    if (k === 'todo' || k === 'bullet' || k === 'h2') { const b = TK.page.blocks[blockIndex(id)]; return setType(id, b.type === k ? 'p' : k); }
    if (k === 'indent') return indentBlock(id, 1);
    if (k === 'outdent') return indentBlock(id, -1);
    if (k === 'up') return moveBlock(id, -1);
    if (k === 'down') return moveBlock(id, 1);
  });
  const cm = el.querySelector('#cmText');
  if (cm) {
    cm.addEventListener('input', () => { cm.style.height = 'auto'; cm.style.height = `${Math.min(cm.scrollHeight, 140)}px`; });
    cm.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) el.querySelector('[data-pg=cm-send]').click(); });
  }
}

/* клавіатурна панель на телефоні — тримаємо над екранною клавіатурою */
function placeKbar() {
  const bar = document.getElementById('pgKbar');
  const vv = window.visualViewport;
  if (!bar || !vv) return;
  bar.style.bottom = `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`;
}
function showKbar() { const b = document.getElementById('pgKbar'); if (b) { b.classList.remove('hidden'); placeKbar(); } }
function hideKbar() { document.getElementById('pgKbar')?.classList.add('hidden'); }
window.visualViewport?.addEventListener('resize', placeKbar);
window.visualViewport?.addEventListener('scroll', placeKbar);
document.addEventListener('selectionchange', () => {
  if (!TK.page) return;
  clearTimeout(TK.fmtT);
  TK.fmtT = setTimeout(showFmt, 120);
});

/* кліки всередині сторінки */
document.addEventListener('click', async (e) => {
  const pg = e.target.closest('#pageView');
  if (!pg) return;
  const btn = e.target.closest('[data-pg]');
  const prop = e.target.closest('.pp[data-prop]');
  if (prop && canWritePages()) return propPicker(prop.dataset.prop, TK.page, prop, (patch, keep) => {
    if (keep) {
      Object.assign(TK.page, patch);
      prop.querySelector('.pp-v').innerHTML = tagPills(patch.tags) || '<span class="ph">Порожньо</span>';
      clearTimeout(TK.tagT);
      TK.tagT = setTimeout(() => api('/pages/' + TK.page.id, { method: 'PATCH', body: { tags: TK.page.tags } }).catch((er) => toast(er.message)), 400);
      return;
    }
    patchPage(patch);
  });
  if (!btn) return;
  const a = btn.dataset.pg;
  const id = btn.closest('.blk')?.dataset.id;
  if (a === 'back') return pageBack();
  if (a === 'crumb') {
    const cid = Number(btn.dataset.v);
    const crumbs = TK.page.crumbs || [];
    TK.navStack = crumbs.slice(0, crumbs.findIndex((c) => c.id === cid)).map((c) => c.id);
    return openPage(cid, { back: true });
  }
  if (a === 'child') { e.preventDefault(); return goChild(Number(btn.dataset.v)); }
  if (a === 'check' && canWritePages()) {
    const b = TK.page.blocks[blockIndex(id)];
    b.checked = !b.checked;
    btn.classList.toggle('on', b.checked);
    btn.textContent = b.checked ? '✓' : '';
    btn.closest('.blk').classList.toggle('is-checked', b.checked);
    if (b.checked) { navigator.vibrate?.(6); try { tgWebApp()?.HapticFeedback?.selectionChanged(); } catch {} }
    return markDirty();
  }
  if (a === 'toggle') {
    const b = TK.page.blocks[blockIndex(id)];
    b.open = !b.open;
    renderBlocks();
    if (canWritePages()) markDirty();
    return;
  }
  if (a === 'callout-icon' && canWritePages()) return iconPicker((ic) => { const b = TK.page.blocks[blockIndex(id)]; b.icon = ic || '💡'; renderBlocks(); markDirty(); }, btn);
  if (a === 'add-end') {
    const last = TK.page.blocks[TK.page.blocks.length - 1];
    if (last && textEl(last.id) && !textOf(last.text).trim()) { setCaret(textEl(last.id), 0); slash = null; return showSlash(last.id, ''); }
    const nb = insertBlock(last?.id, { id: uid(), type: 'p', text: '' });
    return showSlash(nb.id, '');
  }
  if (a === 'icon' && canWritePages()) return iconPicker((ic) => patchPage({ icon: ic }), btn);
  if (a === 'cover' && canWritePages()) {
    return picker({ title: 'Обкладинка', anchor: btn, value: TK.page.cover || '', items: [...TK.meta.covers.map((c) => ({ id: c, label: c, html: `<span class="cov-sw" style="background:${COVER_BG[c]}"></span>` })), { id: '', label: 'Без обкладинки', html: '<span class="ph">Прибрати обкладинку</span>' }], onPick: (v) => patchPage({ cover: v || null }) });
  }
  if (a === 'menu') return pageMenu(btn);
  if (a === 'cm-send') {
    const ta = document.getElementById('cmText');
    const text = ta.value.trim();
    if (!text) return;
    ta.disabled = true;
    try {
      await flushSave();
      await api(`/pages/${TK.page.id}/comments`, { method: 'POST', body: { text } });
      const fresh = await api('/pages/' + TK.page.id);
      TK.page.comments_list = fresh.comments_list;
      drawPage(pageShell());
      const sc = document.getElementById('pgScroll');
      sc.scrollTop = sc.scrollHeight;
    } catch (err) { toast(err.message); ta.disabled = false; }
    return;
  }
  if (a === 'cm-del') {
    if (!(await ask('Видалити коментар?'))) return;
    await safe(async () => {
      await api('/comments/' + btn.dataset.v, { method: 'DELETE' });
      TK.page.comments_list = TK.page.comments_list.filter((c) => String(c.id) !== btn.dataset.v);
      drawPage(pageShell());
    });
  }
});

/** Відповідальний ще не в боті — даємо посилання, яке треба йому переслати. */
function showInvite(p) {
  const text = `Привіт! Тобі призначили задачу «${p.title || 'Без назви'}» у King Kong Lab. Відкрий, щоб бачити її та отримувати сповіщення: ${p.assignee_invite}`;
  const box = picker({ title: `${p.assignee_name || 'Людина'} ще не в боті`, items: [], extra: `<div class="pk-inv"><p>Перешли посилання — людина побачить задачу і отримуватиме сповіщення. Доступу до бухгалтерії воно не дає.</p>
    <div class="invite__link">${esc(p.assignee_invite)}</div>
    <div class="btns"><button class="btn ghost" data-x="copy">Копіювати</button><button class="btn" data-x="share">Надіслати в Telegram</button></div></div>` });
  box.querySelector('[data-x=copy]').onclick = () => safe(async () => { await navigator.clipboard.writeText(text); toast('Скопійовано'); closePicker(); });
  box.querySelector('[data-x=share]').onclick = () => {
    const url = `https://t.me/share/url?url=${encodeURIComponent(p.assignee_invite)}&text=${encodeURIComponent(`Тобі призначили задачу «${p.title || 'Без назви'}» у King Kong Lab`)}`;
    const tg = tgWebApp();
    if (tg?.openTelegramLink) tg.openTelegramLink(url); else window.open(url, '_blank');
    closePicker();
  };
}

function iconPicker(onPick, anchor) {
  const box = picker({ title: 'Іконка', anchor, items: [], extra: `<div class="emo">${EMOJIS.map((e) => `<button data-e="${e}">${e}</button>`).join('')}</div><button class="chip emo-rm" data-e="">Прибрати іконку</button>` });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-e]');
    if (!b) return;
    closePicker();
    onPick(b.dataset.e || null);
  });
}

function pageMenu(anchor) {
  const p = TK.page;
  const link = (() => {
    const bot = TK.bot || 'KKLabSystemBot';
    return `https://t.me/${bot}?startapp=page_${p.id}`;
  })();
  picker({
    title: p.kind === 'task' ? 'Задача' : 'Сторінка', anchor,
    items: [
      { id: 'link', label: 'Копіювати посилання', html: '🔗 Копіювати посилання' },
      ...(canWritePages() ? [
        { id: 'dup', label: 'Дублювати', html: '⧉ Дублювати' },
        { id: 'kind', label: 'Тип', html: p.kind === 'task' ? '📄 Зробити звичайною сторінкою' : '📝 Зробити задачею' },
        { id: 'move', label: 'Перемістити', html: '↪ Перемістити в…' },
        { id: 'del', label: 'Видалити', html: '<span class="minus">🗑 У кошик</span>' },
      ] : []),
    ],
    onPick: (v) => safe(async () => {
      if (v === 'link') { await navigator.clipboard.writeText(link); return toast('Посилання скопійовано'); }
      if (v === 'dup') { await flushSave(); const c = await api(`/pages/${p.id}/duplicate`, { method: 'POST' }); toast('Створено копію'); return openPage(c.id); }
      if (v === 'kind') return patchPage(p.kind === 'task' ? { kind: 'page' } : { kind: 'task', status: p.status || 'todo' });
      if (v === 'move') {
        const pages = await api('/pages?kind=page');
        return picker({ title: 'Перемістити в', search: true, value: p.parent_id || '', items: [{ id: '', label: 'На верхній рівень', html: '⤒ На верхній рівень' }, ...pages.filter((x) => x.id !== p.id).map((x) => ({ id: x.id, label: x.title || 'Без назви', html: `${esc(x.icon || '📄')} ${esc(x.title || 'Без назви')}` }))], onPick: (pid) => patchPage({ parent_id: pid || null }) });
      }
      if (v === 'del') {
        if (!(await ask(p.children?.length ? 'Перемістити в кошик разом із вкладеними сторінками?' : 'Перемістити в кошик?'))) return;
        TK.dirty = false;
        await api('/pages/' + p.id, { method: 'DELETE' });
        toast('У кошику · можна відновити в «Сторінки → Кошик»');
        return closePage();
      }
    }),
  });
}

/* ═══════════════ Інтеграція з рештою застосунку ═══════════════ */
screens.tasks = renderTasks;

// віджет «Мої задачі» на дашборді
const _renderDash = screens.dash;
screens.dash = async () => {
  await _renderDash();
  try {
    await tkMeta();
    const mine = await api('/pages?kind=task&assignee=me&open=1');
    const t = today();
    const hot = mine.filter((x) => x.due && x.due <= t);
    const v = view();
    const card = document.createElement('div');
    card.className = 'card tk-widget';
    card.dataset.tk = 'goto';
    card.innerHTML = `<div class="row"><b>📝 Мої задачі</b><span class="muted">${mine.length ? `${mine.length} відкрит${mine.length === 1 ? 'а' : 'их'}` : 'усе зроблено 🎉'} ›</span></div>
      ${mine.slice(0, 3).map((x) => `<div class="tkw-row" data-page="${x.id}">${stPill(x.status)}<span>${esc(x.title || 'Без назви')}</span>${x.due ? `<small class="${x.overdue ? 'late' : ''}">${esc(relDate(x.due))}</small>` : ''}</div>`).join('')}
      ${hot.length ? `<div class="tkw-hot">🔥 На сьогодні та прострочені: <b>${hot.length}</b></div>` : ''}`;
    const h1 = v.querySelector('h1');
    if (h1 && h1.textContent.includes('кабінет')) h1.after(card);
    else v.querySelector('.kpis')?.before(card) ?? v.prepend(card);
  } catch {}
};
document.body.addEventListener('click', (e) => {
  if (e.target.closest('[data-page]')) return;
  if (e.target.closest('.tk-widget')) { state.tk.who = 'me'; setTab('tasks'); }
});

// задачі проєкту — у картці проєкту (угоди)
const _openDeal = openDeal;
openDeal = async function openDealWithTasks(id) {
  await _openDeal(id);
  if (!id) return;
  try {
    await tkMeta();
    const rows = await api(`/pages?kind=task&project_id=${id}`);
    const form = document.getElementById('dealForm');
    if (!form) return;
    const sec = document.createElement('div');
    sec.className = 'card deal-tasks';
    const open = rows.filter((r) => r.status !== 'done').length;
    sec.innerHTML = `<div class="row"><b>📝 Задачі проєкту</b><span class="muted">${rows.length ? `${open} відкр. / ${rows.length}` : 'ще немає'}</span></div>
      ${rows.map((r) => `<div class="tkw-row" data-page="${r.id}">${stPill(r.status)}<span>${esc(r.title || 'Без назви')}</span>${avatar(r.assignee_name, 'sm')}</div>`).join('')}
      ${canWritePages() ? `<button type="button" class="chip" data-x="deal-task">＋ Задача для проєкту</button>` : ''}`;
    form.before(sec);
    sec.querySelector('[data-x=deal-task]')?.addEventListener('click', () => newPageFlow({ kind: 'task', project_id: id }));
  } catch {}
};

// пошук — показуємо й сторінки
const _runSearch = runSearch;
runSearch = async function runSearchWithPages(q) {
  await _runSearch(q);
  if (q.length < 2) return;
  try {
    const r = await api('/search?q=' + encodeURIComponent(q));
    if (!r.pages?.length) return;
    const box = $('searchResults').querySelector('.sheet') || $('searchResults');
    const div = document.createElement('div');
    div.innerHTML = `<h2>Задачі та сторінки</h2>${r.pages.map((p) => `<div class="tkw-row" data-page="${p.id}">${p.kind === 'task' ? stPill(p.status) : '📄'}<span>${esc(p.title || 'Без назви')}</span></div>`).join('')}`;
    box.prepend(div);
    if (!TK.meta) tkMeta().catch(() => {});
  } catch {}
};

// «+» по центру на вкладці задач створює задачу / сторінку
const _setTab = setTab;
setTab = function setTabWithTasks(tab) {
  if (tab === 'new' && state.tab === 'tasks') return newMenu(document.querySelector('.tabs .fab'));
  if (tab !== 'tasks') state.tk.q = '';
  if (tab !== 'new') document.body.classList.toggle('wide', tab === 'tasks');
  const r = _setTab(tab);
  if (tab !== 'new') document.getElementById('moreBtn')?.classList.toggle('on', tab === 'more');
  return r;
};

// глибокі посилання: ?page=12, ?tab=tasks, t.me/...?startapp=page_12
(function deepLinks() {
  const q = new URLSearchParams(location.search);
  const start = tgWebApp()?.initDataUnsafe?.start_param || q.get('tgWebAppStartParam') || '';
  const pageId = Number(q.get('page') || (start.match(/^page_(\d+)$/) || [])[1] || 0);
  const tab = q.get('tab') || (start === 'tasks' ? 'tasks' : '');
  if (!pageId && !tab) return;
  const wait = setInterval(() => {
    if (!state.me || !state.boot || document.getElementById('app').classList.contains('hidden')) return;
    clearInterval(wait);
    if (tab === 'tasks' || pageId) setTab('tasks');
    if (pageId) openPage(pageId);
  }, 150);
  setTimeout(() => clearInterval(wait), 20000);
})();
try { tgWebApp()?.disableVerticalSwipes?.(); } catch {}
document.getElementById('moreBtn')?.addEventListener('click', () => { if (TK.page) closePage(); setTab('more'); });
fetch('/api/launch').then((r) => r.json()).then((j) => { TK.bot = j.bot; }).catch(() => {});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
