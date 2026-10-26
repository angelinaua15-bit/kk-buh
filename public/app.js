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
const USTATUS = { pending: 'Очікує', active: 'Активний', blocked: 'Блок', contact: 'Контакт (без доступу)' };
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
    const c = await api('/cabinet');
    const tpls = await api('/templates').catch(() => []);
    v.innerHTML = `<h1>Мій кабінет</h1><div class="kpis">
      <div class="kpi wide"><div class="l">До виплати</div><div class="v">${money(c.due, c.base)}</div></div>
      <div class="kpi"><div class="l">Виплачено цього місяця</div><div class="v">${money(c.paid_month, c.base)}</div></div>
      <div class="kpi"><div class="l">Нараховано всього</div><div class="v">${money(c.accrued, c.base)}</div></div>
      <div class="kpi"><div class="l">Виплачено всього</div><div class="v">${money(c.paid, c.base)}</div></div>
      <div class="kpi"><div class="l">На перевірці</div><div class="v">${c.pending}</div></div>
    </div>
    ${templatesRow(tpls)}
    ${c.projects.length ? `<h2>Мої проєкти</h2><div class="card">${c.projects.map((p) => `<div class="row"><span>${esc(p.project_name)}<br><span class="muted">${p.kind === 'pct' ? p.value + '%' : money(p.value, p.currency)} · нараховано ${money(p.accrued, c.base)}</span></span><b>${money(p.due, c.base)}</b></div>`).join('')}</div>` : ''}
    ${c.upcoming.length ? `<h2>Заплановані виплати</h2><div class="card">${c.upcoming.map((t) => `<div class="row"><span>📅 ${t.date} · ${esc(t.project_name || t.comment || '')}</span><b>${money(t.amount, t.currency)}</b></div>`).join('')}</div>` : ''}
    <h2>Останні</h2><div class="card">${c.recent.map(txRow).join('') || '<div class="empty">Поки порожньо</div>'}</div>`;
    return;
  }
  const [tpls, cmp] = await Promise.all([api('/templates').catch(() => []), api('/compare?month=' + state.month).catch(() => null)]);
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
    ${cmp ? compareChips(cmp) : ''}
    ${templatesRow(tpls)}
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

