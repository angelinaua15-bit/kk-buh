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

function parseMoney(raw) {
  if (raw == null || raw === '' || raw === 0) return null;
  if (raw instanceof Date) return null;
  const s = String(raw).trim();
  if (!s || s === '-' || /^[-—–]+$/.test(s)) return null;
  const cur = /\$|usd|usdt/i.test(s) ? (/usdt/i.test(s) ? 'USDT' : 'USD')
    : /грн|uah|₴/i.test(s) ? 'UAH' : null;
  let numPart = s.replace(/\s/g, '').replace(/[^\d.,-]/g, '');
  if (/^\d{1,3}\.\d{3}$/.test(numPart)) numPart = numPart.replace('.', '');
  else numPart = numPart.replace(',', '.');
  const n = Number(numPart);
  if (!Number.isFinite(n) || Math.abs(n) < 2) return null;
  return { amount: Math.abs(n), currency: cur };
}

function moneyWithFallback(raw, method) {
  const m = parseMoney(raw);
  if (!m) return null;
  if (!m.currency) m.currency = /крипт|crypto|usdt/i.test(method || '') ? 'USD' : 'UAH';
  return m;
}

function pickAccount(method, currency) {
  const m = norm(method);
  if (currency === 'USD' || currency === 'USDT') {
    if (/крипт|crypto|usdt/.test(m)) {
      return findOrCreate('accounts', 'USDT (TRC20)', { currency: 'USDT', type: 'crypto' })
        || get("SELECT id FROM accounts WHERE currency IN ('USDT','USD') ORDER BY id LIMIT 1")?.id;
    }
    return findOrCreate('accounts', 'Готівка $', { currency: 'USD', type: 'cash' });
  }
  if (/фоп|fop/.test(m)) return findOrCreate('accounts', 'Monobank ФОП', { currency: 'UAH', type: 'bank' });
  if (/^fh\b|фріенд|friend/.test(m)) return findOrCreate('accounts', 'Fh', { currency: 'UAH', type: 'card' });
  return findOrCreate('accounts', 'Картка Mono', { currency: 'UAH', type: 'card' });
}

function incomeCategory(type, section) {
  const s = `${norm(type)} ${norm(section)}`;
  if (/бот|bot|mini/.test(s)) return ['Telegram-боти / Mini Apps', '🤖'];
  if (/сайт|ленд|верстк|figma|hubspot|1с|1c/.test(s)) return ['Розробка сайтів', '💻'];
  if (/креатив|дизайн/.test(s)) return ['Дизайн / UI/UX', '🎨'];
  if (/seo|google ads/.test(s)) return ['SEO', '🔍'];
  if (/трафік|перелив|таргет|реклам/.test(s)) return ['Трафік / таргет', '📈'];
  return ['Інші надходження', '💰'];
}

function projectStatus(start, end, today = new Date().toISOString().slice(0, 10)) {
  if (end && end <= today) return 'done';
  if (start && start > today) return 'lead';
  return 'active';
}

function findMember(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) return null;
  const uname = n.replace(/^@/, '').split(/\s+/)[0];
  const row = get(
    `SELECT * FROM users WHERE lower(name)=lower(?) OR lower(username)=lower(?)
      OR lower(name) LIKE lower(?) OR lower(username)=lower(?) LIMIT 1`,
    n, n.replace(/^@/, ''), `${n.split(' ')[0]}%`, uname,
  );
  if (row) return row.id;
  return findOrCreate('users', n.replace(/^@/, ''));
}

function findClient(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) return null;
  if (/^\d{5,}$/.test(n)) return findOrCreate('clients', `TG ${n}`);
  return findOrCreate('clients', n);
}

function alreadyImported(type, date, amount, comment) {
  return get(
    `SELECT id FROM transactions WHERE deleted_at IS NULL AND type=? AND date=? AND amount=? AND ifnull(comment,'')=?`,
    type, date, amount, comment || '',
  );
}

function addTx(actor, payload) {
  if (!payload.account_id || !payload.amount || !payload.date) return 'skip';
  if (alreadyImported(payload.type, payload.date, payload.amount, payload.comment)) return 'skip';
  try {
    createTx({ ...payload, status: 'done' }, actor);
    return 'ok';
  } catch (e) {
    console.warn('import tx', e.message || e);
    return 'skip';
  }
}

