/**
 * Двостороння синхронізація з Google-таблицею через Apps Script (docs/google-sheet-sync.gs).
 * Таблиця тягне дані (export) і надсилає змінені рядки (upsert/remove). Авторизація — SHEET_SYNC_TOKEN.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { all, get, run } from '../db.js';
import { HttpError, createTx, deleteTx, getTx, listTx, projects, today, updateTx } from './finance.js';
import { fromMinor, toMinor } from './money.js';
import { SECTIONS, deleteDeal, getDeal, listDeals, monthlySummary, saveDeal } from './deals.js';

const SYSTEM = { id: null, role: 'admin', name: 'Google-таблиця' };
const TYPE_UA = { income: 'Дохід', expense: 'Витрата', transfer: 'Переказ' };
const STATUS_UA = { done: 'Проведено', planned: 'План', pending: 'На перевірці', rejected: 'Відхилено' };
const PSTATUS_UA = { lead: 'Лід', active: 'В роботі', paused: 'Пауза', done: 'Завершено', cancelled: 'Скасовано' };
const inv = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v.toLowerCase(), k]));
const TYPE_IN = { ...inv(TYPE_UA), дохід: 'income', доход: 'income', витрата: 'expense', переказ: 'transfer', '+': 'income', '-': 'expense' };
const STATUS_IN = { ...inv(STATUS_UA), проведено: 'done', план: 'planned', заплановано: 'planned' };
const PSTATUS_IN = inv(PSTATUS_UA);

export const OPERATION_COLUMNS = ['ID', 'Дата', 'Тип', 'Статус', 'Сума', 'Валюта', 'Рахунок', 'На рахунок', 'Категорія', 'Проєкт', 'Клієнт', 'Виконавець', 'Коментар', 'Сума в базі'];
export const PROJECT_COLUMNS = ['ID', 'Назва', 'Клієнт', 'Статус', 'Тип роботи', 'Бюджет', 'Валюта', 'Оплачено (база)', 'Борг (база)', 'Прибуток (база)', 'Початок', 'Дедлайн', 'Спосіб оплати', 'Нотатки'];
export const DEAL_COLUMNS = ['ID', 'Розділ', 'Виконавець', 'Замовник', 'Тип роботи', 'Завдання', 'Дата початку', 'Дата завершення', 'Метод оплати',
  'Передоплата', 'Передоплата прог.', 'Ціна', 'Маржа', 'доп послуга, ціна, число оплати', 'Закрита', 'Виконавцю всього', 'Замовник винен', 'Виконавцю ще'];
const READONLY = new Set(['Сума в базі', 'Оплачено (база)', 'Борг (база)', 'Прибуток (база)', 'Валюта', 'Виконавцю всього', 'Замовник винен', 'Виконавцю ще']);

/** Сума як у таблиці: «5000грн», «74$». */
const sheetMoney = (minor, cur) => {
  if (minor === null || minor === undefined) return '';
  const n = fromMinor(minor);
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
  return cur === 'UAH' ? `${s}грн` : `${s}$`;
};
const isoToSheet = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '');
function dealRow(d) {
  const c = d.calc;
  return [
    d.id, d.section, d.executor, d.client, d.type, d.task, isoToSheet(d.start_date), isoToSheet(d.end_date), d.method,
    sheetMoney(d.prepay, d.prepay_currency), sheetMoney(d.prog_prepay, d.prog_currency), sheetMoney(d.price, d.currency),
    d.margin === null ? '' : sheetMoney(d.margin, d.margin_currency), d.extra || '', d.closed ? 'так' : 'ні',
    sheetMoney(c.executor_total, c.currency), sheetMoney(c.client_left, c.currency), sheetMoney(c.executor_left, c.currency),
  ];
}

