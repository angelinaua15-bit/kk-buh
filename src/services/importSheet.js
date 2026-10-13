/**
 * Імпорт xlsx/csv у KK-Buh. Розпізнає колонки за заголовками (укр/англ).
 */
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { get, run } from '../db.js';
import { createTx } from './finance.js';
import { toMinor } from './money.js';
import { SECTIONS, dealKey, retireLegacyImport, saveDeal } from './deals.js';

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

function cellText(c) {
  if (c == null || c === '') return '';
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  if (typeof c === 'object') {
    if (c.text) return String(c.text);
    if (c.result != null) return cellText(c.result);
    if (Array.isArray(c.richText)) return c.richText.map((x) => x.text).join('');
  }
  return c;
}

function isKkProjectsSheet(rows) {
  return rows.some((r) => {
    const line = r.map((c) => norm(c)).join(' | ');
    return line.includes('виконавець') && line.includes('замовник') && (line.includes('ціна') || line.includes('тип роботи'));
  });
}

const SECTION_TITLES = ['розробки', 'реклама', 'seo', 'ads', 'дизайн'];
function isSectionTitle(v) {
  const s = norm(v);
  return s && SECTION_TITLES.some((t) => s.includes(t)) && !s.includes('виконавець');
}
function isHeaderRow(r) {
  const line = r.map((c) => norm(c)).join(' ');
  return line.includes('виконавець') && line.includes('замовник');
}
function isSummaryRow(r) {
  const line = r.map((c) => norm(c)).join(' ');
  return /стабільн|прибуток|січень|лютий|березень|квітень|травень|червень|липень|серпень|вересень|жовтень|листопад|грудень/.test(line)
    && !line.includes('виконавець');
}

/** Колір заливки → угода закрита (зелені відтінки, як у таблиці). */
function isGreen(cell) {
  const argb = cell?.fill?.fgColor?.argb || cell?.fill?.bgColor?.argb;
  if (!argb || argb.length < 8) return false;
  const r = parseInt(argb.slice(2, 4), 16);
  const g = parseInt(argb.slice(4, 6), 16);
  const b = parseInt(argb.slice(6, 8), 16);
  return g > 120 && g > r + 25 && g > b + 25;
}

export function importKkProjects(wb, actor = { id: null, role: 'admin' }) {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];
  const sheets = [];
  const retired = retireLegacyImport();
  const year = Number(new Date().toISOString().slice(0, 4));

  for (const ws of wb.worksheets) {
    const rows = [];
    ws.eachRow((row) => rows.push(row));
    const values = rows.map((r) => r.values.slice(1).map(cellText));
    if (!isKkProjectsSheet(values)) continue;
    let sheetDeals = 0;
    // блоки: заголовок «Виконавець …» може бути зліва (кол. B) і справа (кол. P)
    const blocks = [];
    rows.forEach((row, i) => {
      const v = values[i];
      v.forEach((c, j) => {
        if (norm(c) === 'виконавець' && norm(v[j + 1]) === 'замовник') {
          const above = values[i - 1] || [];
          const title = String(above[j] || above[j - 1] || '').trim() || 'Інше';
          blocks.push({ header: i, col: j, title });
        }
      });
    });
    for (const blk of blocks) {
      const section = SECTIONS.find((x) => norm(blk.title).startsWith(norm(x).split(' ')[0])) || 'Інше';
      const next = blocks.filter((x) => x.col === blk.col && x.header > blk.header).map((x) => x.header)[0] ?? rows.length;
      for (let i = blk.header + 1; i < next; i++) {
        const v = values[i];
        const cells = v.slice(blk.col, blk.col + 12);
        const [executor, client, type, task, start, end, method, prepay, prog, price, margin, extra] = cells;
        if (isSummaryRow(v) || isHeaderRow(cells)) continue;
        if (!String(client || '').trim() && !String(task || '').trim() && !String(price || '').trim()) continue;
        const n = Number(v[blk.col - 1]) || i;
        const excelCell = rows[i].getCell(blk.col + 2); // перша клітинка блоку (Виконавець), 1-based
        const row = {
          n, executor, client, type, task: task || type,
          start: start instanceof Date ? start.toISOString().slice(0, 10) : excelDate(start) || String(start || ''),
          end: end instanceof Date ? end.toISOString().slice(0, 10) : excelDate(end) || String(end || ''),
          method, prepay, prog, price, margin, extra,
          closed: isGreen(excelCell) || isGreen(rows[i].getCell(blk.col + 4)),
        };
        const key = dealKey(section, row, year);
        const existed = Boolean(get('SELECT id FROM projects WHERE deal_key = ?', key));
        try {
          saveDeal({ ...row, section }, actor, { key, year });
          existed ? updated++ : created++;
          sheetDeals++;
        } catch (e) {
          skipped++;
          errors.push(`${section} №${n}: ${e.message}`);
        }
      }
    }
    sheets.push({ name: ws.name, deals: sheetDeals });
  }
  return { imported: created + updated, created, updated, skipped, retired, errors, sheets, format: 'kk-deals' };
}

export async function importWorkbook(wb, actor = { id: null, role: 'admin' }) {
  const preview = [];
  for (const ws of wb.worksheets) {
    const rows = [];
    ws.eachRow((row) => rows.push(row.values.slice(1).map(cellText)));
    preview.push(rows);
  }
  if (preview.some(isKkProjectsSheet)) return importKkProjects(wb, actor);

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
