function initDataFromHash() {
  try {
    const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    if (!raw) return '';
    return new URLSearchParams(raw).get('tgWebAppData') || '';
  } catch {
    return '';
  }
}

function tgWebApp() {
  return window.Telegram?.WebApp || null;
}

function tgInitData() {
  return tgWebApp()?.initData || initDataFromHash();
}

function inTelegram() {
  const tg = tgWebApp();
  return Boolean(
    tgInitData() ||
    tg?.initDataUnsafe?.user ||
    tg?.platform ||
    /Telegram/i.test(navigator.userAgent || '') ||
    location.hash.includes('tgWebAppData')
  );
}

function applyTelegramTheme() {
  const tg = tgWebApp();
  if (!tg) return;
  try { tg.ready(); tg.expand(); tg.setHeaderColor('#06051A'); tg.setBackgroundColor('#06051A'); } catch {}
}
applyTelegramTheme();

function readSession() {
  const q = new URLSearchParams(location.search).get('s');
  if (q) {
    localStorage.setItem('kk_sess', q);
    history.replaceState({}, '', location.pathname);
  }
  return q || localStorage.getItem('kk_sess') || '';
}
let session = readSession();

async function waitInitData(ms = 2500) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    applyTelegramTheme();
    const data = tgInitData();
    if (data) return data;
    await new Promise((r) => setTimeout(r, 80));
  }
  return tgInitData();
}

const SYM = { UAH: '₴', USD: '$', EUR: '€', USDT: '₮', PLN: 'zł', GBP: '£' };
const TYPE = { income: 'Дохід', expense: 'Витрата', transfer: 'Переказ' };
const PSTATUS = { lead: 'Лід', active: 'В роботі', paused: 'Пауза', done: 'Завершено', cancelled: 'Скасовано' };
const USTATUS = { pending: 'Очікує', active: 'Активний', blocked: 'Блок' };
const ROLES = { admin: 'Адмін', finance: 'Фінансист', member: 'Команда', viewer: 'Перегляд' };

const state = { me: null, boot: null, tab: 'dash', month: ymNow(), dash: null, tx: null, filters: { type: '', status: '' } };