function pctChip(n, invert = false) {
  if (n === null || n === undefined) return '<span class="muted">—</span>';
  const good = invert ? n <= 0 : n >= 0;
  return `<span class="${good ? 'plus' : 'minus'}">${n > 0 ? '▲' : n < 0 ? '▼' : '='} ${Math.abs(n)}%</span>`;
}
function compareChips(c) {
  return `<div class="card cmp">
    <div class="row"><span class="muted">до мин. місяця</span><span class="muted">до року тому</span></div>
    <div class="row"><span>Доходи ${pctChip(c.vs_previous.income)}</span><span>${pctChip(c.vs_year_ago.income)}</span></div>
    <div class="row"><span>Витрати ${pctChip(c.vs_previous.expense, true)}</span><span>${pctChip(c.vs_year_ago.expense, true)}</span></div>
    <div class="row"><span>Прибуток ${pctChip(c.vs_previous.profit)}</span><span>${pctChip(c.vs_year_ago.profit)}</span></div>
  </div>`;
}
function templatesRow(list) {
  if (!list?.length) return '';
  return `<h2>Швидкі операції</h2><div class="tpl-row">${list.slice(0, 12).map((t) => `<button class="tpl" data-tpl="${t.id}"><span>${esc(t.emoji || '⚡')}</span><b>${esc(t.title)}</b><small>${money(t.amount, t.currency)}</small></button>`).join('')}</div>`;
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
    ${rows.map((p) => p.limited ? `<div class="card" data-project="${p.id}"><div class="row"><b>${esc(p.name)}</b><span class="tag">${PSTATUS[p.status] || p.status}</span></div><div class="muted">${esc(p.client_name || '')}${p.deadline ? ' · до ' + p.deadline : ''}</div></div>` : `<div class="card" data-project="${p.id}">
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
      <label>Тип роботи<input name="work_type" list="workTypes" value="${esc(p.work_type||'')}" placeholder="Сайт, бот, таргет, SEO…"></label>
      <datalist id="workTypes">${['Сайт','Лендінг','Telegram-бот','Mini App','Таргет','SEO','Дизайн','Підтримка'].map((x)=>`<option value="${x}">`).join('')}</datalist>
      <label>Спосіб оплати<input name="payment_method" value="${esc(p.payment_method||'')}" placeholder="ФОП, картка, крипта…"></label>
      <label>Початок<input name="start_date" type="date" value="${p.start_date||''}"></label>
      <label>Дедлайн<input name="deadline" type="date" value="${p.deadline||''}"></label>
      <label>Нотатки<textarea name="notes" rows="2">${esc(p.notes||'')}</textarea></label>
      <button class="btn">Зберегти</button>
    </form>`;
}

async function openProject(id) {
  const p = id ? await api('/projects/' + id) : {};
  if (p.limited) {
    openModal(`<div class="handle"></div><h3>${esc(p.name)}</h3><div class="muted">${esc(p.client_name || '')} · ${PSTATUS[p.status] || p.status}</div>
      <h2>Мої операції</h2><div class="card">${(p.transactions || []).map(txRow).join('') || '<div class="empty">Немає</div>'}</div>`);
    return;
  }
  const canEdit = state.me.can.writeRefs;
  const team = p.id ? `<h2>Команда проєкту</h2><div class="card" id="pmList">${(p.members || []).map((m) => `<div class="row"><span>${esc(m.name)}</span><span><b>${m.kind === 'pct' ? m.value + '%' : money(m.value, p.currency)}</b>${canEdit ? ` <button class="chip" data-pm-del="${m.user_id}">✕</button>` : ''}</span></div>`).join('') || '<div class="muted">Ще нікого. Додай людину зі ставкою — бот сам порахує виплати.</div>'}
      ${canEdit ? `<form class="pm-add" id="pmForm"><select name="user_id">${selectOpts(state.boot.members, '', (m) => m.name, 'Людина')}</select>
        <select name="kind"><option value="pct">%</option><option value="fixed">сума</option></select>
        <input name="value" type="number" step="0.01" min="0" placeholder="30" required><button class="chip">+</button></form>` : ''}</div>` : '';
  const docs = p.id && canEdit ? `<h2>Документи</h2><div class="btns"><button type="button" class="btn ghost" data-doc="invoice">🧾 Рахунок</button><button type="button" class="btn ghost" data-doc="act">📄 Акт</button></div>
      ${(p.documents || []).length ? `<div class="card" style="margin-top:8px">${p.documents.map((d) => `<div class="row"><span>${esc(d.number)} · ${d.date}</span><button class="chip" data-doc-send="${d.id}">Надіслати</button></div>`).join('')}</div>` : ''}` : '';
  const extra = p.transactions ? `<h2>Операції</h2><div class="card">${p.transactions.map(txRow).join('') || '<div class="empty">Немає</div>'}</div>` : '';
  openModal(projectForm(p) + team + docs + extra, (el) => {
    el.querySelector('#pmForm')?.addEventListener('submit', (e) => safe(async () => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (!fd.get('user_id')) return toast('Оберіть людину');
      const kind = fd.get('kind');
      const value = kind === 'fixed' ? formNum(fd, 'value') : Number(String(fd.get('value')).replace(',', '.'));
      await api(`/projects/${p.id}/members`, { method: 'POST', body: { user_id: Number(fd.get('user_id')), kind, value } });
      toast('Додано'); openProject(p.id);
    }));
    el.querySelectorAll('[data-pm-del]').forEach((b) => b.addEventListener('click', () => safe(async () => {
      await api(`/projects/${p.id}/members`, { method: 'POST', body: { user_id: Number(b.dataset.pmDel), remove: true } });
      openProject(p.id);
    })));
    el.querySelectorAll('[data-doc]').forEach((b) => b.addEventListener('click', () => safe(async () => {
      const d = await api('/documents', { method: 'POST', body: { kind: b.dataset.doc, project_id: p.id } });
      if (d.sent) toast(`${d.number} надіслано в чат з ботом`);
      else openPdf(d.id);
      openProject(p.id);
    })));
    el.querySelectorAll('[data-doc-send]').forEach((b) => b.addEventListener('click', () => safe(async () => {
      if (!inTelegram()) return openPdf(Number(b.dataset.docSend));
      await api(`/documents/${b.dataset.docSend}/send`, { method: 'POST' });
      toast('Надіслано в чат з ботом');
    })));
    el.querySelector('#pForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { name: fd.get('name'), client_id: formId(fd,'client_id'), status: fd.get('status'), budget: formNum(fd,'budget')||0, currency: fd.get('currency'), start_date: fd.get('start_date')||null, deadline: fd.get('deadline')||null, notes: fd.get('notes'), work_type: fd.get('work_type')||null, payment_method: fd.get('payment_method')||null };
      try {
        if (p.id) await api('/projects/' + p.id, { method: 'PATCH', body });
        else await api('/projects', { method: 'POST', body });
        closeModal(); toast('Збережено'); state.boot = await api('/bootstrap'); refresh();
      } catch (err) { toast(err.message); }
    };
  });
}

async function renderMore() {
  const all = state.me.can.writeRefs || state.me.user.role === 'viewer';
  const items = [['templates', '⚡ Шаблони операцій']];
  if (all) {
    items.push(
      ['debts', '📌 Борги клієнтів'],
      ['forecast', '🔮 Прогноз каси'],
      ['taxes', '🧾 Податки ФОП'],
      ['payouts', '👥 Виплати команді'],
      ['profit', '💹 Прибутковість'],
      ['summary', '📊 Підсумки по місяцях'],
      ['projects', 'Проєкти — фінанси по кожному'],
      ['clients', 'Клієнти'],
      ['team', 'Команда'],
      ['pnl', 'P&L за рік'],
      ['upcoming', 'Календар платежів'],
      ['recurring', 'Регулярні'],
      ['accounts', 'Рахунки'],
      ['categories', 'Категорії та ліміти'],
    );
  }
  if (state.me.can.manageUsers) items.push(['users', 'Доступи']);
  if (state.me.can.manageSettings) items.push(['requisites', '🏢 Реквізити для документів'], ['sheet', '📗 Google-таблиця'], ['mono', '🏦 Monobank'], ['import', 'Імпорт таблиці'], ['settings', 'Налаштування'], ['audit', 'Журнал']);
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
      <label>Telegram<input name="tg_username" value="${esc(c.tg_username || '')}" placeholder="@username"></label>
      <label>Юр. назва (для рахунків)<input name="legal_name" value="${esc(c.legal_name || '')}"></label>
      <label>ЄДРПОУ / ІПН<input name="legal_code" value="${esc(c.legal_code || '')}"></label>
      <label>Адреса<input name="address" value="${esc(c.address || '')}"></label>
      <label>Нотатки<textarea name="notes" rows="2">${esc(c.notes || '')}</textarea></label>
      ${c.id ? `<label class="switch">Архів <input type="checkbox" name="archived" ${c.archived ? 'checked' : ''}></label>` : ''}
      <button class="btn">Зберегти</button>
    </form>`, (el) => {
    el.querySelector('#refForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { name: fd.get('name'), contact: fd.get('contact'), phone: fd.get('phone'), email: fd.get('email'), notes: fd.get('notes'), archived: fd.get('archived') === 'on', tg_username: fd.get('tg_username'), legal_name: fd.get('legal_name'), legal_code: fd.get('legal_code'), address: fd.get('address') };
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
    ${rows.map((c) => `<div class="card" data-cat="${dataJson(c)}"><div class="row"><b>${esc(c.emoji+' '+c.name)}</b><span class="tag">${c.kind==='income'?'дохід':'витрата'}</span></div>${c.monthly_limit ? `<div class="muted">ліміт ${money(c.monthly_limit, state.boot.base)} / міс.</div>` : ''}</div>`).join('')}`;
}

async function renderUsers() {
  const [rows, inv] = await Promise.all([api('/users'), api('/invite').catch(() => null)]);
  const roleOpts = (sel) => Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${v}</option>`).join('');
  const invite = inv ? `<div class="card invite">
      <div class="row"><b>🔗 Запросити в команду</b><span class="tag green">${ROLES[inv.role]}</span></div>
      <p class="muted" style="margin:8px 0">Хто відкриє посилання — одразу отримає доступ із цією роллю і бачитиме те саме, що й ти. Надсилай лише тим, кому довіряєш.</p>
      <div class="invite__link" id="invLink">${esc(inv.link)}</div>
      <div class="btns" style="margin-top:10px">
        <button class="btn" type="button" id="invCopy">Скопіювати</button>
        <button class="btn ghost" type="button" id="invShare">Надіслати в Telegram</button>
      </div>
      <label style="margin-top:12px">Роль за посиланням<select id="invRole">${roleOpts(inv.role)}</select></label>
      <button class="btn ghost" type="button" id="invReset" style="margin-top:8px">🔄 Новий код (старе посилання перестане працювати)</button>
      <hr style="border:0;border-top:1px solid var(--line, #2a2f55);margin:14px 0">
      <label class="switch">Відкритий доступ для всіх <input type="checkbox" id="invOpen" ${inv.open_access ? 'checked' : ''}></label>
      <p class="muted" style="margin-top:6px">⚠️ Будь-хто, хто знайде бота й натисне Start, одразу отримає роль «${ROLES[inv.open_role]}» і бачитиме фінанси. Краще користуватися посиланням вище.</p>
    </div>` : '';
  window.scrollTo(0, 0);
  view().innerHTML = `<h1>Доступи</h1>${invite}${rows.map((u) => `<div class="card">
    <div class="row"><b>${esc(u.name)}</b><span class="tag ${u.status==='pending'?'amber':u.status==='blocked'?'red':'green'}">${USTATUS[u.status]}</span></div>
    <div class="muted">@${esc(u.username||'—')} · ${ROLES[u.role]}</div>
    <div class="btns" style="margin-top:10px">
      <select data-role="${u.id}">${Object.entries(ROLES).map(([k,v])=>`<option value="${k}" ${u.role===k?'selected':''}>${v}</option>`).join('')}</select>
      <select data-status="${u.id}">${Object.entries(USTATUS).map(([k,v])=>`<option value="${k}" ${u.status===k?'selected':''}>${v}</option>`).join('')}</select>
    </div></div>`).join('')}`;
  if (!inv) return;
  const setInv = async (body, msg) => { const r = await api('/invite', { method: 'POST', body }); toast(msg); return r; };
  $('invCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('invLink').textContent); toast('Посилання скопійовано'); }
    catch { toast('Утримуй посилання, щоб скопіювати'); }
  };
  $('invShare').onclick = () => {
    const url = `https://t.me/share/url?url=${encodeURIComponent($('invLink').textContent)}&text=${encodeURIComponent('Доступ до бухгалтерії King Kong Lab 🦍')}`;
    if (window.Telegram?.WebApp?.openTelegramLink) Telegram.WebApp.openTelegramLink(url); else window.open(url, '_blank');
  };
  $('invRole').onchange = (e) => { setInv({ role: e.target.value }, 'Роль за посиланням оновлено').then(renderUsers); };
  $('invReset').onclick = () => { setInv({ reset: true }, 'Створено нове посилання').then(renderUsers); };
  const ask = (q) => new Promise((ok) => (window.Telegram?.WebApp?.showConfirm ? Telegram.WebApp.showConfirm(q, ok) : ok(window.confirm(q))));
  $('invOpen').onchange = async (e) => {
    const on = e.target.checked;
    if (on && !(await ask('Увімкнути доступ для всіх? Будь-хто з Telegram зможе бачити фінанси.'))) { e.target.checked = false; return; }
    setInv({ open_access: on }, on ? 'Відкритий доступ увімкнено' : 'Відкритий доступ вимкнено');
  };
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
    <label>Підсумки місяця рахувати<select name="summary_by"><option value="end" ${s.summary_by!=='start'?'selected':''}>за датою завершення проєкту</option><option value="start" ${s.summary_by==='start'?'selected':''}>за датою початку</option></select></label>
    <button class="btn">Зберегти</button>
    <button type="button" class="btn ghost" id="nbu">Оновити курси НБУ</button>
    <button type="button" class="btn ghost" id="backupBtn">💾 Бекап бази в чат</button>
    <p class="muted">Бекап також приходить адмінам щодня о 23:30, тижневий звіт — у пʼятницю о 18:00.</p>
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

function openPdf(id) {
  const url = `/api/documents/${id}.pdf`;
  fetch(url, { headers: authHeaders() }).then((r) => {
    if (!r.ok) throw new Error('Не вдалося відкрити PDF');
    return r.blob();
  }).then((b) => window.open(URL.createObjectURL(b), '_blank')).catch((e) => toast(e.message));
}

async function renderTemplates() {
  const rows = await api('/templates');
  view().innerHTML = `<div class="row"><h1>Шаблони</h1>${state.me.can.writeRefs ? '<button class="chip" data-act="new-tpl">+</button>' : ''}</div>
    <p class="muted">Часті операції в один тап: оренда, підписки, виплати. Також доступні в боті — кнопка «⚡ Шаблони».</p>
    ${templatesRow(rows) || '<div class="empty">Шаблонів ще немає</div>'}
    ${state.me.can.writeRefs ? rows.map((t) => `<div class="card" data-tpl-edit="${dataJson(t)}"><div class="row"><b>${esc((t.emoji || '⚡') + ' ' + t.title)}</b><span>${money(t.amount, t.currency)}</span></div><div class="muted">${TYPE[t.type]} · ${esc(t.account_name || '')}${t.category_name ? ' · ' + esc(t.category_name) : ''}</div></div>`).join('') : ''}`;
}
function openTemplate(t = {}) {
  const accs = (state.boot.accounts || []).filter((a) => !a.archived);
  const type = t.type || 'expense';
  openModal(`<div class="handle"></div><h3>${t.id ? 'Шаблон' : 'Новий шаблон'}</h3>
    <form class="form" id="refForm">
      <div class="seg" id="typeSeg">${['expense','income'].map((k)=>`<button type="button" data-type="${k}" class="${type===k?'on':''}">${TYPE[k]}</button>`).join('')}</div>
      <label>Назва<input name="title" required value="${esc(t.title||'')}" placeholder="Оренда офісу"></label>
      <label>Емодзі<input name="emoji" value="${esc(t.emoji||'⚡')}"></label>
      <label>Сума<input name="amount" type="number" step="0.01" required value="${t.amount?t.amount/100:''}"></label>
      <label>Рахунок<select name="account_id" required>${selectOpts(accs, t.account_id, (a)=>`${a.emoji} ${a.name} · ${a.currency}`, 'Оберіть')}</select></label>
      <label>Категорія<select name="category_id">${selectOpts((state.boot.categories||[]).filter((c)=>!c.archived&&c.kind===type), t.category_id)}</select></label>
      <label>Проєкт<select name="project_id">${selectOpts(state.boot.projects, t.project_id)}</select></label>
      <label>Член команди<select name="member_id">${selectOpts(state.boot.members, t.member_id)}</select></label>
      <label>Коментар<input name="comment" value="${esc(t.comment||'')}"></label>
      ${t.id ? `<label class="switch">Архів <input type="checkbox" name="archived" ${t.archived?'checked':''}></label>` : ''}
      <button class="btn">Зберегти</button>
    </form>`, (el) => {
    el.querySelector('#typeSeg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-type]');
      if (!b) return;
      el.querySelectorAll('#typeSeg button').forEach((x) => x.classList.toggle('on', x === b));
      el.querySelector('[name=category_id]').innerHTML = selectOpts((state.boot.categories||[]).filter((c)=>!c.archived&&c.kind===b.dataset.type), '');
    });
    el.querySelector('#refForm').onsubmit = (e) => safe(async () => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { title: fd.get('title'), emoji: fd.get('emoji'), type: el.querySelector('#typeSeg .on')?.dataset.type || 'expense', amount: formNum(fd,'amount'), account_id: formId(fd,'account_id'), category_id: formId(fd,'category_id'), project_id: formId(fd,'project_id'), member_id: formId(fd,'member_id'), comment: fd.get('comment'), archived: fd.get('archived') === 'on' };
      if (t.id) await api('/templates/' + t.id, { method: 'PATCH', body });
      else await api('/templates', { method: 'POST', body });
      closeModal(); toast('Збережено'); refresh();
    });
  });
}