export function checkSyncToken(token) {
  if (!config.syncToken) throw new HttpError(503, 'Синхронізацію вимкнено: задайте SHEET_SYNC_TOKEN на сервері');
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(config.syncToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Невірний токен синхронізації');
}

const num = (minor) => fromMinor(minor);

export function exportAll() {
  // listTx віддає по 500 — гортаємо сторінками все за поточний і минулий рік
  const from = `${Number(today().slice(0, 4)) - 1}-01-01`;
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = listTx({ from, limit: 500, offset }, SYSTEM).rows;
    rows.push(...page);
    if (page.length < 500) break;
  }
  const operations = rows.map((t) => [
    t.id, t.date, TYPE_UA[t.type], STATUS_UA[t.status], num(t.amount), t.currency, t.account_name || '', t.to_account_name || '',
    t.category_name || '', t.project_name || '', t.client_name || '', t.member_name || '', t.comment || '', num(t.amount_base),
  ]);
  const projectRows = projects().map((p) => [
    p.id, p.name, p.client_name || '', PSTATUS_UA[p.status] || p.status, p.work_type || '', num(p.budget), p.currency,
    num(p.income_base), num(Math.max(0, p.debt_base)), num(p.profit_base), p.start_date || '', p.deadline || '', p.payment_method || '', p.notes || '',
  ]);
  const summary = monthlySummary();
  const sumCols = ['Місяць', ...summary.sections, 'Прибуток'];
  return {
    updated_at: new Date().toISOString(),
    deals: { columns: DEAL_COLUMNS, rows: listDeals().map(dealRow), readonly: DEAL_COLUMNS.filter((c) => READONLY.has(c)) },
    summary: {
      columns: sumCols,
      rows: summary.months.map((m) => [m, ...summary.sections.map((x) => fromMinor(summary.table[m][x])), fromMinor(summary.table[m]['Прибуток'])]),
      readonly: sumCols,
    },
    operations: { columns: OPERATION_COLUMNS, rows: operations, readonly: OPERATION_COLUMNS.filter((c) => READONLY.has(c)) },
    projects: { columns: PROJECT_COLUMNS, rows: projectRows, readonly: PROJECT_COLUMNS.filter((c) => READONLY.has(c)) },
    lists: {
      types: Object.values(TYPE_UA),
      statuses: ['Проведено', 'План'],
      project_statuses: Object.values(PSTATUS_UA),
      sections: SECTIONS,
      methods: ['Карта', 'ФОП', 'крипта', 'Fh', 'Готівка'],
      closed: ['так', 'ні'],
      accounts: all('SELECT name FROM accounts WHERE archived=0 ORDER BY sort, id').map((r) => r.name),
      categories: all('SELECT name FROM categories WHERE archived=0 ORDER BY kind, sort, id').map((r) => r.name),
      members: all("SELECT name FROM users WHERE status='active' ORDER BY name").map((r) => r.name),
    },
  };
}