function ymNow() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
}
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
}
function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
function shiftMonth(ym, d) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + d, 1)).toISOString().slice(0, 7);
}
function money(n, cur) {
  const v = (Number(n) || 0) / 100;
  const s = v.toLocaleString('uk-UA', { minimumFractionDigits: Math.abs(v % 1) > 0 ? 2 : 0, maximumFractionDigits: 2 });
  const sym = SYM[cur] || cur || '';
  return ['USD', 'EUR', 'GBP'].includes(cur) ? `${sym}${s}` : `${s} ${sym}`;
}
function signed(n, cur) {
  const cls = n > 0 ? 'plus' : n < 0 ? 'minus' : '';
  return `<span class="${cls}">${n < 0 ? '−' : n > 0 ? '+' : ''}${money(Math.abs(n), cur)}</span>`;
}
async function safe(fn) {
  try { await fn(); } catch (e) { toast(e.message || 'Помилка'); }
}
function dataJson(o) {
  return esc(JSON.stringify(o));
}
async function ask(text) {
  const tg = tgWebApp();
  if (tg?.showConfirm && tg.isVersionAtLeast?.('6.2')) return new Promise((r) => tg.showConfirm(text, r));
  return confirm(text);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(t) {
  const el = document.getElementById('toast');
  el.textContent = t;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

function authHeaders() {
  const headers = {};
  const init = tgInitData();
  if (init) headers.Authorization = `tma ${init}`;
  else if (session) headers.Authorization = `sess ${session}`;
  if (init && session) headers['X-KK-Session'] = session;
  else if (location.search.includes('dev=')) headers['x-dev-user'] = new URLSearchParams(location.search).get('dev');
  return headers;
}

async function api(path, opts = {}) {
  const headers = { ...authHeaders(), ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch('/api' + path, { ...opts, headers, body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body });
  if (res.status === 401 || res.status === 403) {
    const j = await res.json().catch(() => ({}));
    if (j.status === 'pending' || j.status === 'blocked' || res.status === 401) {
      showGate(j);
      throw new Error(j.error || 'Немає доступу');
    }
    throw new Error(j.error || 'Немає прав');
  }
  if (path.endsWith('.xlsx')) {
    if (!res.ok) throw new Error('Експорт не вдався');
    return res.blob();
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'Помилка');
  return j;
}

function showGate(j = {}) {
  $('app')?.classList.add('hidden');
  const g = $('gate');
  g.classList.remove('hidden');
  g.removeAttribute('hidden');
  if (j.loading) {
    $('openTg')?.classList.add('hidden');
    $('gateMsg').textContent = 'Відкриваємо бухгалтерію…';
  } else if (j.error) {
    $('openTg')?.classList.remove('hidden');
    $('gateMsg').textContent = j.error;
  }
}

function showApp() {
  const g = $('gate');
  g.classList.add('hidden');
  g.setAttribute('hidden', '');
  $('app').classList.remove('hidden');
}

const $ = (id) => document.getElementById(id);
const view = () => $('view');

function monthNav() {
  return `<div class="row" style="margin-bottom:12px">
    <button class="chip" data-act="mm" data-d="-1">‹</button>
    <b>${state.month}</b>
    <button class="chip" data-act="mm" data-d="1">›</button>
  </div>`;
}

function txRow(t) {
  const sign = t.type === 'income' ? 1 : t.type === 'expense' ? -1 : 0;
  return `<div class="tx" data-tx="${t.id}">
    <div class="dot">${esc(t.category_emoji || (t.type === 'transfer' ? '🔁' : '•'))}</div>
    <div>
      <div class="title">${esc(t.comment || t.category_name || TYPE[t.type])}</div>
      <div class="sub">${t.date} · ${esc(t.account_name || '')}${t.project_name ? ' · ' + esc(t.project_name) : ''}${t.status !== 'done' ? ' · ' + t.status : ''}</div>
    </div>
    <div class="amt">${signed(sign * t.amount, t.currency)}</div>
  </div>`;
}

async function renderDash() {
  state.dash = await api('/dashboard?month=' + state.month);
  const d = state.dash;
  const v = view();
  if (d.limited) {
    v.innerHTML = `${monthNav()}<div class="kpis">
      <div class="kpi wide"><div class="l">Мої виплати</div><div class="v">${money(d.payouts, d.base)}</div></div>
      <div class="kpi"><div class="l">За рік</div><div class="v">${money(d.yearPayouts, d.base)}</div></div>
      <div class="kpi"><div class="l">На перевірці</div><div class="v">${d.pending}</div></div>
    </div><h2>Останні</h2><div class="card">${d.recent.map(txRow).join('') || '<div class="empty">Поки порожньо</div>'}</div>`;
    return;
  }
  const series = d.series || [];
  const max = Math.max(1, ...series.map((s) => s.income + s.expense));
  const bars = series.map((s) => {
    const h = ((s.income + s.expense) / max) * 100;
    const exp = s.income + s.expense ? (s.expense / (s.income + s.expense)) * 100 : 0;
    return `<span title="${s.month}"><i style="height:${h}%"><i class="exp" style="height:${exp}%"></i></i></span>`;
  }).join('');
  v.innerHTML = `
    ${monthNav()}
    <div class="kpis">
      <div class="kpi wide"><div class="l">На рахунках · ${d.base}</div><div class="v">${money(d.balances.total, d.base)}</div></div>
      <div class="kpi"><div class="l">Доходи</div><div class="v plus">${money(d.current.income, d.base)}</div></div>
      <div class="kpi"><div class="l">Витрати</div><div class="v minus">${money(d.current.expense, d.base)}</div></div>
      <div class="kpi"><div class="l">Прибуток</div><div class="v">${signed(d.current.profit, d.base)}</div></div>
      <div class="kpi"><div class="l">Борг клієнтів</div><div class="v">${money(d.receivable, d.base)}</div></div>
    </div>
    <h2>12 місяців</h2>
    <div class="card"><div class="bars">${bars}</div><div class="muted">фіолет — доходи, рожевий — витрати</div></div>
    <h2>Рахунки</h2>
    <div class="accounts">${(d.balances?.accounts || []).map((a) => `<div class="acc"><div class="e">${a.emoji}</div><div class="n">${esc(a.name)}</div><div class="b">${money(a.balance, a.currency)}</div></div>`).join('') || '<div class="muted">Додай рахунок у Ще → Рахунки</div>'}</div>
    ${d.pendingCount ? `<div class="card row"><span>⏳ На перевірці</span><b>${d.pendingCount}</b></div>` : ''}
    <h2>Витрати за категоріями</h2>
    <div class="card">${(d.expenseByCategory || []).slice(0, 6).map((c) => `<div class="row"><span>${c.emoji} ${esc(c.name)}</span><b>${money(c.total, d.base)}</b></div>`).join('') || '<div class="empty">Немає витрат</div>'}</div>
    <h2>Найближчі платежі</h2>
    <div class="card">${(d.upcoming || []).map((t) => `<div class="row"><span>${t.overdue ? '⚠️' : '📅'} ${t.date} · ${esc(t.comment || t.category_name || '')}</span><b>${signed(t.type === 'income' ? t.amount : -t.amount, t.currency)}</b></div>`).join('') || '<div class="muted">Немає</div>'}</div>
    <h2>Останні операції</h2>
    <div class="card">${(d.recent || []).map(txRow).join('') || '<div class="empty">Поки немає операцій — натисни +</div>'}</div>`;
}

async function renderTx() {
  const q = new URLSearchParams({ month: '', from: state.month + '-01', to: monthEnd(state.month), limit: 80, ...state.filters });
  state.tx = await api('/transactions?' + q);
  const f = state.filters;
  view().innerHTML = `
    ${monthNav()}
    <div class="filters">
      ${[['','Усі'],['income','Доходи'],['expense','Витрати'],['transfer','Перекази']].map(([v,l]) => `<button class="chip ${f.type===v?'on':''}" data-act="ftype" data-v="${v}">${l}</button>`).join('')}
      <button class="chip ${f.status==='pending'?'on':''}" data-act="fstat" data-v="pending">На перевірці</button>
      <button class="chip ${f.status==='planned'?'on':''}" data-act="fstat" data-v="planned">План</button>
    </div>
    <div class="card">
      <div class="row"><span class="muted">Сальдо фільтра · ${state.boot.base}</span><b>${signed(state.tx.totals.income - state.tx.totals.expense, state.boot.base)}</b></div>
      ${state.tx.rows.map(txRow).join('') || '<div class="empty">Немає операцій</div>'}
    </div>`;
}

function selectOpts(list, val, label = (x) => x.name, extra = '') {
  return `<option value="">${extra || '—'}</option>` + list.map((x) => `<option value="${x.id}" ${String(x.id)===String(val)?'selected':''}>${esc(label(x))}</option>`).join('');
}

function txForm(t = {}) {
  const type = t.type || 'expense';
  const cats = (state.boot.categories || []).filter((c) => !c.archived && c.kind === type);
  const accs = (state.boot.accounts || []).filter((a) => !a.archived);
  return `<div class="handle"></div><h3>${t.id ? 'Операція #' + t.id : 'Нова операція'}</h3>
    <form class="form" id="txForm">
      <div class="seg" id="typeSeg">
        ${['income','expense','transfer'].map((k) => `<button type="button" data-type="${k}" class="${type===k?'on':''}">${TYPE[k]}</button>`).join('')}
      </div>
      <label>Сума<input name="amount" type="number" step="0.01" inputmode="decimal" required value="${t.amount ? t.amount/100 : ''}"></label>
      <label>Дата<input name="date" type="date" required value="${t.date || today()}"></label>
      <label>Рахунок<select name="account_id" required>${selectOpts(accs, t.account_id, (a)=>`${a.emoji} ${a.name} · ${a.currency}`, 'Оберіть')}</select></label>
      <label class="to-acc ${type==='transfer'?'':'hidden'}">На рахунок<select name="to_account_id">${selectOpts(accs, t.to_account_id)}</select></label>
      <label class="cat ${type==='transfer'?'hidden':''}">Категорія<select name="category_id">${selectOpts(cats, t.category_id)}</select></label>
      <label>Проєкт<select name="project_id">${selectOpts(state.boot.projects, t.project_id)}</select></label>
      <label>Клієнт<select name="client_id">${selectOpts(state.boot.clients, t.client_id)}</select></label>
      <label>Член команди<select name="member_id">${selectOpts(state.boot.members, t.member_id)}</select></label>
      <label>Коментар<textarea name="comment" rows="2">${esc(t.comment || '')}</textarea></label>
      ${state.me.can.writeAnyTx ? `<label>Статус<select name="status"><option value="done" ${t.status==='done'?'selected':''}>Провести</option><option value="planned" ${t.status==='planned'?'selected':''}>Запланувати</option></select></label>` : ''}
      <button class="btn" type="submit">${t.id ? 'Зберегти' : 'Додати'}</button>
      ${t.id ? `<div class="btns">${t.status==='pending' && state.me.can.approve ? `<button type="button" class="btn" data-act="approve">Провести</button><button type="button" class="btn ghost" data-act="reject">Відхилити</button>` : ''}<button type="button" class="btn danger" data-act="del">Видалити</button></div>` : ''}
    </form>`;
}

function openModal(html, onReady) {
  const m = $('modal');
  m.classList.remove('hidden');
  m.innerHTML = `<div class="sheet">${html}</div>`;
  m.onclick = (e) => { if (e.target === m) closeModal(); };
  onReady?.(m.querySelector('.sheet'));
}
function closeModal() { $('modal').classList.add('hidden'); $('modal').innerHTML = ''; }

function formNum(fd, k) { const v = fd.get(k); return v === '' || v == null ? '' : Math.round(Number(String(v).replace(',', '.')) * 100); }
function formId(fd, k) { const v = fd.get(k); return v ? Number(v) : null; }

async function openTx(id) {
  const t = id ? await api('/transactions/' + id) : {};
  openModal(txForm(t), (el) => {
    el.querySelector('#typeSeg')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-type]');
      if (!b) return;
      el.querySelectorAll('#typeSeg button').forEach((x) => x.classList.toggle('on', x === b));
      const type = b.dataset.type;
      el.querySelector('.to-acc').classList.toggle('hidden', type !== 'transfer');
      el.querySelector('.cat').classList.toggle('hidden', type === 'transfer');
      const cats = (state.boot.categories || []).filter((c) => !c.archived && c.kind === type);
      el.querySelector('[name=category_id]').innerHTML = selectOpts(cats, '');
    });
    el.querySelector('#txForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const type = el.querySelector('#typeSeg .on')?.dataset.type || 'expense';
      const body = {
        type, amount: formNum(fd, 'amount'), date: fd.get('date'), account_id: formId(fd, 'account_id'),
        to_account_id: formId(fd, 'to_account_id'), to_amount: formNum(fd, 'to_amount') || null,
        category_id: formId(fd, 'category_id'), project_id: formId(fd, 'project_id'),
        client_id: formId(fd, 'client_id'), member_id: formId(fd, 'member_id'),
        comment: fd.get('comment'), status: fd.get('status') || undefined,
      };
      try {
        if (t.id) await api('/transactions/' + t.id, { method: 'PATCH', body });
        else await api('/transactions', { method: 'POST', body });
        closeModal(); toast('Збережено'); await refresh();
      } catch (err) { toast(err.message); }
    };
    el.querySelector('[data-act=approve]')?.addEventListener('click', () => safe(async () => { await api('/transactions/' + t.id + '/status', { method: 'POST', body: { status: 'done' } }); closeModal(); toast('Проведено'); refresh(); }));
    el.querySelector('[data-act=reject]')?.addEventListener('click', () => safe(async () => { await api('/transactions/' + t.id + '/status', { method: 'POST', body: { status: 'rejected' } }); closeModal(); toast('Відхилено'); refresh(); }));
    el.querySelector('[data-act=del]')?.addEventListener('click', () => safe(async () => { if (!(await ask('Видалити операцію?'))) return; await api('/transactions/' + t.id, { method: 'DELETE' }); closeModal(); toast('Видалено'); refresh(); }));
  });
}

