/**
 * Розширені можливості: шаблони, борги клієнтів, ліміти, прогноз каси, податки ФОП,
 * виплати команді, прибутковість, порівняння періодів, тижневий звіт, кабінет виконавця.
 * Усі суми — у мінорних одиницях (копійки/центи), як і в решті системи.
 */
import { all, get, getSetting, run, setSetting } from '../db.js';
import {
  HttpError, balances, can, createTx, listTx, monthBounds, monthOf, projects, shiftMonth, today,
} from './finance.js';
import { baseCurrency, convert, fmt, rateMap } from './money.js';

const bad = (m) => new HttpError(400, m);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const safeConvert = (minor, from, to, rates) => {
  try { return convert(minor, from, to, rates); } catch { return 0; }
};

/* ───────────── Шаблони (одна кнопка — одна операція) ───────────── */

export function listTemplates() {
  return all(
    `SELECT t.*, a.name AS account_name, a.currency, c.name AS category_name, p.name AS project_name, u.name AS member_name
     FROM templates t
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN projects p ON p.id = t.project_id
     LEFT JOIN users u ON u.id = t.member_id
     WHERE t.archived = 0 ORDER BY t.sort, t.id`,
  );
}

export function saveTemplate(b, id = null) {
  if (!String(b.title || '').trim()) throw bad('Вкажіть назву шаблону');
  if (!['income', 'expense'].includes(b.type)) throw bad('Невірний тип');
  const amount = Math.round(Number(b.amount));
  if (!(amount > 0)) throw bad('Сума має бути більше 0');
  if (!get('SELECT id FROM accounts WHERE id = ?', Number(b.account_id) || 0)) throw bad('Оберіть рахунок');
  if (b.category_id) {
    const c = get('SELECT kind FROM categories WHERE id = ?', Number(b.category_id));
    if (!c || c.kind !== b.type) throw bad('Категорія не відповідає типу');
  }
  const vals = [
    String(b.title).trim().slice(0, 80), b.emoji || '⚡', b.type, amount, Number(b.account_id),
    b.category_id || null, b.project_id || null, b.client_id || null, b.member_id || null,
    b.comment || null, Number(b.sort) || 0, b.archived ? 1 : 0,
  ];
  if (id) {
    run(`UPDATE templates SET title=?, emoji=?, type=?, amount=?, account_id=?, category_id=?, project_id=?, client_id=?,
         member_id=?, comment=?, sort=?, archived=? WHERE id=?`, ...vals, id);
    return get('SELECT * FROM templates WHERE id=?', id);
  }
  const r = run(`INSERT INTO templates(title, emoji, type, amount, account_id, category_id, project_id, client_id, member_id, comment, sort, archived)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, ...vals);
  return get('SELECT * FROM templates WHERE id=?', Number(r.lastInsertRowid));
}

export function useTemplate(id, user, overrides = {}) {
  const t = get('SELECT * FROM templates WHERE id = ? AND archived = 0', id);
  if (!t) throw new HttpError(404, 'Шаблон не знайдено');
  return createTx({
    type: t.type,
    amount: overrides.amount ? Math.round(Number(overrides.amount)) : t.amount,
    account_id: t.account_id,
    category_id: t.category_id,
    project_id: t.project_id,
    client_id: t.client_id,
    member_id: t.member_id,
    comment: overrides.comment || t.comment || `${t.emoji} ${t.title}`,
    date: overrides.date || today(),
  }, user);
}

/* ───────────── Борги клієнтів ───────────── */

export function debts() {
  const rates = rateMap();
  const t = today();
  return projects()
    .filter((p) => ['active', 'done', 'paused'].includes(p.status) && p.budget > 0)
    .map((p) => {
      const paid = all(
        `SELECT amount, currency FROM transactions WHERE project_id=? AND type='income' AND status='done' AND deleted_at IS NULL`,
        p.id,
      ).reduce((s, x) => s + safeConvert(x.amount, x.currency, p.currency, rates), 0);
      const left = p.budget - paid;
      return {
        project_id: p.id,
        project_name: p.name,
        client_id: p.client_id,
        client_name: p.client_name,
        currency: p.currency,
        budget: p.budget,
        paid,
        left,
        left_base: p.debt_base,
        deadline: p.deadline,
        overdue_days: p.deadline && p.deadline < t ? Math.round((Date.parse(t) - Date.parse(p.deadline)) / 864e5) : 0,
        last_payment: get(`SELECT MAX(date) AS d FROM transactions WHERE project_id=? AND type='income' AND status='done' AND deleted_at IS NULL`, p.id).d,
      };
    })
    .filter((d) => d.left > 100) // більше 1 грн/$ — копійки округлення не вважаємо боргом
    .sort((a, b) => b.overdue_days - a.overdue_days || b.left_base - a.left_base);
}

export function reminderText(d) {
  const company = getSetting('company_name') || 'King Kong Lab';
  const hello = d.client_name ? `Добрий день, ${d.client_name}!` : 'Добрий день!';
  return `${hello}\n\nНагадуємо про оплату за проєкт «${d.project_name}».\n`
    + `Сума за договором: ${fmt(d.budget, d.currency)}\nОплачено: ${fmt(d.paid, d.currency)}\n`
    + `До сплати: ${fmt(d.left, d.currency)}${d.deadline ? `\nТермін: ${d.deadline}` : ''}\n\n`
    + `Якщо оплату вже здійснено — дякуємо, просто дайте знати.\nЗ повагою, ${company}`;
}

/* ───────────── Ліміти за категоріями ───────────── */

/** Повертає попередження, якщо після операції витрати категорії за місяць ≥80% або >100% ліміту. */
export function checkLimit(tx) {
  if (!tx || tx.type !== 'expense' || tx.status !== 'done' || !tx.category_id) return null;
  const cat = get('SELECT * FROM categories WHERE id = ?', tx.category_id);
  if (!cat?.monthly_limit) return null;
  const ym = monthOf(tx.date);
  const [from, to] = monthBounds(ym);
  const spent = get(
    `SELECT COALESCE(SUM(amount_base),0) AS s FROM transactions
     WHERE category_id=? AND type='expense' AND status='done' AND deleted_at IS NULL AND date BETWEEN ? AND ?`,
    cat.id, from, to,
  ).s;
  const pct = Math.round((spent / cat.monthly_limit) * 100);
  const level = pct > 100 ? 'over' : pct >= 80 ? 'near' : null;
  if (!level) return null;
  const key = `limit:${cat.id}:${ym}:${level}`;
  if (get('SELECT key FROM alerts_sent WHERE key = ?', key)) return null;
  run('INSERT INTO alerts_sent(key) VALUES(?)', key);
  const base = baseCurrency();
  return {
    level,
    pct,
    text: `${level === 'over' ? '🚨' : '⚠️'} ${cat.emoji} <b>${cat.name}</b>: витрачено ${fmt(spent, base)} з ліміту ${fmt(cat.monthly_limit, base)} (${pct}%) за ${ym}.`,
  };
}

/* ───────────── Податки ФОП ───────────── */

export const TAX_DEFAULTS = {
  fop_group: '3',
  tax_rate: '5',
  military_rate: '1',
  esv_month: '190234',
  group_fixed: '172940',
  military_fixed: '86470',
  tax_accounts: '',
};
const LIMITS = { 1: 144404900, 2: 721159800, 3: 1009104900 };

export function taxSettings() {
  const s = {};
  for (const [k, v] of Object.entries(TAX_DEFAULTS)) s[k] = getSetting(`tax_${k}`, v);
  return {
    group: s.fop_group,
    tax_rate: Number(s.tax_rate),
    military_rate: Number(s.military_rate),
    esv_month: Number(s.esv_month),
    group_fixed: Number(s.group_fixed),
    military_fixed: Number(s.military_fixed),
    tax_accounts: s.tax_accounts ? s.tax_accounts.split(',').map(Number).filter(Boolean) : [],
  };
}

export function saveTaxSettings(b) {
  const map = {
    group: 'fop_group', tax_rate: 'tax_rate', military_rate: 'military_rate', esv_month: 'esv_month',
    group_fixed: 'group_fixed', military_fixed: 'military_fixed',
  };
  for (const [k, key] of Object.entries(map)) {
    if (b[k] === undefined || b[k] === null || b[k] === '') continue;
    if (k === 'group' && !['1', '2', '3', 'none'].includes(String(b[k]))) throw bad('Група: 1, 2, 3 або none');
    if (k !== 'group' && !(Number(b[k]) >= 0)) throw bad('Невірне значення');
    setSetting(`tax_${key}`, String(b[k]));
  }
  if (Array.isArray(b.tax_accounts)) setSetting('tax_tax_accounts', b.tax_accounts.map(Number).filter(Boolean).join(','));
  return taxSettings();
}

function quarterOf(date) {
  const y = Number(date.slice(0, 4));
  const q = Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;
  const from = `${y}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
  const to = monthBounds(`${y}-${String(q * 3).padStart(2, '0')}`)[1];
  return { y, q, from, to };
}

function fopIncomeUAH(from, to, s, rates) {
  const accIds = s.tax_accounts.length ? s.tax_accounts : all("SELECT id FROM accounts WHERE type='bank'").map((a) => a.id);
  if (!accIds.length) return 0;
  const rows = all(
    `SELECT amount, currency FROM transactions WHERE type='income' AND status='done' AND deleted_at IS NULL
     AND date BETWEEN ? AND ? AND account_id IN (${accIds.map(() => '?').join(',')})`,
    from, to, ...accIds,
  );
  return rows.reduce((sum, r) => sum + safeConvert(r.amount, r.currency, 'UAH', rates), 0);
}

/** Розрахунок податків поточного й попереднього кварталу та найближчі дедлайни. */
export function taxes(at = today()) {
  const s = taxSettings();
  const rates = rateMap();
  if (s.group === 'none') return { enabled: false, settings: s, items: [] };
  const cur = quarterOf(at);
  const prevEnd = addDays(cur.from, -1);
  const prev = quarterOf(prevEnd);
  const ytdIncome = fopIncomeUAH(`${cur.y}-01-01`, at, s, rates);
  const items = [];
  const quarterBlock = (qq) => {
    const income = fopIncomeUAH(qq.from, qq.to, s, rates);
    const esvDue = `${qq.to.slice(0, 4) === String(qq.y) && qq.q === 4 ? qq.y + 1 : qq.y}-${String((qq.q * 3) % 12 + 1).padStart(2, '0')}-20`;
    const out = { quarter: `${qq.q} кв. ${qq.y}`, from: qq.from, to: qq.to, income };
    out.esv = { amount: s.esv_month * 3, due: esvDue };
    if (s.group === '3') {
      const due = addDays(qq.to, 50);
      out.single_tax = { amount: Math.round(income * s.tax_rate / 100), due };
      out.military = { amount: Math.round(income * s.military_rate / 100), due };
    }
    return out;
  };
  const quarters = [quarterBlock(prev), quarterBlock(cur)];
  for (const qb of quarters) {
    if (qb.single_tax) items.push({ title: `Єдиний податок ${s.tax_rate}% · ${qb.quarter}`, ...qb.single_tax });
    if (qb.military) items.push({ title: `Військовий збір ${s.military_rate}% · ${qb.quarter}`, ...qb.military });
    items.push({ title: `ЄСВ · ${qb.quarter}`, ...qb.esv });
  }
  if (s.group === '1' || s.group === '2') {
    // фіксований ЄП і ВЗ — щомісяця до 20 числа поточного місяця
    for (const m of [monthOf(at), shiftMonth(monthOf(at), 1)]) {
      const due = `${m}-20`;
      if (s.group_fixed) items.push({ title: `Єдиний податок (${s.group} гр.) · ${m}`, amount: s.group_fixed, due });
      if (s.military_fixed) items.push({ title: `Військовий збір · ${m}`, amount: s.military_fixed, due });
    }
  }
  const upcoming = items
    .filter((i) => i.due >= addDays(at, -30) && i.amount > 0)
    .sort((a, b) => a.due.localeCompare(b.due))
    .map((i) => {
      const paid = Boolean(get("SELECT id FROM transactions WHERE comment = ? AND status = 'done' AND deleted_at IS NULL", `🧾 ${i.title}`));
      const plannedTx = Boolean(get("SELECT id FROM transactions WHERE comment = ? AND status = 'planned' AND deleted_at IS NULL", `🧾 ${i.title}`));
      return { ...i, paid, planned: plannedTx, days_left: Math.round((Date.parse(i.due) - Date.parse(at)) / 864e5) };
    })
    .filter((i) => !(i.paid && i.days_left < 0));
  const limit = LIMITS[s.group] || null;
  return {
    enabled: true,
    settings: s,
    currency: 'UAH',
    quarters,
    items: upcoming,
    ytd_income: ytdIncome,
    limit,
    limit_pct: limit ? Math.round((ytdIncome / limit) * 100) : null,
  };
}

/** Створює заплановані платежі для податків, яких ще немає в плані. */
export function planTaxes(user, accountId) {
  const t = taxes();
  if (!t.enabled) return [];
  const acc = get('SELECT * FROM accounts WHERE id = ?', Number(accountId) || 0)
    || get("SELECT * FROM accounts WHERE archived=0 AND currency='UAH' ORDER BY type='bank' DESC, sort LIMIT 1");
  if (!acc) throw bad('Немає гривневого рахунку для податків');
  const cat = get("SELECT id FROM categories WHERE kind='expense' AND name='Податки'");
  const rates = rateMap();
  const created = [];
  for (const i of t.items) {
    if (i.due < today()) continue;
    const comment = `🧾 ${i.title}`;
    if (i.paid || get('SELECT id FROM transactions WHERE comment = ? AND deleted_at IS NULL', comment)) continue;
    const amount = acc.currency === 'UAH' ? i.amount : safeConvert(i.amount, 'UAH', acc.currency, rates);
    created.push(createTx({ type: 'expense', status: 'planned', date: i.due, amount, account_id: acc.id, category_id: cat?.id, comment }, user));
  }
  return created;
}

/* ───────────── Прогноз каси ───────────── */

export function forecast(weeks = 4) {
  const base = baseCurrency();
  const rates = rateMap();
  const t = today();
  const end = addDays(t, weeks * 7);
  const bal = balances();
  let running = bal.total;
  const planned = all(
    `SELECT t.*, c.name AS category_name FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
     WHERE t.status='planned' AND t.deleted_at IS NULL AND t.type IN ('income','expense') AND t.date <= ? ORDER BY t.date`,
    end,
  );
  // регулярні, які ще не згенеровані на майбутні місяці
  const recurring = [];
  for (const r of all('SELECT r.*, a.currency FROM recurring r LEFT JOIN accounts a ON a.id = r.account_id WHERE r.active = 1')) {
    for (let m = monthOf(t); m <= monthOf(end); m = shiftMonth(m, 1)) {
      if (r.last_month && r.last_month >= m) continue;
      const lastDay = Number(monthBounds(m)[1].slice(8));
      const date = `${m}-${String(Math.min(r.day_of_month, lastDay)).padStart(2, '0')}`;
      if (date < t || date > end) continue;
      recurring.push({ type: r.type, date, amount: r.amount, currency: r.currency || base, comment: `🔁 ${r.title}`, recurring: true });
    }
  }
  const items = [...planned, ...recurring].map((x) => ({
    ...x,
    amount_base: safeConvert(x.amount, x.currency, base, rates),
    overdue: x.date < t,
  }));
  const out = [];
  let min = { value: running, date: t };
  for (let w = 0; w < weeks; w++) {
    const from = addDays(t, w * 7);
    const to = addDays(t, w * 7 + 6);
    const inWeek = items.filter((x) => (w === 0 ? x.date <= to : x.date >= from && x.date <= to));
    const income = inWeek.filter((x) => x.type === 'income').reduce((s, x) => s + x.amount_base, 0);
    const expense = inWeek.filter((x) => x.type === 'expense').reduce((s, x) => s + x.amount_base, 0);
    running += income - expense;
    if (running < min.value) min = { value: running, date: to };
    out.push({ from, to, income, expense, end_balance: running, items: inWeek.map((x) => ({ date: x.date, type: x.type, amount: x.amount, currency: x.currency, comment: x.comment || x.category_name, overdue: x.overdue })) });
  }
  return { base, start_balance: bal.total, weeks: out, min_balance: min.value, min_date: min.date, gap: min.value < 0 };
}

/* ───────────── Команда: ставки й виплати ───────────── */

export function projectMembers(projectId) {
  return all(
    `SELECT pm.*, u.name, u.username FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.name`,
    projectId,
  );
}

export function setProjectMember(projectId, b) {
  if (!get('SELECT id FROM projects WHERE id=?', projectId)) throw new HttpError(404, 'Проєкт не знайдено');
  const userId = Number(b.user_id);
  if (!get('SELECT id FROM users WHERE id=?', userId)) throw bad('Оберіть людину');
  if (b.remove) {
    run('DELETE FROM project_members WHERE project_id=? AND user_id=?', projectId, userId);
    return projectMembers(projectId);
  }
  const kind = b.kind === 'fixed' ? 'fixed' : 'pct';
  const value = Number(b.value);
  if (!(value >= 0)) throw bad('Вкажіть ставку');
  if (kind === 'pct' && value > 100) throw bad('Відсоток не може бути більше 100');
  const stored = kind === 'fixed' ? Math.round(value) : value; // fixed — у мінорних одиницях валюти проєкту
  run(
    `INSERT INTO project_members(project_id, user_id, kind, value, role) VALUES(?,?,?,?,?)
     ON CONFLICT(project_id, user_id) DO UPDATE SET kind=excluded.kind, value=excluded.value, role=excluded.role`,
    projectId, userId, kind, stored, b.role || null,
  );
  return projectMembers(projectId);
}

/** Нараховано / виплачено / до виплати по кожній людині (у базовій валюті). */
export function payouts({ userId = null } = {}) {
  const base = baseCurrency();
  const rates = rateMap();
  const rows = all(
    `SELECT pm.*, u.name AS user_name, p.name AS project_name, p.currency AS project_currency, p.status AS project_status
     FROM project_members pm JOIN users u ON u.id = pm.user_id JOIN projects p ON p.id = pm.project_id
     ${userId ? 'WHERE pm.user_id = ?' : ''} ORDER BY u.name, p.name`,
    ...(userId ? [userId] : []),
  );
  const people = new Map();
  for (const r of rows) {
    const received = get(
      `SELECT COALESCE(SUM(amount_base),0) AS s FROM transactions WHERE project_id=? AND type='income' AND status='done' AND deleted_at IS NULL`,
      r.project_id,
    ).s;
    const accrued = r.kind === 'pct'
      ? Math.round(received * r.value / 100)
      : safeConvert(r.value, r.project_currency, base, rates);
    const paid = get(
      `SELECT COALESCE(SUM(amount_base),0) AS s FROM transactions WHERE project_id=? AND member_id=? AND type='expense' AND status='done' AND deleted_at IS NULL`,
      r.project_id, r.user_id,
    ).s;
    const planned = get(
      `SELECT COALESCE(SUM(amount_base),0) AS s FROM transactions WHERE project_id=? AND member_id=? AND type='expense' AND status='planned' AND deleted_at IS NULL`,
      r.project_id, r.user_id,
    ).s;
    if (!people.has(r.user_id)) people.set(r.user_id, { user_id: r.user_id, name: r.user_name, accrued: 0, paid: 0, planned: 0, due: 0, projects: [] });
    const p = people.get(r.user_id);
    const due = Math.max(0, accrued - paid - planned);
    p.accrued += accrued;
    p.paid += paid;
    p.planned += planned;
    p.due += due;
    p.projects.push({ project_id: r.project_id, project_name: r.project_name, status: r.project_status, kind: r.kind, value: r.value, currency: r.project_currency, received, accrued, paid, planned, due });
  }
  const list = [...people.values()].sort((a, b) => b.due - a.due);
  return { base, people: list, total_due: list.reduce((s, x) => s + x.due, 0) };
}

/** Створює заплановані виплати на суму «до виплати». */
export function planPayouts(user, accountId, userIds = null) {
  const acc = get('SELECT * FROM accounts WHERE id=? AND archived=0', Number(accountId) || 0);
  if (!acc) throw bad('Оберіть рахунок для виплат');
  const base = baseCurrency();
  const rates = rateMap();
  const cat = get("SELECT id FROM categories WHERE kind='expense' AND name='Виплати команді'");
  const created = [];
  for (const person of payouts().people) {
    if (userIds && !userIds.includes(person.user_id)) continue;
    for (const pr of person.projects) {
      if (pr.due <= 0) continue;
      const amount = safeConvert(pr.due, base, acc.currency, rates);
      if (amount <= 0) continue;
      created.push(createTx({
        type: 'expense', status: 'planned', date: today(), amount, account_id: acc.id, category_id: cat?.id,
        project_id: pr.project_id, member_id: person.user_id, comment: `👥 Виплата · ${person.name} · ${pr.project_name}`,
      }, user));
    }
  }
  return created;
}

/* ───────────── Прибутковість ───────────── */

export function profitability(from, to) {
  const base = baseCurrency();
  const byMember = all(
    `SELECT u.id, u.name,
       COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount_base END),0) AS income,
       COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount_base END),0) AS expense,
       COUNT(DISTINCT t.project_id) AS projects
     FROM transactions t JOIN users u ON u.id = t.member_id
     WHERE t.status='done' AND t.deleted_at IS NULL AND t.date BETWEEN ? AND ? AND t.type IN ('income','expense')
     GROUP BY u.id ORDER BY income - expense DESC`,
    from, to,
  ).map((r) => ({ ...r, profit: r.income - r.expense, margin: r.income ? Math.round(((r.income - r.expense) / r.income) * 100) : null }));

  const projRows = all(
    `SELECT p.id, p.name, p.work_type,
       COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount_base END),0) AS income,
       COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount_base END),0) AS expense,
       (SELECT c.name FROM transactions t2 JOIN categories c ON c.id=t2.category_id
         WHERE t2.project_id=p.id AND t2.type='income' AND t2.deleted_at IS NULL GROUP BY c.id ORDER BY SUM(t2.amount_base) DESC LIMIT 1) AS main_category
     FROM projects p JOIN transactions t ON t.project_id = p.id
     WHERE t.status='done' AND t.deleted_at IS NULL AND t.date BETWEEN ? AND ?
     GROUP BY p.id`,
    from, to,
  );
  const types = new Map();
  for (const p of projRows) {
    const key = p.work_type || p.main_category || 'Інше';
    if (!types.has(key)) types.set(key, { name: key, income: 0, expense: 0, projects: 0 });
    const x = types.get(key);
    x.income += p.income;
    x.expense += p.expense;
    x.projects += 1;
  }
  const byType = [...types.values()]
    .map((x) => ({ ...x, profit: x.income - x.expense, margin: x.income ? Math.round(((x.income - x.expense) / x.income) * 100) : null }))
    .sort((a, b) => b.profit - a.profit);
  const byProject = projRows
    .map((p) => ({ ...p, profit: p.income - p.expense, margin: p.income ? Math.round(((p.income - p.expense) / p.income) * 100) : null }))
    .sort((a, b) => b.profit - a.profit);
  return { base, from, to, byMember, byType, byProject };
}

/* ───────────── Порівняння періодів ───────────── */

function totals(from, to) {
  return get(
    `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_base END),0) AS income,
            COALESCE(SUM(CASE WHEN type='expense' THEN amount_base END),0) AS expense
     FROM transactions WHERE status='done' AND deleted_at IS NULL AND date BETWEEN ? AND ?`,
    from, to,
  );
}
const pctChange = (a, b) => (b ? Math.round(((a - b) / Math.abs(b)) * 100) : null);

export function compare(month = monthOf(today())) {
  const base = baseCurrency();
  const mk = (ym) => {
    const [from, to] = monthBounds(ym);
    const t = totals(from, to);
    return { month: ym, income: t.income, expense: t.expense, profit: t.income - t.expense };
  };
  const cur = mk(month);
  const prev = mk(shiftMonth(month, -1));
  const yearAgo = mk(shiftMonth(month, -12));
  const diff = (a, b) => ({
    income: pctChange(a.income, b.income), expense: pctChange(a.expense, b.expense), profit: pctChange(a.profit, b.profit),
  });
  const ytdCur = totals(`${month.slice(0, 4)}-01-01`, monthBounds(month)[1]);
  const ytdPrevYear = String(Number(month.slice(0, 4)) - 1);
  const ytdPrev = totals(`${ytdPrevYear}-01-01`, monthBounds(`${ytdPrevYear}${month.slice(4)}`)[1]);
  return {
    base,
    current: cur,
    previous: prev,
    year_ago: yearAgo,
    vs_previous: diff(cur, prev),
    vs_year_ago: diff(cur, yearAgo),
    ytd: { income: ytdCur.income, expense: ytdCur.expense, profit: ytdCur.income - ytdCur.expense },
    ytd_prev: { income: ytdPrev.income, expense: ytdPrev.expense, profit: ytdPrev.income - ytdPrev.expense },
  };
}

/* ───────────── Тижневий звіт ───────────── */

export function weeklyReport(at = today()) {
  const base = baseCurrency();
  const from = addDays(at, -6);
  const w = totals(from, at);
  const [mFrom] = monthBounds(monthOf(at));
  const m = totals(mFrom, at);
  const topClients = all(
    `SELECT cl.name, SUM(t.amount_base) AS total FROM transactions t JOIN clients cl ON cl.id = t.client_id
     WHERE t.type='income' AND t.status='done' AND t.deleted_at IS NULL AND t.date BETWEEN ? AND ?
     GROUP BY cl.id ORDER BY total DESC LIMIT 5`,
    mFrom, at,
  );
  const next = all(
    `SELECT date, type, amount, currency, comment FROM transactions
     WHERE status='planned' AND deleted_at IS NULL AND date BETWEEN ? AND ? ORDER BY date LIMIT 8`,
    addDays(at, -30), addDays(at, 7),
  );
  const d = debts().slice(0, 5);
  const tx = taxes(at);
  const taxSoon = tx.enabled ? tx.items.filter((i) => !i.paid && i.days_left >= 0 && i.days_left <= 14) : [];
  const L = [];
  L.push(`📅 <b>Тиждень ${from} — ${at}</b>`);
  L.push(`Доходи: <b>${fmt(w.income, base)}</b>\nВитрати: <b>${fmt(w.expense, base)}</b>\nПрибуток: <b>${fmt(w.income - w.expense, base)}</b>`);
  L.push(`📊 <b>Місяць до сьогодні</b>\nДоходи ${fmt(m.income, base)} · витрати ${fmt(m.expense, base)} · прибуток <b>${fmt(m.income - m.expense, base)}</b>`);
  if (topClients.length) L.push(`🏆 <b>Топ-клієнти місяця</b>\n${topClients.map((c, i) => `${i + 1}. ${esc(c.name)} — ${fmt(c.total, base)}`).join('\n')}`);
  if (d.length) L.push(`📌 <b>Борги клієнтів</b>\n${d.map((x) => `• ${esc(x.client_name || x.project_name)} — ${fmt(x.left, x.currency)}${x.overdue_days ? ` (прострочено ${x.overdue_days} дн.)` : ''}`).join('\n')}`);
  if (next.length) L.push(`🗓 <b>Платежі на тиждень</b>\n${next.map((x) => `${x.date < at ? '⚠️' : '•'} ${x.date} ${x.type === 'income' ? '+' : '−'}${fmt(x.amount, x.currency)} ${esc(x.comment || '')}`).join('\n')}`);
  if (taxSoon.length) L.push(`🧾 <b>Податки</b>\n${taxSoon.map((i) => `• ${esc(i.title)} — ${fmt(i.amount, 'UAH')} до ${i.due}`).join('\n')}`);
  return L.join('\n\n');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/* ───────────── Кабінет виконавця ───────────── */

export function memberCabinet(user) {
  const base = baseCurrency();
  const p = payouts({ userId: user.id });
  const me = p.people[0] || { accrued: 0, paid: 0, planned: 0, due: 0, projects: [] };
  const ym = monthOf(today());
  const [from, to] = monthBounds(ym);
  const month = get(
    `SELECT COALESCE(SUM(amount_base),0) AS s FROM transactions WHERE member_id=? AND type='expense' AND status='done' AND deleted_at IS NULL AND date BETWEEN ? AND ?`,
    user.id, from, to,
  ).s;
  const pending = get("SELECT COUNT(*) AS n FROM transactions WHERE created_by=? AND status='pending' AND deleted_at IS NULL", user.id).n;
  const upcomingPayouts = all(
    `SELECT t.date, t.amount, t.currency, t.comment, p.name AS project_name FROM transactions t LEFT JOIN projects p ON p.id=t.project_id
     WHERE t.member_id=? AND t.type='expense' AND t.status='planned' AND t.deleted_at IS NULL ORDER BY t.date LIMIT 10`,
    user.id,
  );
  return {
    base,
    month: ym,
    paid_month: month,
    accrued: me.accrued,
    paid: me.paid,
    planned: me.planned,
    due: me.due,
    projects: me.projects,
    pending,
    upcoming: upcomingPayouts,
    recent: listTx({ limit: 15 }, user).rows,
  };
}

export const canSeeMoney = (u) => can.seeAll(u);
