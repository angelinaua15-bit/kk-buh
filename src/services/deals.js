/**
 * Угоди — точна копія логіки таблиці «KING KONG LAB ПРОЄКТИ».
 *
 * Рядок таблиці: Розділ · Виконавець · Замовник · Тип роботи · Завдання · Дата початку · Дата завершення ·
 * Метод оплати · Передоплата · Передоплата прог. · Ціна · Маржа · Доп. послуга (ціна, число оплати).
 *
 * Що бот рахує сам:
 *   • Виконавцю всього = Ціна − Маржа (якщо маржу не вказано: Маржа = Ціна − Передоплата прог.)
 *   • Залишок замовника = Ціна − Передоплата (для закритої угоди — 0)
 *   • Залишок виконавцю = Виконавцю всього − Передоплата прог. (для закритої — 0)
 *   • Підсумки місяця = сума маржі угод за розділами (місяць — за датою завершення, інакше — початку)
 *
 * Гроші угоди автоматично відображаються операціями (дохід від замовника, виплата виконавцю, доп. послуги),
 * тому баланс рахунків, борги, виплати команді й звіти працюють на тих самих даних.
 */
import { all, get, getSetting, run, tx } from '../db.js';
import { HttpError, createTx, today } from './finance.js';
import { convert, rateMap } from './money.js';

export const SECTIONS = ['Розробки', 'Реклама', 'Seo / Ads', 'Дизайн', 'Інше'];
const SECTION_CATEGORY = {
  'Розробки': 'Розробка сайтів',
  'Реклама': 'Трафік / таргет',
  'Seo / Ads': 'SEO',
  'Дизайн': 'Дизайн / UI/UX',
  'Інше': 'Інші надходження',
};
export const METHODS = ['Карта', 'ФОП', 'крипта', 'Fh', 'Готівка'];

const bad = (m) => new HttpError(400, m);
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/* ───────────── Розбір значень як у таблиці ───────────── */

/** «5.933грн» → {amount: 593300, currency:'UAH'}; «74$»; «7875» (валюта за методом); «-», «» → null */
export function parseMoney(raw, fallbackCurrency = 'UAH') {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? { amount: Math.round(raw * 100), currency: fallbackCurrency } : null;
  const s = String(raw).trim();
  if (!s || /^[-—–]+$/.test(s)) return null;
  const currency = /usdt|₮/i.test(s) ? 'USDT' : /\$|usd|дол/i.test(s) ? 'USD' : /€|eur/i.test(s) ? 'EUR' : /грн|uah|₴/i.test(s) ? 'UAH' : fallbackCurrency;
  let n = s.replace(/[^\d.,-]/g, '');
  if (/^\d{1,3}([.\s]\d{3})+$/.test(n)) n = n.replace(/[.\s]/g, '');
  else if (/^\d+,\d{1,2}$/.test(n)) n = n.replace(',', '.');
  else n = n.replace(/,/g, '');
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return { amount: Math.round(Math.abs(v) * 100), currency };
}

export function parseDate(raw, year = Number(today().slice(0, 4))) {
  const s = norm(raw);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/);
  if (!m) return null;
  const y = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : String(year);
  const d = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return Number.isNaN(Date.parse(d)) ? null : d;
}

/** «плюс 600 грн», «Виправлення пом. 1000грн 10.03», «Додатково 5100грн (28.03)» → [{amount, currency, date}] */
export function parseExtras(raw, year) {
  const s = norm(raw);
  if (!s) return [];
  const out = [];
  const re = /(\d[\d .]*\d|\d)\s*(грн|uah|₴|\$|usd|usdt)?/gi;
  let m;
  while ((m = re.exec(s))) {
    const after = s.slice(re.lastIndex, re.lastIndex + 1);
    const before = s.slice(Math.max(0, m.index - 1), m.index);
    if (after === '.' || after === '/' || before === '.' || before === '(') continue; // дата
    if (/^\d{1,2}[.]\d{1,2}$/.test(m[1].trim())) continue; // «10.03» — це дата, не сума
    if (!m[2] && Number(m[1].replace(/\D/g, '')) < 50) continue;
    const money = parseMoney(`${m[1]}${m[2] || 'грн'}`);
    if (!money || money.amount < 100) continue;
    const dm = s.slice(re.lastIndex).match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
    out.push({ ...money, date: dm ? parseDate(dm[0], year) : null });
  }
  return out;
}