async function renderProjects() {
  const rows = await api('/projects');
  view().innerHTML = `<div class="row"><h1>Проєкти</h1>${state.me.can.writeRefs ? '<button class="chip" data-act="new-project">+ Проєкт</button>' : ''}</div>
    ${rows.map((p) => `<div class="card" data-project="${p.id}">
      <div class="row"><b>${esc(p.name)}</b><span class="tag">${PSTATUS[p.status] || p.status}</span></div>
      <div class="muted">${esc(p.client_name || 'без клієнта')} · бюджет ${money(p.budget, p.currency)}</div>
      <div class="row"><span class="muted">Отримано ${p.paid_pct ?? 0}%</span><b>${signed(p.profit_base, state.boot.base)}</b></div>
      <div class="progress"><b style="width:${p.paid_pct || 0}%"></b></div>
      ${p.debt_base > 0 ? `<div class="muted" style="margin-top:6px">борг клієнта ${money(p.debt_base, state.boot.base)}</div>` : ''}
    </div>`).join('') || '<div class="empty">Немає проєктів</div>'}`;
}

function projectForm(p = {}) {
  return `<div class="handle"></div><h3>${p.id ? 'Проєкт' : 'Новий проєкт'}</h3>
    <form class="form" id="pForm">
      <label>Назва<input name="name" required value="${esc(p.name || '')}"></label>
      <label>Клієнт<select name="client_id">${selectOpts(state.boot.clients, p.client_id)}</select></label>
      <label>Статус<select name="status">${Object.entries(PSTATUS).map(([k,v])=>`<option value="${k}" ${p.status===k?'selected':''}>${v}</option>`).join('')}</select></label>
      <label>Бюджет<input name="budget" type="number" step="0.01" value="${p.budget?p.budget/100:''}"></label>
      <label>Валюта<select name="currency">${['USD','UAH','EUR','USDT'].map((c)=>`<option ${ (p.currency||'USD')===c?'selected':''}>${c}</option>`).join('')}</select></label>
      <label>Дедлайн<input name="deadline" type="date" value="${p.deadline||''}"></label>
      <label>Нотатки<textarea name="notes" rows="2">${esc(p.notes||'')}</textarea></label>
      <button class="btn">Зберегти</button>
    </form>`;
}