async function renderDebts() {
  const rows = await api('/debts');
  const total = rows.reduce((s, d) => s + d.left_base, 0);
  view().innerHTML = `<h1>Борги клієнтів</h1>
    <div class="kpis"><div class="kpi wide"><div class="l">Разом · ${state.boot.base}</div><div class="v">${money(total, state.boot.base)}</div></div></div>
    ${rows.map((d) => `<div class="card">
      <div class="row"><b>${esc(d.client_name || 'без клієнта')}</b>${d.overdue_days ? `<span class="tag red">прострочено ${d.overdue_days} дн.</span>` : d.deadline ? `<span class="tag">до ${d.deadline}</span>` : ''}</div>
      <div class="muted">${esc(d.project_name)}</div>
      <div class="row"><span class="muted">Оплачено ${money(d.paid, d.currency)} з ${money(d.budget, d.currency)}</span><b class="minus">${money(d.left, d.currency)}</b></div>
      <div class="progress"><b style="width:${Math.min(100, Math.round(d.paid / d.budget * 100))}%"></b></div>
      <div class="btns" style="margin-top:10px"><button class="btn ghost" data-copy="${esc(d.reminder)}">📋 Текст нагадування</button><button class="btn ghost" data-project="${d.project_id}">Проєкт</button></div>
    </div>`).join('') || '<div class="empty">🎉 Боргів немає</div>'}`;
}