const safeConvert = (minor, from, to, rates) => {
  if (!minor) return 0;
  try { return convert(minor, from, to, rates); } catch { return minor; }
};

/** Розрахунки угоди (усе в валюті ціни). */
export function calcDeal(d, rates = rateMap()) {
  const cur = d.price_currency || 'UAH';
  const price = d.price || 0;
  const inCur = (amount, c) => safeConvert(amount || 0, c || cur, cur, rates);
  const prepay = inCur(d.prepay, d.prepay_currency);
  const prog = inCur(d.prog_prepay, d.prog_currency);
  let margin;
  if (d.margin !== null && d.margin !== undefined) margin = inCur(d.margin, d.margin_currency);
  else margin = price - prog;
  let executorTotal = Math.max(0, price - margin);
  // Маржа в іншій валюті (напр. «200$» ціна і «3520грн» маржа): довіряємо фактичній виплаті прог., якщо вона близька
  if (d.margin_currency && d.margin_currency !== cur && prog && Math.abs(executorTotal - prog) <= price * 0.1) executorTotal = prog;
  const extras = (d.extras || []).reduce((s, e) => s + inCur(e.amount, e.currency), 0);
  const closed = Boolean(d.closed);
  return {
    currency: cur,
    price,
    prepay,
    prog_prepay: prog,
    margin,
    executor_total: executorTotal,
    extras,
    client_left: closed ? 0 : Math.max(0, price - prepay),
    executor_left: closed || d.executor_paid ? 0 : Math.max(0, executorTotal - prog),
    executor_paid: closed || Boolean(d.executor_paid),
    // маржа рівно як у таблиці (у своїй валюті) — для підсумків
    margin_original: d.margin !== null && d.margin !== undefined
      ? { amount: d.margin, currency: d.margin_currency || cur }
      : { amount: margin, currency: cur },
    month: (d.end_date || d.start_date || '').slice(0, 7) || null,
    start_month: (d.start_date || d.end_date || '').slice(0, 7) || null,
  };
}

/* ───────────── Довідники ───────────── */

const EXECUTOR_ALIASES = { 'maklorki @makl0rk1': '@makl0rk1', 'вадим  розробка': 'Вадим Розробка' };

function findOrCreateMember(name) {
  let n = norm(name);
  if (!n) return null;
  n = EXECUTOR_ALIASES[n.toLowerCase()] || n;
  const uname = n.replace(/^@/, '').split(/[\s/]/).pop();
  const row = get(
    `SELECT id FROM users WHERE lower(name) = lower(?) OR (username IS NOT NULL AND lower(username) = lower(?)) OR lower(name) = lower(?) LIMIT 1`,
    n, uname, `@${uname}`,
  );
  if (row) return row.id;
  return Number(run("INSERT INTO users(name, username, role, status, notify) VALUES(?, ?, 'member', 'active', 0)", n, n.startsWith('@') ? n.slice(1) : null).lastInsertRowid);
}

function findOrCreateClient(name) {
  const n = norm(name);
  if (!n) return null;
  const row = get('SELECT id FROM clients WHERE lower(name) = lower(?)', n);
  if (row) return row.id;
  const tg = n.startsWith('@') ? n.slice(1) : null;
  return Number(run('INSERT INTO clients(name, tg_username) VALUES(?, ?)', n, tg).lastInsertRowid);
}