async function openProject(id) {
  const p = id ? await api('/projects/' + id) : {};
  const extra = p.transactions ? `<h2>Операції</h2><div class="card">${p.transactions.map(txRow).join('') || '<div class="empty">Немає</div>'}</div>` : '';
  openModal(projectForm(p) + extra, (el) => {
    el.querySelector('#pForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { name: fd.get('name'), client_id: formId(fd,'client_id'), status: fd.get('status'), budget: formNum(fd,'budget')||0, currency: fd.get('currency'), deadline: fd.get('deadline')||null, notes: fd.get('notes') };
      try {
        if (p.id) await api('/projects/' + p.id, { method: 'PATCH', body });
        else await api('/projects', { method: 'POST', body });
        closeModal(); toast('Збережено'); state.boot = await api('/bootstrap'); refresh();
      } catch (err) { toast(err.message); }
    };
  });
}

async function renderMore() {
  const items = [
    ['clients', 'Клієнти'],
    ['team', 'Команда / виплати'],
    ['pnl', 'P&L за рік'],
    ['upcoming', 'Календар платежів'],
    ['recurring', 'Регулярні'],
    ['accounts', 'Рахунки'],
    ['categories', 'Категорії'],
  ];
  if (state.me.can.manageUsers) items.push(['users', 'Доступи']);
  if (state.me.can.manageSettings) items.push(['import', 'Імпорт таблиці'], ['settings', 'Налаштування'], ['audit', 'Журнал']);
  view().innerHTML = `<h1>Ще</h1>${items.map(([id,l]) => `<button class="list-btn" data-more="${id}"><span>${l}</span><span class="muted">›</span></button>`).join('')}`;
}

async function renderClients() {
  const rows = await api('/clients');
  view().innerHTML = `<div class="row"><h1>Клієнти</h1>${state.me.can.writeRefs?'<button class="chip" data-act="new-client">+</button>':''}</div>
    ${rows.map((c) => `<div class="card" data-client="${dataJson(c)}"><div class="row"><b>${esc(c.name)}</b><span>${money(c.income_base, state.boot.base)}</span></div>
      <div class="muted">${c.projects_count} проєктів${c.last_payment ? ' · останній платіж ' + c.last_payment : ''}</div></div>`).join('') || '<div class="empty">Немає клієнтів</div>'}`;
}

