/**
 * Угоди як у таблиці: node tests/deals.test.mjs
 * 1) знімок таблиці → 41 угода, суми як у таблиці; 2) повторний імпорт без дублів;
 * 3) Excel з тим самим розкладом (зелені рядки = закриті) дає ті самі угоди; 4) розрахунки.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkdeals-'));
Object.assign(process.env, { DB_PATH: path.join(dir, 'db.sqlite'), BOT_TOKEN: '', ADMIN_IDS: '111', TZ: 'Europe/Kyiv' });
const { all, get, run } = await import('../src/db.js');
const D = await import('../src/services/deals.js');
const { importBuffer } = await import('../src/services/importSheet.js');
const { debts, payouts } = await import('../src/services/extras.js');
const snap = JSON.parse(fs.readFileSync(new URL('../data/kk-deals-2026.json', import.meta.url), 'utf8'));
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('✔', name); } catch (e) { console.error('✘', name, '\n ', e.stack.split('\n').slice(0, 4).join('\n  ')); process.exitCode = 1; } };

await test('parseMoney like the sheet', () => {
  assert.deepEqual(D.parseMoney('5.933грн'), { amount: 593300, currency: 'UAH' });
  assert.deepEqual(D.parseMoney('74$'), { amount: 7400, currency: 'USD' });
  assert.deepEqual(D.parseMoney('7875'), { amount: 787500, currency: 'UAH' });
  assert.deepEqual(D.parseMoney('7875', 'USD'), { amount: 787500, currency: 'USD' });
  assert.equal(D.parseMoney('-'), null);
  assert.equal(D.parseMoney(''), null);
  assert.deepEqual(D.parseMoney('10 000 грн'), { amount: 1000000, currency: 'UAH' });
  assert.deepEqual(D.parseExtras('Виправлення пом. 1000грн 10.03', 2026), [{ amount: 100000, currency: 'UAH', date: '2026-03-10' }]);
  assert.deepEqual(D.parseExtras('Додатково 5100грн (28.03)', 2026), [{ amount: 510000, currency: 'UAH', date: '2026-03-28' }]);
  assert.deepEqual(D.parseExtras('плюс 600 грн', 2026), [{ amount: 60000, currency: 'UAH', date: null }]);
});

await test('legacy «[Розробки] …» import is retired, not duplicated', () => {
  run("INSERT INTO projects(name, status) VALUES('[Розробки] Зробити бот · @x', 'active')");
  const pid = get('SELECT id FROM projects ORDER BY id DESC').id;
  run("INSERT INTO transactions(type, status, date, amount, currency, rate, amount_base, account_id, project_id) VALUES('income','done','2026-02-01',100,'UAH',1,100,1,?)", pid);
  const r = D.importSnapshot(snap);
  assert.equal(r.retired, 1);
  assert.equal(get('SELECT status FROM projects WHERE id=?', pid).status, 'cancelled');
  assert.ok(get('SELECT deleted_at FROM transactions WHERE project_id=?', pid).deleted_at);
  assert.deepEqual(r.errors, []);
  assert.equal(r.created, 41);
});

await test('every row of the sheet is a deal with the same numbers', () => {
  const deals = D.listDeals();
  assert.equal(deals.length, 41);
  for (const [section, rows] of Object.entries(snap.sections)) {
    for (const arr of rows) {
      const row = Object.fromEntries(snap.columns.map((c, i) => [c, arr[i]]));
      const d = deals.find((x) => x.section === section && x.client === row.client.trim() && x.task === (row.task || row.type) && x.start_date === D.parseDate(row.start, 2026));
      assert.ok(d, `${section} №${row.n} not found`);
      const price = D.parseMoney(row.price) || D.parseMoney(row.prepay);
      assert.equal(d.price, price.amount, `${section} №${row.n} price`);
      if (row.margin) assert.equal(d.margin, D.parseMoney(row.margin).amount, `${section} №${row.n} margin`);
      assert.equal(d.closed, row.closed, `${section} №${row.n} closed`);
    }
  }
});

await test('re-import updates, never duplicates', () => {
  const before = get('SELECT COUNT(*) n FROM transactions WHERE deleted_at IS NULL').n;
  const r = D.importSnapshot(snap);
  assert.equal(r.created, 0);
  assert.equal(r.updated, 41);
  assert.equal(get("SELECT COUNT(*) n FROM projects WHERE section IS NOT NULL AND status != 'cancelled'").n, 41);
  assert.equal(get('SELECT COUNT(*) n FROM transactions WHERE deleted_at IS NULL').n, before);
});

await test('closed deal: client paid in full, executor paid in full', () => {
  const d = D.listDeals().find((x) => x.task === 'Зробити бот' && x.client === '@Alexxandra88');
  assert.equal(d.calc.executor_total, 602000); // 12040 − 6020
  assert.equal(d.calc.client_left, 0);
  const tx = all('SELECT type, amount, deal_part FROM transactions WHERE project_id=? AND deleted_at IS NULL ORDER BY id', d.id);
  const income = tx.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expense = tx.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  assert.equal(income, 1204000 + 60000); // ціна + «плюс 600 грн»
  assert.equal(expense, 602000);
});

await test('open deal: only prepayments recorded, debts computed', () => {
  const d = D.listDeals({ status: 'open' }).find((x) => x.client === '@moskalenko_yuriy');
  assert.equal(d.calc.client_left, 65000); // 1300$ − 650$
  assert.equal(d.calc.executor_left, 0, 'виконавцю виплачено все');
  assert.equal(d.executor_paid, true);
  const debt = debts().find((x) => x.project_id === d.id);
  assert.equal(debt.left, 65000);
  const paidOut = get("SELECT SUM(amount) s FROM transactions WHERE project_id=? AND type='expense' AND deleted_at IS NULL", d.id).s;
  assert.equal(paidOut, 60000, 'виплата виконавцю 1300$ − 700$');
  const p = payouts().people.find((x) => x.name === '@k_vysh');
  assert.equal(p.due, 0);
  assert.equal(D.dealBalances().we_owe_executors_uah, 0);
});

await test('own work (Ангеліна): no payouts', () => {
  const d = D.listDeals().find((x) => x.task === 'Розробка лендінгу (інструменти)');
  assert.equal(d.calc.executor_total, 0);
  assert.equal(get("SELECT COUNT(*) n FROM transactions WHERE project_id=? AND type='expense' AND deleted_at IS NULL", d.id).n, 0);
});

await test('monthly summary by sections (design matches the sheet exactly)', () => {
  const s = D.monthlySummary(2026, 'end');
  assert.equal(s.table['2026-02']['Дизайн'], 107500);
  assert.equal(s.table['2026-03']['Дизайн'], 264000);
  assert.equal(s.table['2026-04']['Дизайн'], 478000);
  const sum = s.sections.reduce((a, x) => a + s.table['2026-03'][x], 0);
  assert.equal(s.table['2026-03']['Прибуток'], sum);
});

await test('edit a deal: close it → transactions rebuilt', () => {
  const d = D.listDeals({ status: 'open' }).find((x) => x.client === '@vpauull');
  const saved = D.saveDeal({ section: d.section, executor: d.executor, client: d.client, type: d.type, task: d.task, start: d.start_date, method: d.method, price: '500$', prepay: '500$', prog: '300$', margin: '200$', closed: true }, { id: null, role: 'admin' }, { id: d.id });
  assert.equal(saved.closed, true);
  assert.equal(saved.calc.executor_left, 0);
  const n = get("SELECT COUNT(*) n FROM transactions WHERE project_id=? AND deleted_at IS NULL", d.id).n;
  D.saveDeal({ section: d.section, client: d.client, task: d.task, start: d.start_date, method: d.method, price: '500$', prepay: '500$', prog: '300$', margin: '200$', executor: d.executor, closed: true }, { id: null, role: 'admin' }, { id: d.id });
  assert.equal(get("SELECT COUNT(*) n FROM transactions WHERE project_id=? AND deleted_at IS NULL", d.id).n, n, 'no duplicate tx on re-save');
});

await test('validation: price required, bad section → Інше', () => {
  assert.throws(() => D.saveDeal({ section: 'Розробки', task: 'x' }, { id: null, role: 'admin' }), /ціну/);
  const d = D.saveDeal({ section: 'щось', task: 'Тест', price: '100 грн', client: 'Тест' }, { id: null, role: 'admin' });
  assert.equal(d.section, 'Інше');
  D.deleteDeal(d.id);
  assert.equal(D.getDeal(d.id).status, 'cancelled');
});

await test('Excel with the same layout + green rows → same deals', async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kkx-'));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('2026');
  const H = ['Виконавець', 'Замовник', 'Тип роботи', 'Завдання', 'Дата початку', 'Дата завершення', 'Метод оплати', 'Передоплата', 'Передоплата прог.', 'Ціна', 'Маржа', 'доп послуга, ціна, число оплати'];
  const put = (r, c, v) => { ws.getCell(r, c).value = v; };
  const place = (section, rows, top, left) => {
    put(top, left + 1, section);
    H.forEach((h, i) => put(top + 1, left + 1 + i, h));
    rows.forEach((arr, k) => {
      const r = top + 2 + k;
      put(r, left, arr[0]);
      arr.slice(1, 13).forEach((v, i) => put(r, left + 1 + i, v));
      if (arr[13]) for (let i = 0; i < 12; i++) ws.getCell(r, left + 1 + i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6AA84F' } };
    });
  };
  place('Розробки', snap.sections['Розробки'], 1, 1);
  place('Реклама', snap.sections['Реклама'], 1, 15);
  place('Seo / Ads', snap.sections['Seo / Ads'], 40, 1);
  place('Дизайн', snap.sections['Дизайн'], 40, 15);
  const buf = await wb.xlsx.writeBuffer();
  const before = get("SELECT COUNT(*) n FROM projects WHERE section IS NOT NULL AND status != 'cancelled'").n;
  const r = await importBuffer(Buffer.from(buf), 'kk.xlsx', { id: null, role: 'admin' });
  assert.equal(r.format, 'kk-deals');
  assert.deepEqual(r.errors, []);
  assert.equal(r.imported, 41);
  assert.equal(r.created, 0, 'Excel rows must match the same deals (no duplicates)');
  assert.equal(r.updated, 41);
  assert.equal(get("SELECT COUNT(*) n FROM projects WHERE section IS NOT NULL AND status != 'cancelled'").n, before);
  const open = D.listDeals({ status: 'open' }).map((d) => `${d.section}:${d.client}`).sort();
  assert.deepEqual(open, ['Seo / Ads:678957295', 'Реклама:@vpauull', 'Розробки:@moskalenko_yuriy'], 'green = closed, white = open');
  fs.rmSync(dir2, { recursive: true, force: true });
});

console.log(`\n${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
fs.rmSync(dir, { recursive: true, force: true });