function accountFor(method, currency) {
  const m = norm(method).toLowerCase();
  const pick = (sql, ...p) => get(sql, ...p);
  if (/крипт|crypto|usdt/.test(m)) return pick("SELECT * FROM accounts WHERE archived=0 AND type='crypto' ORDER BY sort, id LIMIT 1");
  if (/фоп|fop/.test(m)) return pick("SELECT * FROM accounts WHERE archived=0 AND type='bank' ORDER BY sort, id LIMIT 1");
  if (/^fh/.test(m)) {
    const a = pick("SELECT * FROM accounts WHERE lower(name) = 'fh'");
    if (a) return a;
    const id = Number(run("INSERT INTO accounts(name, type, currency, emoji, sort) VALUES('Fh', 'card', 'UAH', '💳', 9)").lastInsertRowid);
    return get('SELECT * FROM accounts WHERE id=?', id);
  }
  if (/готів|cash/.test(m)) return pick("SELECT * FROM accounts WHERE archived=0 AND type='cash' ORDER BY currency = ? DESC, sort LIMIT 1", currency);
  return pick("SELECT * FROM accounts WHERE archived=0 AND type='card' ORDER BY sort, id LIMIT 1")
    || pick('SELECT * FROM accounts WHERE archived=0 ORDER BY sort, id LIMIT 1');
}

/* ───────────── Збереження угоди ───────────── */

/** Нормалізує вхід (з форми, бота, таблиці чи Excel) у поля угоди. */
export function normalizeDeal(input, { year } = {}) {
  const y = year || Number(today().slice(0, 4));
  const section = SECTIONS.find((s) => s.toLowerCase() === norm(input.section).toLowerCase()) || 'Інше';
  const method = norm(input.method || input.payment_method);
  const methodCur = /крипт|usdt|crypto/i.test(method) ? 'USD' : 'UAH';
  const money = (v, cur) => (v && typeof v === 'object' && 'amount' in v ? v : parseMoney(v, cur));
  let price = money(input.price, methodCur);
  const prepay = money(input.prepay, price?.currency || methodCur);
  const prog = money(input.prog ?? input.prog_prepay, price?.currency || methodCur);
  const margin = money(input.margin, price?.currency || methodCur);
  let note = '';
  if (!price && prepay) { price = prepay; note = 'Ціна не вказана — взято передоплату'; }
  if (!price) throw bad('Вкажіть ціну');
  const start = typeof input.start === 'string' && /^\d{4}-/.test(input.start) ? input.start : parseDate(input.start ?? input.start_date, y);
  const end = typeof input.end === 'string' && /^\d{4}-/.test(input.end) ? input.end : parseDate(input.end ?? input.end_date, y);
  const extraText = norm(input.extra);
  const task = norm(input.task) || norm(input.type) || 'Угода';
  return {
    section,
    executor: norm(input.executor),
    client: norm(input.client),
    type: norm(input.type),
    task,
    start_date: start,
    end_date: end,
    method,
    price: price.amount,
    price_currency: price.currency,
    prepay: prepay?.amount ?? 0,
    prepay_currency: prepay?.currency || price.currency,
    prog_prepay: prog?.amount ?? 0,
    prog_currency: prog?.currency || price.currency,
    margin: margin ? margin.amount : null,
    margin_currency: margin ? margin.currency : null,
    extra: extraText || null,
    extras: parseExtras(extraText, y),
    closed: input.closed === true || input.closed === 1 || input.closed === '1' || /^(так|yes|true|закрито|оплачено|✅)$/i.test(norm(input.closed)),
    executor_paid: input.executor_paid === true || input.executor_paid === 1 || input.executor_paid === '1' || /^(так|yes|true|виплачено|✅)$/i.test(norm(input.executor_paid)),
    note,
  };
}