async function renderTeam() {
  const d = await api('/team?month=' + state.month);
  view().innerHTML = `${monthNav()}<h1>Команда</h1>
    ${d.members.map((m) => `<div class="card"><div class="row"><b>${esc(m.name)}</b><span class="tag">${ROLES[m.role]||m.role}</span></div>
      <div class="muted">${esc(m.position||'')} ${m.status!=='active'?'· '+USTATUS[m.status]:''}</div>
      <div class="row"><span>Виплачено</span><b>${money(m.paid_base, state.boot.base)}</b></div></div>`).join('')}`;
}

async function renderPnl() {
  const year = Number(state.month.slice(0, 4));
  const p = await api('/reports/pnl?year=' + year);
  const cell = (n) => money(n, p.base).replace(/\s/g, '\u00a0');
  const block = (title, data) => `<tr><th colspan="14">${title}</th></tr>` + data.categories.map((c) => `<tr><td>${esc(c.emoji+' '+c.name)}</td>${p.months.map((m)=>`<td>${c.months[m]?cell(c.months[m]):''}</td>`).join('')}<td><b>${cell(c.total)}</b></td></tr>`).join('') + `<tr><td><b>Разом</b></td>${p.months.map((m)=>`<td><b>${cell(data.totals[m])}</b></td>`).join('')}<td><b>${cell(data.total)}</b></td></tr>`;
  view().innerHTML = `<div class="row"><h1>P&L ${year}</h1><div><button class="chip" data-act="yy" data-d="-1">‹</button><button class="chip" data-act="yy" data-d="1">›</button></div></div>
    <div class="card" style="overflow:auto"><table class="table"><tr><th>Стаття</th>${p.months.map((m)=>`<th>${m.slice(5)}</th>`).join('')}<th>Рік</th></tr>
    ${block('Доходи', p.income)}${block('Витрати', p.expense)}
    <tr><td><b>Прибуток</b></td>${p.months.map((m)=>`<td><b>${cell(p.profit[m])}</b></td>`).join('')}<td><b>${cell(p.total)}</b></td></tr>
    </table></div>`;
}

async function renderUpcoming() {
  const rows = await api('/reports/upcoming?days=60');
  view().innerHTML = `<h1>Календар</h1><div class="card">${rows.map((t) => `<div class="row"><span>${t.overdue?'⚠️':'📅'} ${t.date}<br><span class="muted">${esc(t.comment||t.category_name||'')}</span></span><b>${signed(t.type==='income'?t.amount:-t.amount, t.currency)}</b></div>`).join('') || '<div class="empty">Порожньо</div>'}</div>`;
}

function openClient(c = {}) {
  openModal(`<div class="handle"></div><h3>${c.id ? 'Клієнт' : 'Новий клієнт'}</h3>
    <form class="form" id="refForm">
      <label>Імʼя / компанія<input name="name" required value="${esc(c.name || '')}"></label>
      <label>Контактна особа<input name="contact" value="${esc(c.contact || '')}"></label>
      <label>Телефон<input name="phone" type="tel" value="${esc(c.phone || '')}"></label>
      <label>Email<input name="email" type="email" value="${esc(c.email || '')}"></label>
      <label>Нотатки<textarea name="notes" rows="2">${esc(c.notes || '')}</textarea></label>
      ${c.id ? `<label class="switch">Архів <input type="checkbox" name="archived" ${c.archived ? 'checked' : ''}></label>` : ''}
      <button class="btn">Зберегти</button>
    </form>`, (el) => {
    el.querySelector('#refForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { name: fd.get('name'), contact: fd.get('contact'), phone: fd.get('phone'), email: fd.get('email'), notes: fd.get('notes'), archived: fd.get('archived') === 'on' };
      try {
        if (c.id) await api('/clients/' + c.id, { method: 'PATCH', body });
        else await api('/clients', { method: 'POST', body });
        closeModal(); state.boot = await api('/bootstrap'); toast('Збережено'); refresh();
      } catch (err) { toast(err.message); }
    };
  });
}

