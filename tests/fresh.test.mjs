/**
 * «Чистий лист» з початку місяця: node tests/fresh.test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkfresh-test-'));
const PORT = 4100 + Math.floor(Math.random() * 300);
const env = { ...process.env, DEV_MODE: '1', ADMIN_IDS: '111', DB_PATH: path.join(dir, 'db.sqlite'), PORT: String(PORT), BOT_TOKEN: '', WEBAPP_URL: '', TZ: 'Europe/Kyiv', SHEET_SYNC_TOKEN: 'sync-secret-123' };
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });
const root = `http://127.0.0.1:${PORT}`;
async function call(method, p, body, user = 111, headers = {}) {
  const res = await fetch((p.startsWith('/sync') ? root : root + '/api') + p, { method, headers: { 'x-dev-user': String(user), 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} → ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const sync = (m, p, b) => call(m, p, b, 111, { 'x-sync-token': 'sync-secret-123' });
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('✔', name); } catch (e) { console.error('✘', name, '\n ', e.message); process.exitCode = 1; } };
for (let i = 0; i < 50; i++) { try { await fetch(`${root}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
const start = `${today.slice(0, 7)}-01`;
const prev = new Date(`${start}T12:00:00Z`); prev.setUTCDate(prev.getUTCDate() - 20);
const old = prev.toISOString().slice(0, 10);

try {
  const boot = await ok('GET', '/bootstrap');
  const acc = boot.accounts.find((a) => a.currency === 'UAH');
  await ok('PATCH', `/accounts/${acc.id}`, { initial_balance: 500000 });
  const oldTx = await ok('POST', '/transactions', { type: 'income', date: old, amount: 100000, currency: 'UAH', account_id: acc.id, comment: 'старий дохід' });
  const newTx = await ok('POST', '/transactions', { type: 'expense', date: today, amount: 30000, currency: 'UAH', account_id: acc.id, comment: 'новий' });
  const oldDeal = await ok('POST', '/deals', { section: 'Розробки', client: 'Старий', task: 'Старий сайт', start: old, price: { amount: 50000, currency: 'USD' }, prepay: { amount: 10000, currency: 'USD' } });
  const newDeal = await ok('POST', '/deals', { section: 'Розробки', client: 'Новий', task: 'Новий сайт', start: today, price: { amount: 80000, currency: 'USD' } });
  const task = await ok('POST', '/pages', { title: 'Стара задача', project_id: oldDeal.id });
  const balBefore = (await ok('GET', '/reports/balances')).accounts.find((a) => a.id === acc.id).balance;

  let res;
  await test('fresh start: archives old data, keeps new, accounts from zero', async () => {
    assert.equal((await ok('GET', '/fresh')).start, null);
    assert.equal((await call('POST', '/fresh', { date: '2099-01-01' })).status, 400);
    res = await ok('POST', '/fresh', { date: start });
    assert.equal(res.state.start, start);
    assert.ok(res.transactions >= 2, JSON.stringify(res)); // старий дохід + передоплата старої угоди
    assert.ok(res.projects >= 1);
    const list = await ok('GET', '/transactions');
    const ids = list.rows.map((t) => t.id);
    assert.ok(!ids.includes(oldTx.id));
    assert.ok(ids.includes(newTx.id));
    const deals = await ok('GET', '/deals');
    assert.deepEqual(deals.map((d) => d.id), [newDeal.id]);
    const bal = await ok('GET', '/reports/balances');
    assert.equal(bal.accounts.find((a) => a.id === acc.id).balance, -30000); // 0 на старті − 300 ₴
    assert.ok(!(await ok('GET', '/pages/meta')).projects.some((p) => p.id === oldDeal.id));
    assert.ok(!(await ok('GET', '/debts')).some((d) => d.project_id === oldDeal.id));
    assert.equal((await ok('GET', '/me')).features.ledger_start, start);
    // задачі не чіпаємо
    assert.equal((await ok('GET', `/pages/${task.id}`)).title, 'Стара задача');
  });

  await test('google sheet: old row stays archived; new old-dated row goes to archive; new row is live', async () => {
    const ex = (await sync('GET', '/sync/export')).data;
    const cols = ex.deals.columns;
    const row = (o) => cols.map((c) => o[c] ?? '');
    // редагування архівної угоди з таблиці
    const r1 = await sync('POST', '/sync/row', { sheet: 'deals', columns: cols, values: row({ ID: oldDeal.id, 'Розділ': 'Розробки', 'Замовник': 'Старий', 'Завдання': 'Старий сайт', 'Дата початку': old, 'Ціна': '600', 'Передоплата': '200' }) });
    assert.equal(r1.status, 200, JSON.stringify(r1.data));
    assert.ok(!(await ok('GET', '/deals')).some((d) => d.id === oldDeal.id));
    // новий рядок зі старою датою
    const r2 = await sync('POST', '/sync/row', { sheet: 'deals', columns: cols, values: row({ 'Розділ': 'Дизайн', 'Замовник': 'Ще старий', 'Завдання': 'Лого', 'Дата початку': old, 'Ціна': '100' }) });
    assert.equal(r2.status, 200, JSON.stringify(r2.data));
    const r3 = await sync('POST', '/sync/row', { sheet: 'deals', columns: cols, values: row({ 'Розділ': 'Дизайн', 'Замовник': 'Свіжий', 'Завдання': 'Банер', 'Дата початку': today, 'Ціна': '50' }) });
    const live = (await ok('GET', '/deals')).map((d) => d.task);
    assert.ok(live.includes('Банер') && !live.includes('Лого'), live.join(','));
    // ручне створення угоди зі старою датою в Mini App — не ховаємо
    await ok('POST', '/deals', { section: 'Інше', task: 'Вручну заднім числом', start: old, price: { amount: 100, currency: 'USD' } });
    assert.ok((await ok('GET', '/deals')).some((d) => d.task === 'Вручну заднім числом'));
    void r3;
  });

  await test('only admin can do it; undo brings everything back', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(env.DB_PATH);
    db.exec("INSERT INTO users(tg_id, name, role, status) VALUES(5101, 'Фін', 'finance', 'active')");
    db.close();
    assert.equal((await call('POST', '/fresh', { date: start }, 5101)).status, 403);
    const u = await ok('POST', '/fresh/undo', {});
    assert.ok(u.transactions >= 2);
    assert.equal(u.state.start, null);
    const ids = (await ok('GET', '/transactions')).rows.map((t) => t.id);
    assert.ok(ids.includes(oldTx.id));
    assert.ok((await ok('GET', '/deals')).some((d) => d.id === oldDeal.id));
    const bal = await ok('GET', '/reports/balances');
    // після відкату — як до «чистого листа», плюс рядки з таблиці/вручну, додані між тим (вони не на цьому рахунку в UAH)
    assert.equal(bal.accounts.find((a) => a.id === acc.id).initial_balance, 500000);
    assert.ok(Math.abs(bal.accounts.find((a) => a.id === acc.id).balance - balBefore) < 50000000);
    assert.equal((await call('POST', '/fresh/undo', {})).status, 400);
  });
} finally {
  srv.kill();
  if (process.exitCode) console.log(log.slice(-2000));
  console.log(`\n${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