function writeDealTransactions(projectId, d, calc, memberId, clientId, user) {
  // перезбираємо операції угоди з нуля — так редагування в таблиці/боті завжди дає точні суми
  run("UPDATE transactions SET deleted_at = datetime('now') WHERE project_id = ? AND deal_part IS NOT NULL AND deleted_at IS NULL", projectId);
  const rates = rateMap();
  const acc = accountFor(d.method, d.price_currency);
  if (!acc) throw bad('Немає рахунку для методу оплати');
  const incomeCat = get("SELECT id FROM categories WHERE kind='income' AND name = ?", SECTION_CATEGORY[d.section])?.id ?? null;
  const payCat = get("SELECT id FROM categories WHERE kind='expense' AND name IN ('Субпідрядники / фріланс','Виплати команді') ORDER BY name = 'Субпідрядники / фріланс' DESC LIMIT 1")?.id ?? null;
  const toAcc = (amount, currency) => safeConvert(amount, currency, acc.currency, rates);
  const startDate = d.start_date || d.end_date || today();
  const endDate = d.end_date || d.start_date || today();
  const label = `${d.task}${d.client ? ` · ${d.client}` : ''}`;
  const add = (part, type, amount, date, comment, extra = {}) => {
    if (!(amount > 0)) return;
    const t = createTx({
      type, amount, date, account_id: acc.id, category_id: type === 'income' ? incomeCat : payCat,
      project_id: projectId, client_id: clientId, member_id: memberId, comment, ...extra,
    }, user);
    run('UPDATE transactions SET deal_part = ? WHERE id = ?', part, t.id);
  };

  // замовник
  const prepayAcc = d.prepay ? toAcc(d.prepay, d.prepay_currency) : 0;
  let clientTotalAcc = toAcc(d.price, d.price_currency);
  // «25$» передоплати = «1075грн» ціни (оплата в іншій валюті за курсом того дня) — беремо фактичну суму
  if (d.prepay && d.prepay_currency === acc.currency && d.price_currency !== acc.currency
      && Math.abs(clientTotalAcc - prepayAcc) <= clientTotalAcc * 0.12) clientTotalAcc = prepayAcc;
  if (d.closed) {
    add('prepay', 'income', Math.min(prepayAcc, clientTotalAcc), startDate, `Передоплата · ${label}`);
    add('final', 'income', clientTotalAcc - Math.min(prepayAcc, clientTotalAcc), endDate, `Оплата · ${label}`);
  } else {
    add('prepay', 'income', prepayAcc, startDate, `Передоплата · ${label}`);
  }

  // виконавець (власна робота — без виплат)
  if (memberId) {
    const progAcc = d.prog_prepay ? toAcc(d.prog_prepay, d.prog_currency) : 0;
    const totalAcc = toAcc(calc.executor_total, calc.currency);
    if (d.closed || d.executor_paid) {
      const paid = Math.min(progAcc, totalAcc);
      add('prog', 'expense', paid, startDate, `Передоплата виконавцю · ${d.executor}`);
      add('prog_final', 'expense', totalAcc - paid, endDate, `Виплата виконавцю · ${d.executor}`);
    } else {
      add('prog', 'expense', progAcc, startDate, `Передоплата виконавцю · ${d.executor}`);
    }
  }

  // доп. послуги
  d.extras.forEach((e, i) => add(`extra:${i}`, 'income', toAcc(e.amount, e.currency), e.date || endDate, `Доп. послуга · ${label}`));
}