async function renderForecast() {
  const f = await api('/forecast?weeks=' + (state.fWeeks || 4));
  const max = Math.max(1, ...f.weeks.map((w) => Math.abs(w.end_balance)), Math.abs(f.start_balance));
  view().innerHTML = `<div class="row"><h1>Прогноз каси</h1><div>${[2,4,8].map((n)=>`<button class="chip ${ (state.fWeeks||4)===n?'on':''}" data-weeks="${n}">${n} тиж.</button>`).join('')}</div></div>
    <div class="kpis">
      <div class="kpi"><div class="l">Зараз</div><div class="v">${money(f.start_balance, f.base)}</div></div>
      <div class="kpi"><div class="l">Мінімум</div><div class="v ${f.gap ? 'minus' : ''}">${money(f.min_balance, f.base)}</div></div>
    </div>
    ${f.gap ? `<div class="card warn">⚠️ Касовий розрив близько ${f.min_date}: на рахунках буде ${money(f.min_balance, f.base)}. Перенеси витрати або прискор оплати клієнтів.</div>` : '<div class="card ok">✅ Касового розриву не видно</div>'}
    <div class="card"><div class="fbars">${f.weeks.map((w) => `<span title="${w.to}"><i class="${w.end_balance < 0 ? 'neg' : ''}" style="height:${Math.max(4, Math.abs(w.end_balance) / max * 100)}%"></i><small>${w.to.slice(5)}</small></span>`).join('')}</div></div>
    ${f.weeks.map((w) => `<div class="card"><div class="row"><b>${w.from.slice(5)} — ${w.to.slice(5)}</b><b class="${w.end_balance < 0 ? 'minus' : ''}">${money(w.end_balance, f.base)}</b></div>
      <div class="muted">+${money(w.income, f.base)} · −${money(w.expense, f.base)}</div>
      ${w.items.map((x) => `<div class="row sub"><span>${x.overdue ? '⚠️' : '•'} ${x.date.slice(5)} ${esc(x.comment || '')}</span><span>${signed(x.type === 'income' ? x.amount : -x.amount, x.currency)}</span></div>`).join('')}</div>`).join('')}
    <p class="muted">Враховано: залишки на рахунках, заплановані операції (і прострочені) та регулярні платежі.</p>`;
}

async function renderTaxes() {
  const t = await api('/taxes');
  const s = t.settings;
  const accs = (state.boot.accounts || []).filter((a) => !a.archived);
  const q = t.quarters?.[1];
  view().innerHTML = `<h1>Податки ФОП</h1>
    ${t.enabled ? `<div class="kpis">
      <div class="kpi"><div class="l">Дохід ${esc(q.quarter)}</div><div class="v">${money(q.income, 'UAH')}</div></div>
      <div class="kpi"><div class="l">З початку року</div><div class="v">${money(t.ytd_income, 'UAH')}</div></div>
      ${t.limit ? `<div class="kpi wide"><div class="l">Ліміт ${s.group} групи використано</div><div class="v ${t.limit_pct >= 90 ? 'minus' : ''}">${t.limit_pct}%</div><div class="progress"><b style="width:${Math.min(100, t.limit_pct)}%"></b></div></div>` : ''}
    </div>
    <h2>До сплати</h2><div class="card">${t.items.map((i) => `<div class="row"><span>${i.paid ? '✅' : i.days_left < 0 ? '🔴' : i.days_left <= 7 ? '🟡' : '•'} ${esc(i.title)}<br><span class="muted">до ${i.due}${i.paid ? ' · сплачено' : i.planned ? ' · в плані' : i.days_left < 0 ? ' · прострочено' : ` · ${i.days_left} дн.`}</span></span><b>${money(i.amount, 'UAH')}</b></div>`).join('') || '<div class="muted">Нічого</div>'}</div>
    ${state.me.can.writeRefs ? `<button class="btn" data-act="plan-taxes">Додати в план платежів</button>` : ''}` : '<div class="card">Розрахунок податків вимкнено.</div>'}
    ${state.me.can.manageSettings ? `<h2>Налаштування</h2><form class="form card" id="taxForm">
      <label>Група<select name="group">${[['3','3 група'],['2','2 група'],['1','1 група'],['none','не рахувати']].map(([v,l])=>`<option value="${v}" ${s.group===v?'selected':''}>${l}</option>`).join('')}</select></label>
      <label>Єдиний податок, % (3 гр.)<input name="tax_rate" type="number" step="0.1" value="${s.tax_rate}"></label>
      <label>Військовий збір, % (3 гр.)<input name="military_rate" type="number" step="0.1" value="${s.military_rate}"></label>
      <label>ЄП фіксований, грн/міс (1–2 гр.)<input name="group_fixed" type="number" step="0.01" value="${s.group_fixed/100}"></label>
      <label>ВЗ фіксований, грн/міс (1–2 гр.)<input name="military_fixed" type="number" step="0.01" value="${s.military_fixed/100}"></label>
      <label>ЄСВ, грн/міс<input name="esv_month" type="number" step="0.01" value="${s.esv_month/100}"></label>
      <div class="muted">Дохід ФОП рахується з рахунків:</div>
      ${accs.map((a) => `<label class="switch">${esc(a.emoji + ' ' + a.name)} <input type="checkbox" name="acc" value="${a.id}" ${(s.tax_accounts.length ? s.tax_accounts.includes(a.id) : a.type === 'bank') ? 'checked' : ''}></label>`).join('')}
      <button class="btn">Зберегти</button>
      <p class="muted">Ставки 2026: ЄСВ 1 902,34 грн/міс, ЄП 2 гр. 1 729,40 грн, ВЗ 1–2 гр. 864,70 грн, 3 гр. — 5% + 1% ВЗ. Перевіряйте зміни законодавства.</p>
    </form>` : ''}`;
  $('taxForm')?.addEventListener('submit', (e) => safe(async () => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api('/taxes/settings', { method: 'POST', body: {
      group: fd.get('group'), tax_rate: fd.get('tax_rate'), military_rate: fd.get('military_rate'),
      group_fixed: formNum(fd, 'group_fixed'), military_fixed: formNum(fd, 'military_fixed'), esv_month: formNum(fd, 'esv_month'),
      tax_accounts: fd.getAll('acc').map(Number),
    } });
    toast('Збережено'); refresh();
  }));
}