function openAccount(a = {}) {
  openModal(`<div class="handle"></div><h3>${a.id ? 'Рахунок' : 'Новий рахунок'}</h3>
    <form class="form" id="refForm">
      <label>Назва<input name="name" required value="${esc(a.name||'')}"></label>
      <label>Емодзі<input name="emoji" value="${esc(a.emoji||'💳')}"></label>
      <label>Тип<select name="type">${[['card','Картка'],['bank','Банк / ФОП'],['cash','Готівка'],['crypto','Крипта']].map(([k,v])=>`<option value="${k}" ${a.type===k?'selected':''}>${v}</option>`).join('')}</select></label>
      <label>Валюта<select name="currency">${['UAH','USD','EUR','USDT','PLN','GBP'].map((c)=>`<option ${ (a.currency||'UAH')===c?'selected':''}>${c}</option>`).join('')}</select></label>
      <label>Початковий залишок<input name="initial_balance" type="number" step="0.01" value="${a.initial_balance?a.initial_balance/100:0}"></label>
      <label class="switch">Архів <input type="checkbox" name="archived" ${a.archived?'checked':''}></label>
      <button class="btn">Зберегти</button>
    </form>`, (el) => {
    el.querySelector('#refForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { name: fd.get('name'), emoji: fd.get('emoji'), type: fd.get('type'), currency: fd.get('currency'), initial_balance: formNum(fd,'initial_balance')||0, archived: fd.get('archived')==='on' };
      try {
        if (a.id) await api('/accounts/' + a.id, { method: 'PATCH', body });
        else await api('/accounts', { method: 'POST', body });
        closeModal(); state.boot = await api('/bootstrap'); toast('Збережено'); refresh();
      } catch (err) { toast(err.message); }
    };
  });
}
function openCategory(c = {}) {
  openModal(`<div class="handle"></div><h3>${c.id ? 'Категорія' : 'Нова категорія'}</h3>
    <form class="form" id="refForm">
      <label>Назва<input name="name" required value="${esc(c.name||'')}"></label>
      <label>Емодзі<input name="emoji" value="${esc(c.emoji||'•')}"></label>
      <label>Тип<select name="kind"><option value="income" ${c.kind==='income'?'selected':''}>Дохід</option><option value="expense" ${c.kind!=='income'?'selected':''}>Витрата</option></select></label>
      <label>Ліміт / міс. (база)<input name="monthly_limit" type="number" step="0.01" value="${c.monthly_limit?c.monthly_limit/100:''}"></label>
      <label class="switch">Архів <input type="checkbox" name="archived" ${c.archived?'checked':''}></label>
      <button class="btn">Зберегти</button>
    </form>`, (el) => {
    el.querySelector('#refForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { name: fd.get('name'), emoji: fd.get('emoji'), kind: fd.get('kind'), monthly_limit: formNum(fd,'monthly_limit')||null, archived: fd.get('archived')==='on' };
      try {
        if (c.id) await api('/categories/' + c.id, { method: 'PATCH', body });
        else await api('/categories', { method: 'POST', body });
        closeModal(); state.boot = await api('/bootstrap'); toast('Збережено'); refresh();
      } catch (err) { toast(err.message); }
    };
  });
}
function openRecurring(r = {}) {
  const accs = (state.boot.accounts || []).filter((a) => !a.archived);
  openModal(`<div class="handle"></div><h3>${r.id ? 'Регулярний платіж' : 'Новий регулярний'}</h3>
    <form class="form" id="refForm">
      <label>Назва<input name="title" required value="${esc(r.title||'')}"></label>
      <div class="seg" id="typeSeg">${['expense','income'].map((k)=>`<button type="button" data-type="${k}" class="${(r.type||'expense')===k?'on':''}">${TYPE[k]}</button>`).join('')}</div>
      <label>Сума<input name="amount" type="number" step="0.01" required value="${r.amount?r.amount/100:''}"></label>
      <label>Рахунок<select name="account_id">${selectOpts(accs, r.account_id)}</select></label>
      <label>Категорія<select name="category_id">${selectOpts((state.boot.categories || []).filter((c) => !c.archived && c.kind === (r.type || 'expense')), r.category_id)}</select></label>
      <label>День місяця<input name="day_of_month" type="number" min="1" max="28" value="${r.day_of_month||1}"></label>
      <label class="switch">Активний <input type="checkbox" name="active" ${r.active!==0?'checked':''}></label>
      <button class="btn">Зберегти</button>
    </form>`, (el) => {
    el.querySelector('#typeSeg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-type]');
      if (!b) return;
      el.querySelectorAll('#typeSeg button').forEach((x) => x.classList.toggle('on', x === b));
      el.querySelector('[name=category_id]').innerHTML = selectOpts((state.boot.categories || []).filter((c) => !c.archived && c.kind === b.dataset.type), '');
    });
    el.querySelector('#refForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { title: fd.get('title'), type: el.querySelector('#typeSeg .on')?.dataset.type || 'expense', amount: formNum(fd,'amount'), account_id: formId(fd,'account_id'), category_id: formId(fd,'category_id'), day_of_month: Number(fd.get('day_of_month')||1), active: fd.get('active')==='on' };
      try {
        if (r.id) await api('/recurring/' + r.id, { method: 'PATCH', body });
        else await api('/recurring', { method: 'POST', body });
        closeModal(); toast('Збережено'); refresh();
      } catch (err) { toast(err.message); }
    };
  });
}

async function renderAccounts() {
  const rows = await api('/accounts');
  view().innerHTML = `<div class="row"><h1>Рахунки</h1>${state.me.can.writeRefs?'<button class="chip" data-act="new-acc">+</button>':''}</div>
    ${rows.map((a) => `<div class="card" data-acc="${dataJson(a)}"><div class="row"><b>${esc(a.emoji+' '+a.name)}</b><span class="muted">${a.currency}${a.archived?' · архів':''}</span></div></div>`).join('')}`;
}
async function renderCategories() {
  const rows = await api('/categories');
  view().innerHTML = `<div class="row"><h1>Категорії</h1>${state.me.can.writeRefs?'<button class="chip" data-act="new-cat">+</button>':''}</div>
    ${rows.map((c) => `<div class="card" data-cat="${dataJson(c)}"><div class="row"><b>${esc(c.emoji+' '+c.name)}</b><span class="tag">${c.kind==='income'?'дохід':'витрата'}</span></div></div>`).join('')}`;
}

