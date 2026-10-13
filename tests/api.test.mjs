/**
 * Інтеграційні тести API: node tests/api.test.mjs
 * Піднімає сервер на тимчасовій базі в DEV_MODE і проходить усі основні сценарії.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkbuh-test-'));
const PORT = 3400 + Math.floor(Math.random() * 500);
const env = { ...process.env, DEV_MODE: '1', ADMIN_IDS: '111', DB_PATH: path.join(dir, 'db.sqlite'), PORT: String(PORT), BOT_TOKEN: '', WEBAPP_URL: '', TZ: 'Europe/Kyiv' };
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });

const base = `http://127.0.0.1:${PORT}/api`;
async function call(method, p, body, user = 111) {
  const res = await fetch(base + p, {
    method,
    headers: { 'x-dev-user': String(user), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data };
}
const ok = async (method, p, body, user) => {
  const r = await call(method, p, body, user);
  assert.ok(r.status < 300, `${method} ${p} → ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
};
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('✔', name); } catch (e) { console.error('✘', name, '\n ', e.message); process.exitCode = 1; }
};

for (let i = 0; i < 50; i++) {
  try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

try {
  const me = await ok('GET', '/me');
  const boot = await ok('GET', '/bootstrap');
  const acc = Object.fromEntries(boot.accounts.map((a) => [a.name, a]));
  const cat = Object.fromEntries(boot.categories.map((c) => [`${c.kind}:${c.name}`, c]));
  let client, project, member;

  await test('me: admin, features flags', () => {
    assert.equal(me.user.role, 'admin');
    assert.equal(typeof me.features.ai, 'boolean');
  });

  await test('validation: empty names → 400', async () => {
    for (const p of ['/projects', '/clients', '/accounts', '/categories', '/templates']) {
      const r = await call('POST', p, {});
      assert.equal(r.status, 400, p);
    }
    const r = await call('POST', '/transactions', { type: 'income', amount: 0, account_id: acc['Monobank ФОП'].id });
    assert.equal(r.status, 400);
  });

  await test('client with apostrophe + requisites', async () => {
    client = await ok('POST', '/clients', { name: "О'Браєн Студія", legal_name: 'ТОВ «Обраєн»', legal_code: '12345678' });
    const list = await ok('GET', '/clients');
    assert.ok(list.find((c) => c.name === "О'Браєн Студія" && c.legal_code === '12345678'));
  });

  await test('project + member (team member joins and becomes active)', async () => {
    project = await ok('POST', '/projects', { name: 'Сайт Обраєн', client_id: client.id, budget: 100000, currency: 'USD', deadline: '2026-01-10', work_type: 'Сайт' });
    await call('GET', '/me', null, 222); // реєстрація нового користувача → pending
    const users = await ok('GET', '/users');
    member = users.find((u) => u.tg_id === 222);
    assert.equal(member.status, 'pending');
    await ok('PATCH', `/users/${member.id}`, { status: 'active', role: 'member' });
    const list = await ok('POST', `/projects/${project.id}/members`, { user_id: member.id, kind: 'pct', value: 30 });
    assert.equal(list.length, 1);
    const bad = await call('POST', `/projects/${project.id}/members`, { user_id: member.id, kind: 'pct', value: 150 });
    assert.equal(bad.status, 400);
  });

  await test('income on project → debt shrinks, payouts accrue 30%', async () => {
    await ok('POST', '/transactions', { type: 'income', amount: 40000, account_id: acc['Готівка $'].id, project_id: project.id, category_id: cat['income:Розробка сайтів'].id, member_id: member.id, comment: 'передоплата' });
    const d = await ok('GET', '/debts');
    const row = d.find((x) => x.project_id === project.id);
    assert.equal(row.left, 60000);
    assert.ok(row.overdue_days > 0);
    assert.ok(row.reminder.includes('60'));
    const p = await ok('GET', '/payouts');
    const person = p.people.find((x) => x.user_id === member.id);
    assert.equal(person.accrued, 12000); // 30% від $400 у базі USD
    assert.equal(person.due, 12000);
  });

  await test('plan payouts → planned tx, due becomes 0, no duplicates on 2nd run', async () => {
    const r = await ok('POST', '/payouts/plan', { account_id: acc['Готівка $'].id });
    assert.equal(r.created, 1);
    const p = await ok('GET', '/payouts');
    assert.equal(p.people.find((x) => x.user_id === member.id).due, 0);
    const r2 = await ok('POST', '/payouts/plan', { account_id: acc['Готівка $'].id });
    assert.equal(r2.created, 0);
  });

  await test('member cabinet and visibility', async () => {
    const c = await ok('GET', '/cabinet', null, 222);
    assert.equal(c.accrued, 12000);
    assert.equal(c.planned, 12000);
    const projs = await ok('GET', '/projects', null, 222);
    assert.equal(projs.length, 1);
    assert.equal(projs[0].budget, undefined, 'member must not see budget');
    for (const p of ['/debts', '/payouts', '/taxes', '/forecast', '/clients', '/reports/pnl', '/team', '/profitability', '/compare']) {
      const r = await call('GET', p, null, 222);
      assert.equal(r.status, 403, p);
    }
  });

  await test('member tx goes to review (pending)', async () => {
    const t = await ok('POST', '/transactions', { type: 'expense', amount: 5000, account_id: acc['Картка Mono'].id, comment: 'таксі' }, 222);
    assert.equal(t.status, 'pending');
    const r = await ok('POST', `/transactions/${t.id}/status`, { status: 'done' });
    assert.equal(r.status, 'done');
  });

  await test('templates: create, wrong category kind rejected, use', async () => {
    const bad = await call('POST', '/templates', { title: 'X', type: 'expense', amount: 100, account_id: acc['Картка Mono'].id, category_id: cat['income:SEO'].id });
    assert.equal(bad.status, 400);
    const t = await ok('POST', '/templates', { title: 'Оренда', emoji: '🏢', type: 'expense', amount: 1500000, account_id: acc['Monobank ФОП'].id, category_id: cat['expense:Офіс / техніка'].id });
    const tx = await ok('POST', `/templates/${t.id}/use`, {});
    assert.equal(tx.amount, 1500000);
    assert.ok(tx.comment.includes('Оренда'));
  });

  await test('category limit check does not break tx', async () => {
    await ok('PATCH', `/categories/${cat['expense:Реклама (бюджети)'].id}`, { monthly_limit: 10000 });
    const t = await ok('POST', '/transactions', { type: 'expense', amount: 500000, account_id: acc['Monobank ФОП'].id, category_id: cat['expense:Реклама (бюджети)'].id, comment: 'таргет' });
    assert.equal(t.status, 'done');
  });

  await test('taxes: group 3, 5% + 1% of FOP income this quarter', async () => {
    await ok('POST', '/transactions', { type: 'income', amount: 10000000, account_id: acc['Monobank ФОП'].id, comment: 'оплата клієнта' });
    const t = await ok('GET', '/taxes');
    assert.equal(t.enabled, true);
    const q = t.quarters[1];
    assert.equal(q.income, 10000000);
    assert.equal(q.single_tax.amount, 500000);
    assert.equal(q.military.amount, 100000);
    assert.equal(q.esv.amount, 190234 * 3);
    const s = await ok('POST', '/taxes/settings', { group: '2' });
    assert.equal(s.group, '2');
    const t2 = await ok('GET', '/taxes');
    assert.ok(t2.items.some((i) => i.amount === 172940));
    await ok('POST', '/taxes/settings', { group: '3' });
    const planned = await ok('POST', '/taxes/plan', {});
    assert.ok(planned.created >= 1);
    const again = await ok('POST', '/taxes/plan', {});
    assert.equal(again.created, 0, 'no duplicate tax plans');
  });

  await test('forecast: start balance and weekly rows', async () => {
    const f = await ok('GET', '/forecast?weeks=4');
    assert.equal(f.weeks.length, 4);
    assert.equal(typeof f.start_balance, 'number');
    const last = f.weeks.at(-1).end_balance;
    const sum = f.weeks.reduce((s, w) => s + w.income - w.expense, f.start_balance);
    assert.equal(last, sum);
  });

  await test('profitability and compare', async () => {
    const p = await ok('GET', '/profitability');
    assert.ok(p.byMember.find((m) => m.id === member.id));
    assert.ok(p.byType.find((x) => x.name === 'Сайт'));
    const c = await ok('GET', '/compare');
    assert.ok(c.current.income > 0);
  });

  await test('documents: invoice + act PDF, numbering', async () => {
    await ok('POST', '/requisites', { legal_name: 'ФОП Іванів Ангеліна', iban: 'UA000000000000000000000000000', signer: 'А. Іванів' });
    const inv = await ok('POST', '/documents', { kind: 'invoice', project_id: project.id, send: false });
    assert.match(inv.number, /^РФ-\d{4}-001$/);
    const act = await ok('POST', '/documents', { kind: 'act', project_id: project.id, amount: 60000, send: false });
    assert.match(act.number, /^АКТ-\d{4}-001$/);
    const inv2 = await ok('POST', '/documents', { kind: 'invoice', project_id: project.id, send: false });
    assert.match(inv2.number, /-002$/);
    const pdf = await call('GET', `/documents/${inv.id}.pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.data.slice(0, 4).toString(), '%PDF');
  });

  await test('send to chat without bot → clear 400', async () => {
    const r = await call('POST', '/backup', {});
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Telegram/);
  });

  await test('mono disabled without token', async () => {
    const r = await ok('GET', '/mono');
    assert.equal(r.enabled, false);
  });

  await test('recurring: invalid rejected, run creates planned', async () => {
    assert.equal((await call('POST', '/recurring', { title: 'X' })).status, 400);
    await ok('POST', '/recurring', { title: 'Хостинг', type: 'expense', amount: 1000, account_id: acc['Готівка $'].id, day_of_month: 28 });
    const r = await ok('POST', '/recurring/run');
    assert.equal(r.created.length, 1);
    const r2 = await ok('POST', '/recurring/run');
    assert.equal(r2.created.length, 0);
  });

  await test('excel export works', async () => {
    const r = await call('GET', '/export.xlsx');
    assert.equal(r.status, 200);
    assert.equal(r.data.slice(0, 2).toString(), 'PK');
  });
} finally {
  srv.kill();
  console.log(`\n${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
  if (process.exitCode) console.log(log.slice(-3000));
  fs.rmSync(dir, { recursive: true, force: true });
}