async function renderPayouts() {
  const p = await api('/payouts');
  const accs = (state.boot.accounts || []).filter((a) => !a.archived);
  view().innerHTML = `<h1>Виплати команді</h1>
    <div class="kpis"><div class="kpi wide"><div class="l">Разом до виплати</div><div class="v">${money(p.total_due, p.base)}</div></div></div>
    ${p.people.map((x) => `<div class="card"><div class="row"><b>${esc(x.name)}</b><b class="${x.due ? 'minus' : ''}">${money(x.due, p.base)}</b></div>
      <div class="muted">нараховано ${money(x.accrued, p.base)} · виплачено ${money(x.paid, p.base)}${x.planned ? ' · у плані ' + money(x.planned, p.base) : ''}</div>
      ${x.projects.map((pr) => `<div class="row sub"><span>${esc(pr.project_name)} · ${pr.kind === 'pct' ? pr.value + '%' : money(pr.value, pr.currency)}</span><span>${money(pr.due, p.base)}</span></div>`).join('')}</div>`).join('') || '<div class="empty">Ставок ще немає. Відкрий проєкт → «Команда проєкту» і додай людей з % або сумою.</div>'}
    ${p.total_due > 0 && state.me.can.writeRefs ? `<form class="form card" id="payForm"><label>Платити з рахунку<select name="account_id" required>${selectOpts(accs, '', (a)=>`${a.emoji} ${a.name} · ${a.currency}`, 'Оберіть')}</select></label><button class="btn">Запланувати всі виплати</button></form>` : ''}`;
  $('payForm')?.addEventListener('submit', (e) => safe(async () => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = await api('/payouts/plan', { method: 'POST', body: { account_id: formId(fd, 'account_id') } });
    toast(`Заплановано виплат: ${r.created}`); refresh();
  }));
}