async function renderUsers() {
  const rows = await api('/users');
  view().innerHTML = `<h1>Доступи</h1>${rows.map((u) => `<div class="card">
    <div class="row"><b>${esc(u.name)}</b><span class="tag ${u.status==='pending'?'amber':u.status==='blocked'?'red':'green'}">${USTATUS[u.status]}</span></div>
    <div class="muted">@${esc(u.username||'—')} · ${ROLES[u.role]}</div>
    <div class="btns" style="margin-top:10px">
      <select data-role="${u.id}">${Object.entries(ROLES).map(([k,v])=>`<option value="${k}" ${u.role===k?'selected':''}>${v}</option>`).join('')}</select>
      <select data-status="${u.id}">${Object.entries(USTATUS).map(([k,v])=>`<option value="${k}" ${u.status===k?'selected':''}>${v}</option>`).join('')}</select>
    </div></div>`).join('')}`;
}

async function renderImport() {
  view().innerHTML = `<h1>Імпорт таблиці</h1>
    <div class="card">
      <p class="muted">Завантаж .xlsx або .csv зі старої Google-таблиці (Файл → Завантажити → Excel).</p>
      <label class="btn" style="display:block;text-align:center;margin-top:12px">
        Обрати файл
        <input id="importFile" type="file" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
      </label>
      <div id="importStatus" class="muted" style="margin-top:12px"></div>
    </div>`;
  $('importFile').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const st = $('importStatus');
    st.textContent = `Завантажую ${file.name}…`;
    try {
      const headers = { 'X-Filename': file.name, 'Content-Type': file.type || 'application/octet-stream' };
      Object.assign(headers, authHeaders());
      const res = await fetch('/api/import', { method: 'POST', headers, body: file });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Імпорт не вдався');
      st.innerHTML = `Готово: імпортовано <b>${j.imported}</b>, пропущено ${j.skipped}.`;
      toast(`Імпортовано ${j.imported}`);
      state.boot = await api('/bootstrap');
    } catch (err) {
      st.textContent = err.message;
      toast(err.message);
    }
  };
}

async function renderSettings() {
  const s = await api('/settings');
  view().innerHTML = `<h1>Налаштування</h1><form class="form card" id="setForm">
    <label>Компанія<input name="company_name" value="${esc(s.company_name)}"></label>
    <label>Базова валюта звітів<select name="base_currency">${['USD','UAH','EUR'].map((c)=>`<option ${s.base_currency===c?'selected':''}>${c}</option>`).join('')}</select></label>
    <label class="switch">Команда бачить усі операції <input type="checkbox" name="member_sees_all" ${s.member_sees_all?'checked':''}></label>
    <label class="switch">Операції команди на перевірку <input type="checkbox" name="member_needs_approval" ${s.member_needs_approval?'checked':''}></label>
    <label class="switch">Ранковий дайджест адміну <input type="checkbox" name="daily_digest" ${s.daily_digest?'checked':''}></label>
    <button class="btn">Зберегти</button>
    <button type="button" class="btn ghost" id="nbu">Оновити курси НБУ</button>
  </form>`;
}

async function renderAudit() {
  const rows = await api('/audit');
  view().innerHTML = `<h1>Журнал</h1><div class="card">${rows.map((a)=>`<div class="row"><span>${esc(a.user_name||'система')} · ${esc(a.action)} · ${esc(a.entity)} #${a.entity_id||''}</span><span class="muted">${a.created_at.slice(0,16)}</span></div>`).join('')}</div>`;
}

async function renderRecurring() {
  const rows = await api('/recurring');
  view().innerHTML = `<div class="row"><h1>Регулярні</h1><div>${state.me.can.writeRefs?'<button class="chip" data-act="new-rec">+</button> <button class="chip" data-act="run-rec">За місяць</button>':''}</div></div>
    ${rows.map((r)=>`<div class="card" data-rec="${dataJson(r)}"><div class="row"><b>${esc(r.title)}</b><span>${r.active?'щомісяця '+r.day_of_month:'вимкн.'}</span></div>
      <div class="muted">${TYPE[r.type]} · ${(r.amount/100)} · ${esc(r.account_name||'')} · ${esc(r.category_name||'')}</div></div>`).join('') || '<div class="empty">Немає шаблонів</div>'}`;
}

const screens = {
  dash: renderDash, tx: renderTx, projects: renderProjects, more: renderMore,
  clients: renderClients, team: renderTeam, pnl: renderPnl, upcoming: renderUpcoming,
  users: renderUsers, settings: renderSettings, audit: renderAudit, recurring: renderRecurring,
  import: renderImport,
  accounts: renderAccounts, categories: renderCategories,
};

async function refresh() {
  const fn = screens[state.tab] || renderDash;
  try { await fn(); } catch (e) { if (e.message) toast(e.message); }
}

function setTab(tab) {
  if (tab === 'new') return openTx();
  state.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab && tab !== 'new'));
  refresh();
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab);
});