function parseExtra(raw, yearHint) {
  const s = String(raw || '').trim();
  if (!s || s === '-') return [];
  const out = [];
  const re = /(\d+(?:[ .]\d{3})*(?:[.,]\d+)?)\s*(грн|uah|\$|usd)?/gi;
  let m;
  while ((m = re.exec(s))) {
    const money = parseMoney(`${m[1]}${m[2] || 'грн'}`);
    if (!money) continue;
    const dm = s.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
    let date = null;
    if (dm) {
      const y = dm[3] ? (dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : (yearHint || '2026');
      date = `${y}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
    }
    out.push({ ...money, date, note: s });
  }
  return out;
}

function upsertProject(name, extra) {
  const row = get(
    "SELECT * FROM projects WHERE lower(name)=lower(?) AND ifnull(client_id,0)=ifnull(?,0) AND ifnull(start_date,'')=ifnull(?, '')",
    name, extra.client_id || 0, extra.start_date || '',
  );
  if (row) {
    run(
      'UPDATE projects SET status=?, budget=?, currency=?, start_date=COALESCE(?, start_date), deadline=COALESCE(?, deadline), notes=COALESCE(?, notes) WHERE id=?',
      extra.status || row.status, extra.budget ?? row.budget, extra.currency || row.currency,
      extra.start_date || null, extra.deadline || null, extra.notes || null, row.id,
    );
    return row.id;
  }
  const r = run(
    'INSERT INTO projects(name, client_id, status, budget, currency, start_date, deadline, notes) VALUES(?,?,?,?,?,?,?,?)',
    name, extra.client_id || null, extra.status || 'active', extra.budget || 0, extra.currency || 'USD',
    extra.start_date || null, extra.deadline || null, extra.notes || null,
  );
  return Number(r.lastInsertRowid);
}

function importKkBlock(cells, section, actor) {
  try {
  const [executor, client, type, task, startRaw, endRaw, method, prepayRaw, contractorRaw, priceRaw, , extraRaw] = cells;
  const taskName = String(task || '').replace(/\s+/g, ' ').trim();
  const clientName = String(client || '').replace(/\s+/g, ' ').trim();
  const typeName = String(type || '').replace(/\s+/g, ' ').trim();
  if (!taskName && !clientName && !priceRaw && !prepayRaw) return { imported: 0, skipped: 0, projects: 0 };
  const start = excelDate(startRaw);
  const end = excelDate(endRaw);
  const methodName = String(method || '').trim();
  const price = moneyWithFallback(priceRaw, methodName) || moneyWithFallback(prepayRaw, methodName);
  if (!price && !taskName) return { imported: 0, skipped: 1, projects: 0 };

  const client_id = findClient(clientName);
  const member_id = findMember(executor);
  const currency = price?.currency || 'UAH';
  const projName = [`[${section}]`, taskName || typeName, clientName].filter(Boolean).join(' · ').slice(0, 180);
  const notes = [section, typeName, methodName, extraRaw].filter(Boolean).join(' · ');
  const project_id = upsertProject(projName, {
    client_id,
    status: projectStatus(start, end),
    budget: price ? toMinor(price.amount) : 0,
    currency,
    start_date: start,
    deadline: end,
    notes,
  });
  const date = start || end;
  if (!date) return { imported: 0, skipped: 1, projects: 1 };

  let imported = 0;
  let skipped = 0;
  const [incName, incEmoji] = incomeCategory(typeName, section);
  const incomeCat = findOrCreate('categories', incName, { kind: 'income', emoji: incEmoji });
  const expCat = findOrCreate('categories', 'Субпідрядники / фріланс', { kind: 'expense', emoji: '🤝' });

  if (price) {
    const comment = `Оплата клієнта · ${taskName || typeName}`;
    const r = addTx(actor, {
      type: 'income',
      date,
      amount: toMinor(price.amount),
      account_id: pickAccount(methodName, price.currency),
      category_id: incomeCat,
      project_id,
      client_id,
      member_id,
      comment,
    });
    r === 'ok' ? imported++ : skipped++;
  }

  const contractor = moneyWithFallback(contractorRaw, methodName);
  if (contractor) {
    const comment = `Виплата виконавцю · ${String(executor || '').trim() || 'підрядник'}`;
    const r = addTx(actor, {
      type: 'expense',
      date,
      amount: toMinor(contractor.amount),
      account_id: pickAccount(methodName, contractor.currency),
      category_id: expCat,
      project_id,
      client_id,
      member_id,
      comment,
    });
    r === 'ok' ? imported++ : skipped++;
  }

  for (const extra of parseExtra(extraRaw, (start || end || '').slice(0, 4))) {
    const extraDate = extra.date || date;
    const comment = extra.note.slice(0, 200);
    const r = addTx(actor, {
      type: 'income',
      date: extraDate,
      amount: toMinor(extra.amount),
      account_id: pickAccount(methodName, extra.currency || currency),
      category_id: incomeCat,
      project_id,
      client_id,
      member_id,
      comment,
    });
    r === 'ok' ? imported++ : skipped++;
  }

  return { imported, skipped, projects: 1 };
  } catch (e) {
    console.warn('import project', e.message || e);
    return { imported: 0, skipped: 1, projects: 0 };
  }
}

export function importKkProjects(wb, actor = { id: null, role: 'admin' }) {
  let imported = 0;
  let skipped = 0;
  let projects = 0;
  const sheets = [];

  for (const ws of wb.worksheets) {
    const rows = [];
    ws.eachRow((row) => rows.push(row.values.slice(1).map(cellText)));
    if (!isKkProjectsSheet(rows)) continue;
    let leftSection = 'Розробки';
    let rightSection = 'Реклама';
    let sheetImported = 0;
    let sheetSkipped = 0;
    let sheetProjects = 0;
    for (const r of rows) {
      if (isHeaderRow(r) || isSummaryRow(r)) continue;
      if (isSectionTitle(r[1]) && !String(r[2] || '').trim()) leftSection = String(r[1]).trim();
      if (isSectionTitle(r[15]) && !String(r[16] || '').trim()) rightSection = String(r[15]).trim();
      const left = importKkBlock(r.slice(1, 13), leftSection, actor);
      const right = importKkBlock(r.slice(15, 27), rightSection, actor);
      imported += left.imported + right.imported;
      skipped += left.skipped + right.skipped;
      projects += left.projects + right.projects;
      sheetImported += left.imported + right.imported;
      sheetSkipped += left.skipped + right.skipped;
      sheetProjects += left.projects + right.projects;
    }
    sheets.push({ name: ws.name, imported: sheetImported, skipped: sheetSkipped, projects: sheetProjects });
  }

  return { imported, skipped, projects, sheets, format: 'kk-projects' };
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
