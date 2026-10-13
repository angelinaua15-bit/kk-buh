import { all, get, getSetting, run, tx } from '../db.js';
import { config } from '../config.js';
import { baseCurrency, convert, rateBetween, rateMap } from './money.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

export const ROLES = {
  admin: 'Адмін',
  finance: 'Фінансист',
  member: 'Команда',
  viewer: 'Перегляд',
};

export const can = {
  manageUsers: (u) => u.role === 'admin',
  manageSettings: (u) => u.role === 'admin',
  writeRefs: (u) => ['admin', 'finance'].includes(u.role),
  writeAnyTx: (u) => ['admin', 'finance'].includes(u.role),
  createTx: (u) => ['admin', 'finance', 'member'].includes(u.role),
  seeAll: (u) => ['admin', 'finance', 'viewer'].includes(u.role) || getSetting('member_sees_all') === '1',
  approve: (u) => ['admin', 'finance'].includes(u.role),
};

export function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
}
export const monthOf = (d) => d.slice(0, 7);
export function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
}
export function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

export function audit(userId, action, entity, entityId, data) {
  run(
    'INSERT INTO audit(user_id, action, entity, entity_id, data) VALUES(?,?,?,?,?)',
    userId ?? null,
    action,
    entity,
    entityId ?? null,
    data ? JSON.stringify(data) : null,
  );
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const idOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/* ───────────────────────── Transactions ───────────────────────── */

const TX_SELECT = `
  SELECT t.*,
    a.name AS account_name, a.emoji AS account_emoji,
    ta.name AS to_account_name, ta.emoji AS to_account_emoji, ta.currency AS to_currency,
    c.name AS category_name, c.emoji AS category_emoji, c.color AS category_color,
    p.name AS project_name, cl.name AS client_name,
    m.name AS member_name, cb.name AS created_by_name
  FROM transactions t
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN accounts ta ON ta.id = t.to_account_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN clients cl ON cl.id = t.client_id
  LEFT JOIN users m ON m.id = t.member_id
  LEFT JOIN users cb ON cb.id = t.created_by
`;

export const getTx = (id) => get(`${TX_SELECT} WHERE t.id = ? AND t.deleted_at IS NULL`, id);

function normalizeTx(input, existing = {}) {
  const d = { ...existing, ...input };
  const type = d.type;
  if (!['income', 'expense', 'transfer'].includes(type)) throw bad('Невірний тип операції');
  const amount = Math.round(Number(d.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw bad('Сума має бути більше 0');
  const date = d.date || today();
  if (!isDate(date)) throw bad('Невірна дата');

  const account = get('SELECT * FROM accounts WHERE id = ?', idOrNull(d.account_id));
  if (!account) throw bad('Оберіть рахунок');

  const base = baseCurrency();
  const rates = rateMap();
  const out = {
    type,
    date,
    amount,
    currency: account.currency,
    account_id: account.id,
    to_account_id: null,
    to_amount: null,
    category_id: idOrNull(d.category_id),
    project_id: idOrNull(d.project_id),
    client_id: idOrNull(d.client_id),
    member_id: idOrNull(d.member_id),
    comment: (d.comment || '').toString().trim().slice(0, 1000) || null,
    receipt_file_id: d.receipt_file_id || null,
  };
  out.rate = rateBetween(out.currency, base, rates);
  out.amount_base = Math.round(amount * out.rate);

  if (type === 'transfer') {
    const to = get('SELECT * FROM accounts WHERE id = ?', idOrNull(d.to_account_id));
    if (!to) throw bad('Оберіть рахунок призначення');
    if (to.id === account.id) throw bad('Рахунки мають відрізнятись');
    out.to_account_id = to.id;
    const toAmount = d.to_amount ? Math.round(Number(d.to_amount)) : null;
    out.to_amount = toAmount && toAmount > 0 ? toAmount : convert(amount, account.currency, to.currency, rates);
    out.category_id = null;
  } else if (out.category_id) {
    const cat = get('SELECT kind FROM categories WHERE id = ?', out.category_id);
    if (!cat) throw bad('Категорію не знайдено');
    if (cat.kind !== type) throw bad('Категорія не відповідає типу операції');
  }
  if (out.project_id && !out.client_id) {
    out.client_id = get('SELECT client_id FROM projects WHERE id = ?', out.project_id)?.client_id ?? null;
  }
  return out;
}

export function createTx(input, user) {
  if (!can.createTx(user)) throw new HttpError(403, 'Недостатньо прав');
  const t = normalizeTx(input);
  let status = input.status === 'planned' ? 'planned' : 'done';
  if (user.role === 'member' && getSetting('member_needs_approval', '1') === '1' && status === 'done') status = 'pending';
  const r = run(
    `INSERT INTO transactions(type, status, date, amount, currency, rate, amount_base, account_id, to_account_id, to_amount,
      category_id, project_id, client_id, member_id, comment, receipt_file_id, recurring_id, created_by, approved_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    t.type, status, t.date, t.amount, t.currency, t.rate, t.amount_base, t.account_id, t.to_account_id, t.to_amount,
    t.category_id, t.project_id, t.client_id, t.member_id, t.comment, t.receipt_file_id, input.recurring_id ?? null,
    user.id ?? null, status === 'done' ? (user.id ?? null) : null,
  );
  const id = Number(r.lastInsertRowid);
  audit(user.id, 'create', 'transaction', id, { ...t, status });
  return getTx(id);
}

function assertCanEdit(row, user) {
  if (!row) throw new HttpError(404, 'Операцію не знайдено');
  if (can.writeAnyTx(user)) return;
  if (user.role === 'member' && row.created_by === user.id && row.status === 'pending') return;
  throw new HttpError(403, 'Редагувати можна лише свої операції, поки вони на перевірці');
}

export function updateTx(id, input, user) {
  const row = get('SELECT * FROM transactions WHERE id = ? AND deleted_at IS NULL', id);
  assertCanEdit(row, user);
  const t = normalizeTx(input, row);
  let status = row.status;
  if (input.status && can.writeAnyTx(user) && ['done', 'planned'].includes(input.status)) status = input.status;
  run(
    `UPDATE transactions SET type=?, status=?, date=?, amount=?, currency=?, rate=?, amount_base=?, account_id=?, to_account_id=?,
      to_amount=?, category_id=?, project_id=?, client_id=?, member_id=?, comment=?, receipt_file_id=?, updated_at=datetime('now')
     WHERE id=?`,
    t.type, status, t.date, t.amount, t.currency, t.rate, t.amount_base, t.account_id, t.to_account_id, t.to_amount,
    t.category_id, t.project_id, t.client_id, t.member_id, t.comment, t.receipt_file_id, id,
  );
  audit(user.id, 'update', 'transaction', id, { before: row, after: t });
  return getTx(id);
}

export function deleteTx(id, user) {
  const row = get('SELECT * FROM transactions WHERE id = ? AND deleted_at IS NULL', id);
  assertCanEdit(row, user);
  run("UPDATE transactions SET deleted_at = datetime('now') WHERE id = ?", id);
  audit(user.id, 'delete', 'transaction', id, row);
}

export function restoreTx(id, user) {
  if (!can.writeAnyTx(user)) throw new HttpError(403, 'Недостатньо прав');
  run('UPDATE transactions SET deleted_at = NULL WHERE id = ?', id);
  audit(user.id, 'restore', 'transaction', id);
  return getTx(id);
}

export function setTxStatus(id, status, user) {
  if (!can.approve(user)) throw new HttpError(403, 'Недостатньо прав');
  const row = get('SELECT * FROM transactions WHERE id = ? AND deleted_at IS NULL', id);
  if (!row) throw new HttpError(404, 'Операцію не знайдено');
  if (!['done', 'rejected', 'planned'].includes(status)) throw bad('Невірний статус');
  const date = status === 'done' && row.status === 'planned' ? today() : row.date;
  run("UPDATE transactions SET status=?, date=?, approved_by=?, updated_at=datetime('now') WHERE id=?", status, date, user.id, id);
  audit(user.id, `status:${status}`, 'transaction', id);
  return getTx(id);
}

export function listTx(f, user) {
  const where = ['t.deleted_at IS NULL'];
  const p = [];
  const add = (sql, v) => {
    where.push(sql);
    p.push(v);
  };
  if (f.from) add('t.date >= ?', f.from);
  if (f.to) add('t.date <= ?', f.to);
  if (f.type) add('t.type = ?', f.type);
  if (f.status) add('t.status = ?', f.status);
  else where.push("t.status != 'rejected'");
  if (f.account_id) {
    where.push('(t.account_id = ? OR t.to_account_id = ?)');
    p.push(Number(f.account_id), Number(f.account_id));
  }
  for (const k of ['category_id', 'project_id', 'client_id', 'member_id']) if (f[k]) add(`t.${k} = ?`, Number(f[k]));
  if (f.q) {
    where.push('(t.comment LIKE ? OR p.name LIKE ? OR cl.name LIKE ? OR c.name LIKE ? OR m.name LIKE ?)');
    const q = `%${f.q}%`;
    p.push(q, q, q, q, q);
  }
  if (!can.seeAll(user)) {
    where.push('(t.created_by = ? OR t.member_id = ?)');
    p.push(user.id, user.id);
  }
  const limit = Math.min(Number(f.limit) || 50, 500);
  const offset = Number(f.offset) || 0;
  const W = where.join(' AND ');
  const rows = all(`${TX_SELECT} WHERE ${W} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
  const totals = get(
    `SELECT
       COALESCE(SUM(CASE WHEN t.type='income' AND t.status='done' THEN t.amount_base END),0) AS income,
       COALESCE(SUM(CASE WHEN t.type='expense' AND t.status='done' THEN t.amount_base END),0) AS expense,
       COUNT(*) AS count
     FROM transactions t
     LEFT JOIN projects p ON p.id = t.project_id
     LEFT JOIN clients cl ON cl.id = t.client_id
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN users m ON m.id = t.member_id
     WHERE ${W}`,
    ...p,
  );
  return { rows, totals, limit, offset };
}

/* ───────────────────────── Balances & reports ───────────────────────── */

export function balances({ includeArchived = false } = {}) {
  const base = baseCurrency();
  const rates = rateMap();
  const rows = all(
    `SELECT a.*,
       a.initial_balance
       + COALESCE((SELECT SUM(amount) FROM transactions WHERE account_id=a.id AND type='income' AND status='done' AND deleted_at IS NULL),0)
       - COALESCE((SELECT SUM(amount) FROM transactions WHERE account_id=a.id AND type IN ('expense','transfer') AND status='done' AND deleted_at IS NULL),0)
       + COALESCE((SELECT SUM(to_amount) FROM transactions WHERE to_account_id=a.id AND type='transfer' AND status='done' AND deleted_at IS NULL),0)
       AS balance
     FROM accounts a ${includeArchived ? '' : 'WHERE a.archived = 0'}
     ORDER BY a.archived, a.sort, a.id`,
  );
  let total = 0;
  for (const r of rows) {
    try {
      r.balance_base = convert(r.balance, r.currency, base, rates);
    } catch {
      r.balance_base = 0;
    }
    if (!r.archived) total += r.balance_base;
  }
  return { base, accounts: rows, total };
}

function sumByType(from, to, extra = '', ...p) {
  return get(
    `SELECT
       COALESCE(SUM(CASE WHEN type='income' THEN amount_base END),0) AS income,
       COALESCE(SUM(CASE WHEN type='expense' THEN amount_base END),0) AS expense,
       COUNT(CASE WHEN type != 'transfer' THEN 1 END) AS count
     FROM transactions WHERE status='done' AND deleted_at IS NULL AND date BETWEEN ? AND ? ${extra}`,
    from,
    to,
    ...p,
  );
}

export function byCategory(from, to, kind) {
  return all(
    `SELECT c.id, COALESCE(c.name,'Без категорії') AS name, COALESCE(c.emoji,'•') AS emoji, COALESCE(c.color,'#64748B') AS color,
       c.monthly_limit, SUM(t.amount_base) AS total, COUNT(*) AS count
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.status='done' AND t.deleted_at IS NULL AND t.type = ? AND t.date BETWEEN ? AND ?
     GROUP BY c.id ORDER BY total DESC`,
    kind,
    from,
    to,
  );
}

export function monthlySeries(months = 12, endMonth = monthOf(today())) {
  const start = shiftMonth(endMonth, -(months - 1));
  const rows = all(
    `SELECT substr(date,1,7) AS month,
       COALESCE(SUM(CASE WHEN type='income' THEN amount_base END),0) AS income,
       COALESCE(SUM(CASE WHEN type='expense' THEN amount_base END),0) AS expense
     FROM transactions WHERE status='done' AND deleted_at IS NULL AND date >= ? AND date <= ?
     GROUP BY month`,
    `${start}-01`,
    monthBounds(endMonth)[1],
  );
  const map = Object.fromEntries(rows.map((r) => [r.month, r]));
  const out = [];
  for (let i = 0; i < months; i++) {
    const m = shiftMonth(start, i);
    const r = map[m] || { income: 0, expense: 0 };
    out.push({ month: m, income: r.income, expense: r.expense, profit: r.income - r.expense });
  }
  return out;
}

export function upcoming(days = 30) {
  const t = today();
  const end = new Date(Date.parse(t) + days * 864e5).toISOString().slice(0, 10);
  return all(`${TX_SELECT} WHERE t.status='planned' AND t.deleted_at IS NULL AND t.date <= ? ORDER BY t.date`, end).map((r) => ({
    ...r,
    overdue: r.date < t,
  }));
}

export function dashboard(user, month = monthOf(today())) {
  const base = baseCurrency();
  const [from, to] = monthBounds(month);
  const [pFrom, pTo] = monthBounds(shiftMonth(month, -1));

  if (!can.seeAll(user)) {
    const mine = get(
      `SELECT COALESCE(SUM(CASE WHEN member_id=? AND type='expense' AND status='done' THEN amount_base END),0) AS payouts,
              COUNT(CASE WHEN created_by=? AND status='pending' THEN 1 END) AS pending
       FROM transactions WHERE deleted_at IS NULL AND date BETWEEN ? AND ?`,
      user.id, user.id, from, to,
    );
    const year = get(
      `SELECT COALESCE(SUM(amount_base),0) AS total FROM transactions
       WHERE member_id=? AND type='expense' AND status='done' AND deleted_at IS NULL AND date >= ?`,
      user.id, `${month.slice(0, 4)}-01-01`,
    );
    return { limited: true, base, month, payouts: mine.payouts, pending: mine.pending, yearPayouts: year.total,
      recent: listTx({ limit: 10 }, user).rows };
  }

  const cur = sumByType(from, to);
  const prev = sumByType(pFrom, pTo);
  const bal = balances();
  const pendingCount = get("SELECT COUNT(*) AS n FROM transactions WHERE status='pending' AND deleted_at IS NULL").n;
  const receivable = projects({ status: 'active' }).reduce((s, p) => s + Math.max(0, p.debt_base), 0);
  return {
    limited: false,
    base,
    month,
    balances: bal,
    current: { ...cur, profit: cur.income - cur.expense },
    previous: { ...prev, profit: prev.income - prev.expense },
    series: monthlySeries(12, month),
    expenseByCategory: byCategory(from, to, 'expense'),
    incomeByCategory: byCategory(from, to, 'income'),
    upcoming: upcoming(45).slice(0, 10),
    pendingCount,
    receivable,
    recent: listTx({ limit: 8 }, user).rows,
  };
}

export function pnl(year) {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const rows = all(
    `SELECT t.type, substr(t.date,1,7) AS month, c.id AS category_id, COALESCE(c.name,'Без категорії') AS name,
       COALESCE(c.emoji,'•') AS emoji, SUM(t.amount_base) AS total
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.status='done' AND t.deleted_at IS NULL AND t.type IN ('income','expense') AND t.date BETWEEN ? AND ?
     GROUP BY t.type, month, c.id ORDER BY t.type DESC, total DESC`,
    from,
    to,
  );
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const build = (type) => {
    const cats = new Map();
    for (const r of rows.filter((x) => x.type === type)) {
      const key = r.category_id ?? 0;
      if (!cats.has(key)) cats.set(key, { id: r.category_id, name: r.name, emoji: r.emoji, months: Object.fromEntries(months.map((m) => [m, 0])), total: 0 });
      const c = cats.get(key);
      c.months[r.month] += r.total;
      c.total += r.total;
    }
    const list = [...cats.values()].sort((a, b) => b.total - a.total);
    const totals = Object.fromEntries(months.map((m) => [m, list.reduce((s, c) => s + c.months[m], 0)]));
    return { categories: list, totals, total: list.reduce((s, c) => s + c.total, 0) };
  };
  const income = build('income');
  const expense = build('expense');
  const profit = Object.fromEntries(months.map((m) => [m, income.totals[m] - expense.totals[m]]));
  return { base: baseCurrency(), year, months, income, expense, profit, total: income.total - expense.total };
}

/* ───────────────────────── Projects / clients / team ───────────────────────── */

export function projects(f = {}) {
  const base = baseCurrency();
  const rates = rateMap();
  const where = [];
  const p = [];
  if (f.status) {
    where.push('pr.status = ?');
    p.push(f.status);
  }
  if (f.client_id) {
    where.push('pr.client_id = ?');
    p.push(Number(f.client_id));
  }
  const rows = all(
    `SELECT pr.*, cl.name AS client_name, u.name AS manager_name,
       COALESCE((SELECT SUM(amount_base) FROM transactions WHERE project_id=pr.id AND type='income' AND status='done' AND deleted_at IS NULL),0) AS income_base,
       COALESCE((SELECT SUM(amount_base) FROM transactions WHERE project_id=pr.id AND type='expense' AND status='done' AND deleted_at IS NULL),0) AS expense_base,
       COALESCE((SELECT SUM(amount_base) FROM transactions WHERE project_id=pr.id AND type='income' AND status='planned' AND deleted_at IS NULL),0) AS planned_base,
       (SELECT MAX(date) FROM transactions WHERE project_id=pr.id AND deleted_at IS NULL) AS last_tx
     FROM projects pr
     LEFT JOIN clients cl ON cl.id = pr.client_id
     LEFT JOIN users u ON u.id = pr.manager_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY CASE pr.status WHEN 'active' THEN 0 WHEN 'lead' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, pr.created_at DESC`,
    ...p,
  );
  for (const r of rows) {
    let budgetBase = 0;
    try {
      budgetBase = convert(r.budget, r.currency, base, rates);
    } catch {}
    r.budget_base = budgetBase;
    r.profit_base = r.income_base - r.expense_base;
    r.debt_base = r.budget ? budgetBase - r.income_base : 0;
    r.paid_pct = budgetBase ? Math.min(100, Math.round((r.income_base / budgetBase) * 100)) : null;
    r.margin_pct = r.income_base ? Math.round((r.profit_base / r.income_base) * 100) : null;
  }
  return rows;
}

export function clients() {
  return all(
    `SELECT cl.*,
       (SELECT COUNT(*) FROM projects WHERE client_id = cl.id) AS projects_count,
       COALESCE((SELECT SUM(amount_base) FROM transactions WHERE client_id=cl.id AND type='income' AND status='done' AND deleted_at IS NULL),0) AS income_base,
       (SELECT MAX(date) FROM transactions WHERE client_id=cl.id AND type='income' AND status='done' AND deleted_at IS NULL) AS last_payment
     FROM clients cl ORDER BY cl.archived, income_base DESC, cl.name`,
  );
}

export function team(from, to) {
  return all(
    `SELECT u.id, u.name, u.username, u.role, u.status, u.position, u.tg_id,
       COALESCE((SELECT SUM(amount_base) FROM transactions WHERE member_id=u.id AND type='expense' AND status='done' AND deleted_at IS NULL AND date BETWEEN ? AND ?),0) AS paid_base,
       COALESCE((SELECT SUM(amount_base) FROM transactions WHERE member_id=u.id AND type='expense' AND status='planned' AND deleted_at IS NULL),0) AS planned_base,
       (SELECT COUNT(*) FROM transactions WHERE created_by=u.id AND deleted_at IS NULL) AS created_count,
       (SELECT MAX(date) FROM transactions WHERE member_id=u.id AND type='expense' AND status='done' AND deleted_at IS NULL) AS last_payout
     FROM users u WHERE u.status != 'blocked' ORDER BY u.status='pending' DESC, paid_base DESC, u.name`,
    from,
    to,
  );
}

/* ───────────────────────── Recurring ───────────────────────── */

export function runRecurring() {
  const ym = monthOf(today());
  const [, last] = monthBounds(ym);
  const lastDay = Number(last.slice(8));
  const created = [];
  for (const r of all('SELECT * FROM recurring WHERE active = 1 AND (last_month IS NULL OR last_month < ?)', ym)) {
    const day = String(Math.min(r.day_of_month, lastDay)).padStart(2, '0');
    try {
    tx(() => {
      const t = createTx(
        {
          type: r.type,
          status: 'planned',
          date: `${ym}-${day}`,
          amount: r.amount,
          account_id: r.account_id,
          category_id: r.category_id,
          project_id: r.project_id,
          client_id: r.client_id,
          member_id: r.member_id,
          comment: `🔁 ${r.title}`,
          recurring_id: r.id,
        },
        { id: null, role: 'admin' },
      );
      run('UPDATE recurring SET last_month = ? WHERE id = ?', ym, r.id);
      created.push(t);
    });
    } catch (e) {
      console.warn('recurring', r.id, e.message || e);
    }
  }
  return created;
}

export function recalcBase(userId) {
  const base = baseCurrency();
  const rates = rateMap();
  let n = 0;
  for (const t of all('SELECT id, amount, currency FROM transactions')) {
    const rate = rateBetween(t.currency, base, rates);
    run('UPDATE transactions SET rate = ?, amount_base = ? WHERE id = ?', rate, Math.round(t.amount * rate), t.id);
    n++;
  }
  audit(userId, 'recalc_base', 'settings', null, { base, n });
  return n;
}