document.body.addEventListener('click', async (e) => {
  const mm = e.target.closest('[data-act=mm]');
  if (mm) { state.month = shiftMonth(state.month, Number(mm.dataset.d)); return refresh(); }
  const yy = e.target.closest('[data-act=yy]');
  if (yy) { state.month = String(Number(state.month.slice(0,4)) + Number(yy.dataset.d)) + state.month.slice(4); return refresh(); }
  const ft = e.target.closest('[data-act=ftype]');
  if (ft) { state.filters.type = ft.dataset.v; return refresh(); }
  const fs = e.target.closest('[data-act=fstat]');
  if (fs) { state.filters.status = state.filters.status === fs.dataset.v ? '' : fs.dataset.v; return refresh(); }
  const tx = e.target.closest('[data-tx]');
  if (tx) return openTx(Number(tx.dataset.tx));
  const pr = e.target.closest('[data-project]');
  if (pr) return openProject(Number(pr.dataset.project));
  if (e.target.closest('[data-act=new-project]')) return openProject();
  if (e.target.closest('[data-act=new-client]')) return openClient();
  const clCard = e.target.closest('[data-client]');
  if (clCard) return openClient(JSON.parse(clCard.dataset.client));
  if (e.target.closest('[data-act=run-rec]')) {
    try { const r = await api('/recurring/run', { method: 'POST' }); toast(`Створено: ${r.created.length}`); } catch (err) { toast(err.message); }
    return refresh();
  }
  if (e.target.closest('[data-act=new-acc]')) return openAccount();
  if (e.target.closest('[data-act=new-cat]')) return openCategory();
  if (e.target.closest('[data-act=new-rec]')) return openRecurring();
  const accCard = e.target.closest('[data-acc]');
  if (accCard) return openAccount(JSON.parse(accCard.dataset.acc));
  const catCard = e.target.closest('[data-cat]');
  if (catCard) return openCategory(JSON.parse(catCard.dataset.cat));
  const recCard = e.target.closest('[data-rec]');
  if (recCard) return openRecurring(JSON.parse(recCard.dataset.rec));
  const more = e.target.closest('[data-more]');
  if (more) { state.tab = more.dataset.more; return refresh(); }
});
document.body.addEventListener('change', async (e) => {
  const role = e.target.closest('[data-role]');
  try {
    if (role) { await api('/users/' + role.dataset.role, { method: 'PATCH', body: { role: e.target.value } }); toast('Роль оновлено'); }
    const st = e.target.closest('[data-status]');
    if (st) { await api('/users/' + st.dataset.status, { method: 'PATCH', body: { status: e.target.value } }); toast('Статус оновлено'); }
  } catch (err) { toast(err.message); }
});

$('searchBtn').onclick = () => $('searchBar').classList.toggle('hidden');
let searchTimer;
$('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(e.target.value.trim()), 250);
});
async function runSearch(q) {
  const box = $('searchResults');
  if (q.length < 2) { box.classList.add('hidden'); return; }
  let r;
  try { r = await api('/search?q=' + encodeURIComponent(q)); } catch (err) { return toast(err.message); }
  box.classList.remove('hidden');
  box.innerHTML = `<div class="sheet" style="position:static;border-radius:16px">
    ${r.transactions.map(txRow).join('') || '<div class="muted">Нічого</div>'}
  </div>`;
}
$('exportBtn').onclick = async () => {
  if (inTelegram()) {
    try {
      toast('Готую Excel…');
      await api('/export/send', { method: 'POST', body: { from: `${state.month}-01`, to: monthEnd(state.month) } });
      toast('Excel надіслано в чат з ботом');
    } catch (e) { toast(e.message); }
    return;
  }
  try {
    const blob = await api(`/export.xlsx?from=${state.month}-01&to=${monthEnd(state.month)}`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `KKLab_${state.month}.xlsx`;
    a.click();
  } catch (e) { toast(e.message); }
};

document.body.addEventListener('submit', async (e) => {
  if (e.target.id !== 'setForm') return;
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
  await api('/settings', { method: 'POST', body: {
    company_name: fd.get('company_name'), base_currency: fd.get('base_currency'),
    member_sees_all: fd.get('member_sees_all') === 'on',
    member_needs_approval: fd.get('member_needs_approval') === 'on',
    daily_digest: fd.get('daily_digest') === 'on',
  }});
  toast('Збережено');
  } catch (err) { toast(err.message); }
});
document.body.addEventListener('click', async (e) => {
  if (e.target.id !== 'nbu') return;
  try {
    const r = await api('/rates/refresh', { method: 'POST' });
    toast('Оновлено курсів: ' + r.updated);
  } catch (err) { toast(err.message); }
});

async function boot() {
  try {
    const launch = await fetch('/api/launch').then((r) => r.json()).catch(() => ({}));
    if (launch.telegram) $('openTg').href = launch.telegram;
    if (launch.company) {
      $('company').textContent = launch.company;
      document.querySelector('.landing h1').textContent = launch.company;
    }
  } catch {}
  if (inTelegram()) showGate({ loading: true });
  await waitInitData(inTelegram() || !session ? 3500 : 250);
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      state.me = await api('/me');
      if (state.me.session) {
        session = state.me.session;
        localStorage.setItem('kk_sess', session);
      }
      state.boot = await api('/bootstrap');
      $('company').textContent = state.me.settings.company;
      $('who').textContent = `${state.me.user.name} · ${ROLES[state.me.user.role] || state.me.user.role}`;
      showApp();
      setTab('dash');
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  showGate({ error: lastErr?.message || 'Немає доступу' });
}
boot();
