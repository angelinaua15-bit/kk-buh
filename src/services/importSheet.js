/**
 * Імпорт xlsx/csv у KK-Buh. Розпізнає колонки за заголовками (укр/англ).
 */
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { get, run } from '../db.js';
import { createTx } from './finance.js';
import { toMinor } from './money.js';

const ALIAS = {
  date: ['дата', 'date', 'день'],
  amount: ['сума', 'amount', 'грн', 'uah', 'usd', 'сумма'],
  type: ['тип', 'type', 'дохід/витрата', 'д/в'],
  category: ['категорія', 'category', 'статья', 'стаття'],
  account: ['рахунок', 'счет', 'account', 'карта', 'кашелек'],
  to_account: ['на рахунок', 'to', 'отримувач'],
  project: ['проєкт', 'проект', 'project'],
  client: ['клієнт', 'клиент', 'client', 'замовник'],
  comment: ['коментар', 'комментарий', 'comment', 'опис', 'описание', 'примітка', 'назначение'],
  currency: ['валюта', 'currency', 'ccy'],
  status: ['статус', 'status'],
  member: ['хто', 'member', 'команда', 'виконавець', 'сотрудник'],
};

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function pick(headers, key) {
  const aliases = ALIAS[key];
  return headers.findIndex((h) => aliases.some((a) => norm(h).includes(a)));
}
function excelDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toISOString().slice(0, 10);
  }
  const s = String(v || '').trim();
  const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}
function parseType(raw, amount) {
  const s = norm(raw);
  if (['дохід', 'доход', 'income', '+', 'прихід', 'оплата клієнта'].some((x) => s.includes(x))) return 'income';
  if (['витрат', 'расход', 'expense', '-', 'списання'].some((x) => s.includes(x))) return 'expense';
  if (['переказ', 'перевод', 'transfer'].some((x) => s.includes(x))) return 'transfer';
  return amount < 0 ? 'expense' : 'income';
}
function findOrCreate(table, name, extra = {}) {
  if (!name) return null;
  const row = get(`SELECT * FROM ${table} WHERE lower(name)=lower(?)`, name);
  if (row) return row.id;
  if (table === 'categories') {
    const r = run('INSERT INTO categories(kind, name, emoji) VALUES(?,?,?)', extra.kind || 'expense', name, extra.emoji || '•');
    return Number(r.lastInsertRowid);
  }
  if (table === 'accounts') {
    const r = run('INSERT INTO accounts(name, type, currency, emoji) VALUES(?,?,?,?)', name, 'card', extra.currency || 'UAH', '💳');
    return Number(r.lastInsertRowid);
  }
  if (table === 'clients') {
    const r = run('INSERT INTO clients(name) VALUES(?)', name);
    return Number(r.lastInsertRowid);
  }
  if (table === 'projects') {
    const r = run('INSERT INTO projects(name, client_id, status, currency) VALUES(?,?,?,?)', name, extra.client_id || null, 'active', extra.currency || 'USD');
    return Number(r.lastInsertRowid);
  }
  if (table === 'users') {
    const r = run("INSERT INTO users(name, role, status) VALUES(?, 'member', 'active')", name);
    return Number(r.lastInsertRowid);
  }
  return null;
}

export async function importWorkbook(wb, actor = { id: null, role: 'admin' }) {
  let imported = 0;
  let skipped = 0;
  const sheets = [];

  for (const ws of wb.worksheets) {
    const rows = [];
    ws.eachRow((row) => rows.push(row.values.slice(1).map((c) => (c && c.text) || c || '')));
    if (rows.length < 2) continue;
    const idx = Object.fromEntries(Object.keys(ALIAS).map((k) => [k, pick(rows[0], k)]));
    if (idx.amount < 0 && idx.date < 0) {
      sheets.push({ name: ws.name, skipped: true, reason: 'немає дати/суми' });
      continue;
    }
    let sheetImported = 0;
    let sheetSkipped = 0;
    for (const r of rows.slice(1)) {
      const rawAmt = r[idx.amount];
      const num = Number(String(rawAmt).toString().replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(num) || num === 0) { skipped++; sheetSkipped++; continue; }
      const date = excelDate(r[idx.date]) || null;
      if (!date) { skipped++; sheetSkipped++; continue; }
      const type = parseType(idx.type >= 0 ? r[idx.type] : '', num);
      const amount = toMinor(Math.abs(num));
      const currency = (idx.currency >= 0 ? String(r[idx.currency]).toUpperCase() : '') || 'UAH';
      const catName = idx.category >= 0 ? String(r[idx.category]).trim() : '';
      const accName = idx.account >= 0 ? String(r[idx.account]).trim() : '';
      const projName = idx.project >= 0 ? String(r[idx.project]).trim() : '';
      const cliName = idx.client >= 0 ? String(r[idx.client]).trim() : '';
      const memName = idx.member >= 0 ? String(r[idx.member]).trim() : '';
      const comment = idx.comment >= 0 ? String(r[idx.comment]).trim() : '';
      try {
        const client_id = findOrCreate('clients', cliName);
        createTx({
          type,
          status: 'done',
          date,
          amount,
          account_id: findOrCreate('accounts', accName || 'Імпорт', { currency }) || get('SELECT id FROM accounts ORDER BY id LIMIT 1')?.id,
          category_id: findOrCreate('categories', catName, { kind: type }),
          project_id: findOrCreate('projects', projName, { client_id, currency }),
          client_id,
          member_id: findOrCreate('users', memName),
          comment: comment || `${ws.name} · імпорт`,
        }, actor);
        imported++;
        sheetImported++;
      } catch {
        skipped++;
        sheetSkipped++;
      }
    }
    sheets.push({ name: ws.name, rows: rows.length - 1, imported: sheetImported, skipped: sheetSkipped });
  }

  return { imported, skipped, sheets };
}

export async function importBuffer(buf, filename = 'import.xlsx', actor) {
  const wb = new ExcelJS.Workbook();
  if (String(filename).toLowerCase().endsWith('.csv')) {
    await wb.csv.read(Readable.from(buf));
  } else {
    await wb.xlsx.load(buf);
  }
  return importWorkbook(wb, actor);
}