function cellDate(v) {
  if (v === '' || v == null) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
const byName = (table, name, extraWhere = '') => {
  const n = String(name || '').trim();
  if (!n) return null;
  return get(`SELECT * FROM ${table} WHERE lower(name) = lower(?) ${extraWhere}`, n) || null;
};
function needByName(table, name, label) {
  const r = byName(table, name);
  if (!r) throw new HttpError(400, `${label} «${name}» не знайдено в боті`);
  return r;
}
function clientId(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const c = byName('clients', n);
  if (c) return c.id;
  return Number(run('INSERT INTO clients(name) VALUES(?)', n).lastInsertRowid);
}

function rowToTx(r) {
  const type = TYPE_IN[String(r['Тип'] || '').trim().toLowerCase()];
  if (!type) throw new HttpError(400, 'Тип: Дохід, Витрата або Переказ');
  const status = STATUS_IN[String(r['Статус'] || 'Проведено').trim().toLowerCase()] || 'done';
  const acc = needByName('accounts', r['Рахунок'], 'Рахунок');
  const out = {
    type,
    status: ['planned', 'done'].includes(status) ? status : undefined, // «На перевірці» не схвалюємо з таблиці
    date: cellDate(r['Дата']) || today(),
    amount: toMinor(Math.abs(Number(String(r['Сума']).replace(/\s/g, '').replace(',', '.')))),
    account_id: acc.id,
    comment: r['Коментар'] || null,
  };
  if (type === 'transfer') out.to_account_id = needByName('accounts', r['На рахунок'], 'Рахунок призначення').id;
  else if (String(r['Категорія'] || '').trim()) {
    const c = get('SELECT id FROM categories WHERE lower(name)=lower(?) AND kind=?', String(r['Категорія']).trim(), type);
    if (!c) throw new HttpError(400, `Категорія «${r['Категорія']}» не підходить для типу «${TYPE_UA[type]}»`);
    out.category_id = c.id;
  }
  out.client_id = clientId(r['Клієнт']);
  if (String(r['Проєкт'] || '').trim()) {
    const p = byName('projects', r['Проєкт']);
    out.project_id = p ? p.id : Number(run('INSERT INTO projects(name, client_id) VALUES(?,?)', String(r['Проєкт']).trim(), out.client_id).lastInsertRowid);
  } else out.project_id = null;
  out.member_id = String(r['Виконавець'] || '').trim() ? needByName('users', r['Виконавець'], 'Виконавця').id : null;
  return out;
}

function projectRow(id) {
  return exportAll().projects.rows.find((x) => x[0] === id);
}

/** Зберегти змінений у таблиці рядок. Повертає оновлений рядок (з ID і розрахованими колонками). */
export function upsertRow(sheet, cols, values) {
  const r = Object.fromEntries(cols.map((c, i) => [String(c).trim(), values[i]]));
  const id = Number(r.ID) || null;
  if (sheet === 'operations') {
    if (!String(r['Сума'] ?? '').trim() && !id) return null; // порожній новий рядок
    const data = rowToTx(r);
    const t = id ? updateTx(id, data, SYSTEM) : createTx(data, SYSTEM);
    const fresh = getTx(t.id);
    return [fresh.id, fresh.date, TYPE_UA[fresh.type], STATUS_UA[fresh.status], num(fresh.amount), fresh.currency, fresh.account_name || '',
      fresh.to_account_name || '', fresh.category_name || '', fresh.project_name || '', fresh.client_name || '', fresh.member_name || '',
      fresh.comment || '', num(fresh.amount_base)];
  }
  if (sheet === 'deals') {
    if (!String(r['Ціна'] ?? '').trim() && !String(r['Передоплата'] ?? '').trim()) return null;
    const input = {
      section: r['Розділ'], executor: r['Виконавець'], client: r['Замовник'], type: r['Тип роботи'], task: r['Завдання'],
      start: cellDate(r['Дата початку']) || r['Дата початку'], end: cellDate(r['Дата завершення']) || r['Дата завершення'],
      method: r['Метод оплати'], prepay: String(r['Передоплата'] ?? ''), prog: String(r['Передоплата прог.'] ?? ''),
      price: String(r['Ціна'] ?? ''), margin: String(r['Маржа'] ?? ''), extra: r['доп послуга, ціна, число оплати'],
      closed: /^(так|yes|true|1|✅|закрит)/i.test(String(r['Закрита'] ?? '').trim()),
    };
    const exists = id && getDeal(id);
    const d = saveDeal(input, SYSTEM, { id: exists ? id : null });
    return dealRow(d);
  }
  if (sheet === 'projects') {
    const name = String(r['Назва'] || '').trim();
    if (!name) return null;
    const vals = {
      name,
      client_id: clientId(r['Клієнт']),
      status: PSTATUS_IN[String(r['Статус'] || '').trim().toLowerCase()] || 'active',
      work_type: r['Тип роботи'] || null,
      budget: toMinor(Number(String(r['Бюджет'] || 0).replace(/\s/g, '').replace(',', '.')) || 0),
      start_date: cellDate(r['Початок']),
      deadline: cellDate(r['Дедлайн']),
      payment_method: r['Спосіб оплати'] || null,
      notes: r['Нотатки'] || null,
    };
    let pid = id;
    if (pid && get('SELECT id FROM projects WHERE id=?', pid)) {
      run('UPDATE projects SET name=?, client_id=?, status=?, work_type=?, budget=?, start_date=?, deadline=?, payment_method=?, notes=? WHERE id=?',
        vals.name, vals.client_id, vals.status, vals.work_type, vals.budget, vals.start_date, vals.deadline, vals.payment_method, vals.notes, pid);
    } else {
      const currency = ['USD', 'UAH', 'EUR', 'USDT'].includes(String(r['Валюта'] || '').toUpperCase()) ? String(r['Валюта']).toUpperCase() : 'USD';
      pid = Number(run('INSERT INTO projects(name, client_id, status, work_type, budget, currency, start_date, deadline, payment_method, notes) VALUES(?,?,?,?,?,?,?,?,?,?)',
        vals.name, vals.client_id, vals.status, vals.work_type, vals.budget, currency, vals.start_date, vals.deadline, vals.payment_method, vals.notes).lastInsertRowid);
    }
    return projectRow(pid);
  }
  throw new HttpError(400, 'Невідомий аркуш');
}

export function removeRow(sheet, id) {
  if (sheet === 'operations') {
    deleteTx(Number(id), SYSTEM);
    return true;
  }
  if (sheet === 'deals') {
    
    deleteDeal(Number(id));
    return true;
  }
  throw new HttpError(400, 'Видаляти з таблиці можна лише операції');
}