async function renderProfit() {
  const year = state.month.slice(0, 4);
  const p = await api(`/profitability?from=${year}-01-01&to=${monthEnd(state.month)}`);
  const table = (rows, label) => rows.length ? `<div class="card" style="overflow:auto"><table class="table"><tr><th>${label}</th><th>Дохід</th><th>Витрати</th><th>Прибуток</th><th>Маржа</th></tr>
    ${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${money(r.income, p.base)}</td><td>${money(r.expense, p.base)}</td><td><b>${money(r.profit, p.base)}</b></td><td>${r.margin ?? '—'}${r.margin !== null ? '%' : ''}</td></tr>`).join('')}</table></div>` : '<div class="empty">Немає даних</div>';
  view().innerHTML = `<h1>Прибутковість ${year}</h1><p class="muted">з ${p.from} по ${p.to}</p>
    <h2>Типи робіт</h2>${table(p.byType, 'Тип')}
    <h2>Виконавці</h2>${table(p.byMember, 'Людина')}
    <h2>Проєкти</h2>${table(p.byProject.slice(0, 20), 'Проєкт')}`;
}

async function renderRequisites() {
  const r = await api('/requisites');
  view().innerHTML = `<h1>Реквізити</h1><p class="muted">Підставляються в рахунки-фактури та акти.</p><form class="form card" id="reqForm">
    <label>Назва / ПІБ ФОП<input name="legal_name" value="${esc(r.legal_name)}" placeholder="ФОП Іванів Ангеліна Ігорівна"></label>
    <label>ІПН / ЄДРПОУ<input name="legal_code" value="${esc(r.legal_code)}"></label>
    <label>IBAN<input name="iban" value="${esc(r.iban)}"></label>
    <label>Банк<input name="bank" value="${esc(r.bank)}"></label>
    <label>Адреса<input name="address" value="${esc(r.address)}"></label>
    <label>Підписант<input name="signer" value="${esc(r.signer)}"></label>
    <label>Примітка про податки<input name="tax_note" value="${esc(r.tax_note)}"></label>
    <button class="btn">Зберегти</button></form>`;
  $('reqForm').addEventListener('submit', (e) => safe(async () => {
    e.preventDefault();
    await api('/requisites', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    toast('Збережено');
  }));
}

async function renderMono() {
  const m = await api('/mono');
  if (!m.enabled) {
    view().innerHTML = `<h1>Monobank</h1><div class="card"><p>Щоб надходження на ФОП і картки ставали операціями автоматично:</p>
      <ol class="muted"><li>Отримай особистий токен на api.monobank.ua</li><li>Додай його в налаштуваннях сервера як <b>MONO_TOKEN</b></li><li>Повернись сюди і привʼяжи рахунки</li></ol></div>`;
    return;
  }
  const accs = (state.boot.accounts || []).filter((a) => !a.archived);
  view().innerHTML = `<h1>Monobank</h1><p class="muted">${esc(m.name || '')}${m.last_sync ? ' · синхронізовано ' + m.last_sync.slice(0, 16).replace('T', ' ') : ''}</p>
    ${m.accounts.map((a) => `<div class="card"><div class="row"><b>${esc(a.type === 'fop' ? 'ФОП' : a.type)} · ${esc(a.pan)}</b><span>${money(a.balance, a.currency)}</span></div>
      <label>Привʼязати до<select data-mono="${esc(a.id)}" data-meta="${dataJson(a)}"><option value="">— не імпортувати —</option><option value="new">+ створити новий рахунок</option>${accs.map((x) => `<option value="${x.id}" ${a.linked_account_id === x.id ? 'selected' : ''}>${esc(x.emoji + ' ' + x.name)} · ${x.currency}</option>`).join('')}</select></label></div>`).join('')}
    <div class="btns"><button class="btn" data-act="mono-sync">Підтягнути за 7 днів</button><button class="btn ghost" data-act="mono-hook">${m.webhook ? 'Оновити вебхук' : 'Увімкнути миттєво'}</button></div>
    <p class="muted">«Увімкнути миттєво» — Monobank сам надсилатиме кожну операцію. Без цього бот перевіряє виписку раз на 30 хв.</p>`;
}

async function renderSheet() {
  const on = state.me.features?.sheet;
  view().innerHTML = `<h1>Google-таблиця</h1>
    <div class="card ${on ? 'ok' : 'warn'}">${on ? '✅ Синхронізацію на сервері увімкнено' : '⚠️ На сервері ще не задано SHEET_SYNC_TOKEN'}</div>
    <div class="card"><b>Як підключити таблицю</b>
      <ol class="muted">
        <li>${on ? 'Токен уже є на сервері (SHEET_SYNC_TOKEN).' : 'Додай на сервері змінну <b>SHEET_SYNC_TOKEN</b> — будь-який довгий пароль.'}</li>
        <li>У таблиці: Розширення → Apps Script, встав скрипт з репозиторію <b>docs/google-sheet-sync.gs</b>, збережи.</li>
        <li>Онови таблицю → меню «🦍 KK Бот» → «Налаштувати»: адреса бота <b>${esc(location.origin)}</b> і той самий токен.</li>
      </ol>
      <p class="muted">Після цього аркуші «Операції (бот)» і «Проєкти (бот)» оновлюються кожні 10 хв, а будь-яка зміна рядка в таблиці одразу зберігається в боті.</p>
    </div>`;
}

/* ───────────── Угоди (як у таблиці) ───────────── */
const SECTIONS_UI = ['Розробки', 'Реклама', 'Seo / Ads', 'Дизайн', 'Інше'];
const CUR_OPTS = ['UAH', 'USD', 'USDT', 'EUR'];
const mo = (v) => (v && typeof v === 'object' ? v : null);

async function renderDeals() {
  state.dealF = state.dealF || { section: '', status: '' };
  const f = state.dealF;
  const q = new URLSearchParams({ section: f.section, status: f.status, q: f.q || '' });
  const [rows, bal] = await Promise.all([api('/deals?' + q), state.me.can.writeRefs || state.me.user.role === 'viewer' ? api('/deals/balances').catch(() => null) : null]);
  const chip = (act, v, label, on) => `<button class="chip ${on ? 'on' : ''}" data-act="${act}" data-v="${esc(v)}">${label}</button>`;
  view().innerHTML = `<div class="row"><h1>Проєкти</h1><div>${bal ? '<button class="chip" data-more="summary">📊 Підсумки</button> ' : ''}${state.me.can.writeRefs ? '<button class="chip" data-act="new-deal">+ Проєкт</button>' : ''}</div></div>
    ${bal ? `<div class="kpis">
      <div class="kpi"><div class="l">В роботі</div><div class="v">${bal.open}</div></div>
      <div class="kpi"><div class="l">Замовники винні</div><div class="v minus">${money(bal.clients_owe_uah, 'UAH')}</div></div>
      <div class="kpi wide"><div class="l">Виконавцям ще виплатити</div><div class="v">${money(bal.we_owe_executors_uah, 'UAH')}</div></div>
    </div>` : ''}
    <div class="filters">${chip('dsec', '', 'Усі', !f.section)}${SECTIONS_UI.map((x) => chip('dsec', x, x, f.section === x)).join('')}</div>
    <div class="filters">${chip('dst', '', 'Усі', !f.status)}${chip('dst', 'open', '⏳ В роботі', f.status === 'open')}${chip('dst', 'closed', '✅ Закриті', f.status === 'closed')}</div>
    <input class="deal-search" id="dealSearch" placeholder="Пошук: замовник, виконавець, завдання…" value="${esc(f.q || '')}">
    ${rows.map(dealCard).join('') || '<div class="empty">Немає проєктів</div>'}`;
  const inp = $('dealSearch');
  inp.oninput = () => { clearTimeout(renderDeals.t); renderDeals.t = setTimeout(() => { f.q = inp.value.trim(); renderDeals().then(() => { const x = $('dealSearch'); x.focus(); x.setSelectionRange(x.value.length, x.value.length); }); }, 300); };
}

function dealCard(d) {
  const st = d.closed ? '<span class="tag green">✅ закрита</span>' : '<span class="tag amber">⏳ в роботі</span>';
  if (d.limited) {
    return `<div class="card deal"><div class="row"><b>${esc(d.task)}</b>${st}</div>
      <div class="muted">${esc(d.section)} · ${esc(d.client)} · ${d.start_date || ''}${d.end_date ? ' → ' + d.end_date : ''}</div>
      <div class="row"><span>Мені за проєкт</span><b>${money(d.my.total, d.my.currency)}</b></div>
      <div class="row"><span class="muted">Отримано ${money(d.my.paid, d.my.currency)}</span><span class="muted">Залишок ${money(d.my.left, d.my.currency)}</span></div></div>`;
  }
  const c = d.calc;
  return `<div class="card deal" data-deal="${d.id}">
    <div class="row"><b>${esc(d.task)}</b>${st}</div>
    <div class="muted">${esc(d.section)} · ${esc(d.type || '')} · ${d.start_date || '—'}${d.end_date ? ' → ' + d.end_date : ''} · ${esc(d.method || '')}</div>
    <div class="deal-grid">
      <span><small>Замовник</small>${esc(d.client || '—')}</span>
      <span><small>Виконавець</small>${esc(d.executor || '—')}</span>
      <span><small>Ціна</small><b>${money(d.price, d.currency)}</b></span>
      <span><small>Маржа</small><b class="plus">${money(c.margin_original.amount, c.margin_original.currency)}</b></span>
      <span><small>Передоплата</small>${money(d.prepay, d.prepay_currency)}</span>
      <span><small>Передоплата прог.</small>${money(d.prog_prepay, d.prog_currency)}</span>
    </div>
    ${!d.closed ? `<div class="row sub"><span>Замовник винен <b class="minus">${money(c.client_left, c.currency)}</b></span><span>${c.executor_paid ? 'Виконавцю виплачено ✅' : `Виконавцю ще <b>${money(c.executor_left, c.currency)}</b>`}</span></div>` : ''}
    ${d.extra ? `<div class="muted">➕ ${esc(d.extra)}</div>` : ''}
  </div>`;
}

async function openDeal(id) {
  const [d, meta] = await Promise.all([id ? api('/deals/' + id) : Promise.resolve({}), api('/deals/meta')]);
  const val = (amount, cur) => (amount || amount === 0) && amount !== null ? amount / 100 : '';
  const curSel = (name, cur) => `<select name="${name}">${CUR_OPTS.map((c) => `<option ${ (cur || 'UAH') === c ? 'selected' : ''}>${c}</option>`).join('')}</select>`;
  const list = (idn, arr) => `<datalist id="${idn}">${arr.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`;
  const clients = (state.boot.clients || []).map((c) => c.name);
  const people = [...new Set([...(meta.executors || []).map((x) => x.name), ...(state.boot.members || []).map((m) => m.name)])];
  const mCur = d.margin_currency || d.currency;
  openModal(`<div class="handle"></div><h3>${d.id ? 'Проєкт' : 'Новий проєкт'}</h3>
    <form class="form" id="dealForm">
      <label>Розділ<select name="section">${meta.sections.map((x) => `<option ${ (d.section || state.dealF?.section || 'Розробки') === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label>Виконавець<input name="executor" list="dlPeople" value="${esc(d.executor || '')}" placeholder="хто робить"></label>${list('dlPeople', people)}
      <label>Замовник<input name="client" list="dlClients" value="${esc(d.client || '')}" placeholder="@username або імʼя"></label>${list('dlClients', clients)}
      <label>Тип роботи<input name="type" list="dlTypes" value="${esc(d.type || '')}"></label>${list('dlTypes', meta.types || [])}
      <label>Завдання<input name="task" required value="${esc(d.task || '')}"></label>
      <div class="two"><label>Дата початку<input name="start" type="date" value="${d.start_date || today()}"></label>
      <label>Дата завершення<input name="end" type="date" value="${d.end_date || ''}"></label></div>
      <label>Метод оплати<select name="method">${['', ...meta.methods].map((x) => `<option ${ (d.method || '') === x ? 'selected' : ''} value="${x}">${x || '—'}</option>`).join('')}</select></label>
      <div class="money"><label>Ціна<input name="price" type="number" step="0.01" min="0" required value="${val(d.price)}"></label>${curSel('price_cur', d.currency)}</div>
      <div class="money"><label>Передоплата<input name="prepay" type="number" step="0.01" min="0" value="${val(d.prepay)}"></label>${curSel('prepay_cur', d.prepay_currency || d.currency)}</div>
      <div class="money"><label>Передоплата прог.<input name="prog" type="number" step="0.01" min="0" value="${val(d.prog_prepay)}"></label>${curSel('prog_cur', d.prog_currency || d.currency)}</div>
      <div class="money"><label>Маржа<input name="margin" type="number" step="0.01" min="0" value="${d.margin === null || d.margin === undefined ? '' : d.margin / 100}" placeholder="авто: ціна − передоплата прог."></label>${curSel('margin_cur', mCur)}</div>
      <label>Доп. послуга, ціна, число оплати<input name="extra" value="${esc(d.extra || '')}" placeholder="плюс 600 грн 10.03"></label>
      <label class="switch">✅ Закрита й повністю оплачена <input type="checkbox" name="closed" ${d.closed ? 'checked' : ''}></label>
      <label class="switch">👤 Виконавцю виплачено повністю <input type="checkbox" name="executor_paid" ${d.executor_paid ? 'checked' : ''}></label>
      <div class="card calc" id="dealCalc"></div>
      <button class="btn">${d.id ? 'Зберегти' : 'Додати проєкт'}</button>
      ${d.id ? '<button type="button" class="btn danger" data-act="del-deal">Видалити проєкт</button>' : ''}
    </form>`, (el) => {
    const form = el.querySelector('#dealForm');
    const num = (n) => Math.round(Number(String(form[n].value || 0).replace(',', '.')) * 100) || 0;
    const recalc = () => {
      const cur = form.price_cur.value;
      const price = num('price');
      const prepay = form.prepay_cur.value === cur ? num('prepay') : null;
      const prog = form.prog_cur.value === cur ? num('prog') : null;
      const marginSet = form.margin.value !== '';
      const margin = marginSet ? (form.margin_cur.value === cur ? num('margin') : null) : (prog === null ? null : price - prog);
      const execTotal = margin === null ? null : Math.max(0, price - margin);
      const closed = form.closed.checked;
      if (closed) form.executor_paid.checked = true;
      const execPaid = form.executor_paid.checked;
      el.querySelector('#dealCalc').innerHTML = `
        <div class="row"><span>Маржа${marginSet ? '' : ' (авто)'}</span><b class="plus">${margin === null ? 'у іншій валюті' : money(margin, cur)}</b></div>
        <div class="row"><span>Виконавцю всього</span><b>${execTotal === null ? '—' : money(execTotal, cur)}</b></div>
        <div class="row"><span>Замовник ще винен</span><b class="minus">${closed ? money(0, cur) : prepay === null ? '—' : money(Math.max(0, price - prepay), cur)}</b></div>
        <div class="row"><span>Виконавцю ще виплатити</span><b>${closed || execPaid ? money(0, cur) : execTotal === null || prog === null ? '—' : money(Math.max(0, execTotal - prog), cur)}</b></div>`;
    };
    form.addEventListener('input', recalc);
    recalc();
    form.onsubmit = (e) => safe(async () => {
      e.preventDefault();
      const m = (n, c) => (form[n].value === '' ? '' : { amount: num(n), currency: form[c].value });
      const body = {
        section: form.section.value, executor: form.executor.value, client: form.client.value, type: form.type.value, task: form.task.value,
        start: form.start.value || '', end: form.end.value || '', method: form.method.value,
        price: m('price', 'price_cur'), prepay: m('prepay', 'prepay_cur') || { amount: 0, currency: form.price_cur.value },
        prog: m('prog', 'prog_cur') || { amount: 0, currency: form.price_cur.value }, margin: m('margin', 'margin_cur'),
        extra: form.extra.value, closed: form.closed.checked, executor_paid: form.executor_paid.checked || form.closed.checked,
      };
      if (d.id) await api('/deals/' + d.id, { method: 'PATCH', body });
      else await api('/deals', { method: 'POST', body });
      closeModal(); toast('Збережено'); state.boot = await api('/bootstrap'); refresh();
    });
    el.querySelector('[data-act=del-deal]')?.addEventListener('click', () => safe(async () => {
      if (!(await ask('Видалити проєкт разом з його оплатами?'))) return;
      await api('/deals/' + d.id, { method: 'DELETE' });
      closeModal(); toast('Видалено'); refresh();
    }));
  });
}

async function renderSummary() {
  const year = Number(state.sumYear || state.month.slice(0, 4));
  const by = state.sumBy || '';
  const s = await api(`/deals/summary?year=${year}${by ? '&by=' + by : ''}`);
  const cols = [...s.sections, 'Прибуток'];
  const cell = (n) => (n ? money(n, 'UAH').replace(/\s/g, '\u00a0') : '');
  const MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
  view().innerHTML = `<div class="row"><h1>Підсумки ${year}</h1><div><button class="chip" data-act="sy" data-d="-1">‹</button><button class="chip" data-act="sy" data-d="1">›</button></div></div>
    <div class="filters"><button class="chip ${s.by === 'end' ? 'on' : ''}" data-act="sby" data-v="end">за датою завершення</button><button class="chip ${s.by === 'start' ? 'on' : ''}" data-act="sby" data-v="start">за датою початку</button></div>
    <div class="card" style="overflow:auto"><table class="table sum"><tr><th></th>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>
      ${s.months.map((m, i) => `<tr><td>${MONTHS[i]}</td>${cols.map((c) => `<td class="${c === 'Прибуток' ? 'tot' : ''}">${cell(s.table[m][c])}</td>`).join('')}</tr>`).join('')}
      <tr><td><b>Разом</b></td>${cols.map((c) => `<td><b>${cell(s.totals[c])}</b></td>`).join('')}</tr></table></div>
    <p class="muted">Маржа проєктів по розділах, у гривнях. Долар — за курсом ${s.usd_rate} (Ще → Налаштування → курси). Рахується автоматично з проєктів.</p>`;
}

const screens = {
  dash: renderDash, tx: renderTx, projects: renderProjects, more: renderMore,
  clients: renderClients, team: renderTeam, pnl: renderPnl, upcoming: renderUpcoming,
  users: renderUsers, settings: renderSettings, audit: renderAudit, recurring: renderRecurring,
  import: renderImport,
  deals: renderDeals, summary: renderSummary,
  templates: renderTemplates, debts: renderDebts, forecast: renderForecast, taxes: renderTaxes,
  payouts: renderPayouts, profit: renderProfit, requisites: renderRequisites, mono: renderMono, sheet: renderSheet,
  accounts: renderAccounts, categories: renderCategories,
};

async function refresh() {
  const fn = screens[state.tab] || renderDash;
  try { await fn(); } catch (e) { if (e.message) toast(e.message); }
}

function setTab(tab) {
  // «+» по центру — новий проєкт (угода); команді, яка не створює проєкти, — своя операція
  if (tab === 'new') return state.me.can.writeRefs ? safe(() => openDeal()) : openTx();
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
  const ds = e.target.closest('[data-act=dsec]');
  if (ds) { state.dealF.section = ds.dataset.v; return refresh(); }
  const dst = e.target.closest('[data-act=dst]');
  if (dst) { state.dealF.status = dst.dataset.v; return refresh(); }
  if (e.target.closest('[data-act=new-deal]')) return openDeal();
  const dealEl = e.target.closest('[data-deal]');
  if (dealEl && state.me.can.writeRefs) return openDeal(Number(dealEl.dataset.deal));
  const sy = e.target.closest('[data-act=sy]');
  if (sy) { state.sumYear = Number(state.sumYear || state.month.slice(0, 4)) + Number(sy.dataset.d); return refresh(); }
  const sby = e.target.closest('[data-act=sby]');
  if (sby) { state.sumBy = sby.dataset.v; return refresh(); }
  const tplBtn = e.target.closest('[data-tpl]');
  if (tplBtn) return safe(async () => { const t = await api(`/templates/${tplBtn.dataset.tpl}/use`, { method: 'POST', body: {} }); toast(t.status === 'pending' ? 'Записано · на перевірці' : 'Записано'); refresh(); });
  const tplEdit = e.target.closest('[data-tpl-edit]');
  if (tplEdit) return openTemplate(JSON.parse(tplEdit.dataset.tplEdit));
  if (e.target.closest('[data-act=new-tpl]')) return openTemplate();
  const copy = e.target.closest('[data-copy]');
  if (copy) return safe(async () => { await navigator.clipboard.writeText(copy.dataset.copy); toast('Скопійовано — встав у чат з клієнтом'); });
  const wk = e.target.closest('[data-weeks]');
  if (wk) { state.fWeeks = Number(wk.dataset.weeks); return refresh(); }
  if (e.target.closest('[data-act=plan-taxes]')) return safe(async () => { const r = await api('/taxes/plan', { method: 'POST', body: {} }); toast(`Додано в план: ${r.created}`); refresh(); });
  if (e.target.closest('[data-act=mono-sync]')) return safe(async () => { await api('/mono/sync', { method: 'POST', body: { days: 7 } }); toast('Синхронізація запущена — результат прийде в чат'); });
  if (e.target.closest('[data-act=mono-hook]')) return safe(async () => { await api('/mono/webhook', { method: 'POST' }); toast('Вебхук увімкнено'); refresh(); });
  if (e.target.id === 'backupBtn') return safe(async () => { await api('/backup', { method: 'POST' }); toast('Бекап надіслано в чат з ботом'); });
  const more = e.target.closest('[data-more]');
  if (more) { state.tab = more.dataset.more; return refresh(); }
});
document.body.addEventListener('change', async (e) => {
  const monoSel = e.target.closest('[data-mono]');
  if (monoSel) {
    try {
      await api('/mono/link', { method: 'POST', body: { mono_id: monoSel.dataset.mono, account_id: monoSel.value || null, ...JSON.parse(monoSel.dataset.meta) } });
      state.boot = await api('/bootstrap'); toast('Збережено'); if (monoSel.value === 'new') refresh();
    } catch (err) { toast(err.message); }
    return;
  }
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
    summary_by: fd.get('summary_by'),
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