/** Створити або оновити угоду. key — стабільний ключ для дедуплікації (імпорт таблиці). */
export function saveDeal(input, user, { id = null, key = null, year } = {}) {
  const d = normalizeDeal(input, { year });
  const calc = calcDeal(d);
  return tx(() => {
    const memberId = d.executor ? findOrCreateMember(d.executor) : null;
    const clientId = findOrCreateClient(d.client);
    const status = d.closed ? 'done' : 'active';
    const notes = [d.extra, d.note].filter(Boolean).join(' · ') || null;
    let pid = id;
    if (!pid && key) pid = get('SELECT id FROM projects WHERE deal_key = ?', key)?.id || null;
    const fields = [
      d.task, clientId, status, d.price, d.price_currency, d.start_date, d.end_date, notes, d.type || null, d.method || null,
      d.section, memberId, d.margin, d.margin_currency, d.prepay, d.prepay_currency, d.prog_prepay, d.prog_currency, d.extra, d.closed ? 1 : 0,
      d.executor_paid || d.closed ? 1 : 0,
    ];
    if (pid) {
      if (!get('SELECT id FROM projects WHERE id=?', pid)) throw new HttpError(404, 'Угоду не знайдено');
      run(`UPDATE projects SET name=?, client_id=?, status=?, budget=?, currency=?, start_date=?, deadline=?, notes=?, work_type=?, payment_method=?,
           section=?, executor_id=?, margin=?, margin_currency=?, prepay=?, prepay_currency=?, prog_prepay=?, prog_currency=?, extra=?, closed=?, executor_paid=? WHERE id=?`,
      ...fields, pid);
    } else {
      pid = Number(run(`INSERT INTO projects(name, client_id, status, budget, currency, start_date, deadline, notes, work_type, payment_method,
           section, executor_id, margin, margin_currency, prepay, prepay_currency, prog_prepay, prog_currency, extra, closed, executor_paid, deal_key)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...fields, key).lastInsertRowid);
    }
    // ставка виконавця для розділу «Виплати команді» — фіксована сума угоди
    run('DELETE FROM project_members WHERE project_id = ?', pid);
    if (memberId && calc.executor_total > 0) {
      run("INSERT INTO project_members(project_id, user_id, kind, value, role) VALUES(?,?, 'fixed', ?, 'виконавець')", pid, memberId, calc.executor_total);
    }
    writeDealTransactions(pid, d, calc, memberId, clientId, user || { id: null, role: 'admin' });
    return getDeal(pid);
  });
}

export function deleteDeal(id) {
  if (!get('SELECT id FROM projects WHERE id=? AND section IS NOT NULL', id)) throw new HttpError(404, 'Угоду не знайдено');
  run("UPDATE transactions SET deleted_at = datetime('now') WHERE project_id = ? AND deal_part IS NOT NULL AND deleted_at IS NULL", id);
  run("UPDATE projects SET status = 'cancelled' WHERE id = ?", id);
}

/* ───────────── Читання ───────────── */

const DEAL_SELECT = `
  SELECT p.*, cl.name AS client_name, u.name AS executor_name
  FROM projects p LEFT JOIN clients cl ON cl.id = p.client_id LEFT JOIN users u ON u.id = p.executor_id`;

function shape(p, rates) {
  const d = {
    price: p.budget, price_currency: p.currency, prepay: p.prepay, prepay_currency: p.prepay_currency,
    prog_prepay: p.prog_prepay, prog_currency: p.prog_currency, margin: p.margin, margin_currency: p.margin_currency,
    closed: p.closed, executor_paid: p.executor_paid, start_date: p.start_date, end_date: p.deadline,
    extras: parseExtras(p.extra, Number((p.start_date || today()).slice(0, 4))),
  };
  const c = calcDeal(d, rates);
  return {
    id: p.id,
    section: p.section,
    executor: p.executor_name || '',
    executor_id: p.executor_id,
    client: p.client_name || '',
    client_id: p.client_id,
    type: p.work_type || '',
    task: p.name,
    start_date: p.start_date,
    end_date: p.deadline,
    method: p.payment_method || '',
    price: p.budget,
    currency: p.currency,
    prepay: p.prepay,
    prepay_currency: p.prepay_currency,
    prog_prepay: p.prog_prepay,
    prog_currency: p.prog_currency,
    margin: p.margin,
    margin_currency: p.margin_currency,
    extra: p.extra || '',
    closed: Boolean(p.closed),
    executor_paid: Boolean(p.executor_paid || p.closed),
    status: p.status,
    calc: c,
  };
}

export function getDeal(id) {
  const p = get(`${DEAL_SELECT} WHERE p.id = ? AND p.section IS NOT NULL`, id);
  return p ? shape(p, rateMap()) : null;
}

export function listDeals({ section, status, q } = {}) {
  const where = ["p.section IS NOT NULL", "p.status != 'cancelled'"];
  const params = [];
  if (section) { where.push('p.section = ?'); params.push(section); }
  if (status === 'open') where.push('p.closed = 0');
  if (status === 'closed') where.push('p.closed = 1');
  if (q) {
    where.push('(p.name LIKE ? OR cl.name LIKE ? OR u.name LIKE ? OR p.work_type LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rates = rateMap();
  return all(`${DEAL_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.closed, COALESCE(p.deadline, p.start_date) DESC, p.id DESC`, ...params)
    .map((p) => shape(p, rates));
}

/** Підсумки як у таблиці: місяць × розділ = сума маржі (у гривнях). */
export function monthlySummary(year = Number(today().slice(0, 4)), by = getSetting('summary_by', 'end')) {
  const rates = rateMap();
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const table = Object.fromEntries(months.map((m) => [m, Object.fromEntries([...SECTIONS, 'Прибуток'].map((s) => [s, 0]))]));
  const counts = Object.fromEntries(months.map((m) => [m, 0]));
  for (const d of listDeals()) {
    const m = by === 'start' ? d.calc.start_month : d.calc.month;
    if (!m || !table[m]) continue;
    const uah = safeConvert(d.calc.margin_original.amount, d.calc.margin_original.currency, 'UAH', rates);
    table[m][d.section] += uah;
    table[m]['Прибуток'] += uah;
    counts[m] += 1;
  }
  const totals = Object.fromEntries([...SECTIONS, 'Прибуток'].map((s) => [s, months.reduce((sum, m) => sum + table[m][s], 0)]));
  return { year, by, currency: 'UAH', usd_rate: rates.USD, sections: SECTIONS, months, table, counts, totals };
}

/** Відкриті суми: хто з замовників винен і скільки винні виконавцям. */
export function dealBalances() {
  const rates = rateMap();
  const open = listDeals({ status: 'open' });
  const toUah = (v, c) => safeConvert(v, c, 'UAH', rates);
  return {
    open: open.length,
    clients_owe_uah: open.reduce((s, d) => s + toUah(d.calc.client_left, d.calc.currency), 0),
    we_owe_executors_uah: open.reduce((s, d) => s + toUah(d.calc.executor_left, d.calc.currency), 0),
    deals: open,
  };
}

/* ───────────── Імпорт таблиці (JSON-знімок або Excel) ───────────── */

/** Стабільний ключ рядка: розділ + замовник + завдання + дата початку (той самий для знімка, Excel і Google-таблиці). */
export function dealKey(section, row, year) {
  const start = /^\d{4}-\d{2}-\d{2}/.test(String(row.start || '')) ? String(row.start).slice(0, 10) : parseDate(row.start, year) || '';
  return [section, norm(row.client).toLowerCase(), (norm(row.task) || norm(row.type)).toLowerCase(), start].join('|');
}

/** Прибирає дублікати від старого імпорту (проєкти «[Розробки] …») — операції в кошик, проєкти скасовано. */
export function retireLegacyImport() {
  const legacy = all("SELECT id FROM projects WHERE section IS NULL AND name LIKE '[%] %'");
  for (const p of legacy) {
    run("UPDATE transactions SET deleted_at = datetime('now') WHERE project_id = ? AND deleted_at IS NULL", p.id);
    run("UPDATE projects SET status = 'cancelled', notes = COALESCE(notes, '') || ' · замінено імпортом угод' WHERE id = ?", p.id);
  }
  return legacy.length;
}

export function importSnapshot(snapshot, user = { id: null, role: 'admin' }) {
  const cols = snapshot.columns;
  let created = 0;
  let updated = 0;
  const errors = [];
  const retired = retireLegacyImport();
  for (const [section, rows] of Object.entries(snapshot.sections)) {
    for (const arr of rows) {
      const row = Object.fromEntries(cols.map((c, i) => [c, arr[i]]));
      const key = dealKey(section, row, snapshot.year);
      const existed = Boolean(get('SELECT id FROM projects WHERE deal_key = ?', key));
      try {
        saveDeal({ ...row, section }, user, { key, year: snapshot.year });
        existed ? updated++ : created++;
      } catch (e) {
        errors.push(`${section} №${row.n}: ${e.message}`);
      }
    }
  }
  return { created, updated, retired, errors };
}
