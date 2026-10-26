/**
 * Задачі та сторінки (Notion-подібний розділ): node tests/tasks.test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kktasks-test-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const env = { ...process.env, DEV_MODE: '1', ADMIN_IDS: '111', DB_PATH: path.join(dir, 'db.sqlite'), PORT: String(PORT), BOT_TOKEN: '', WEBAPP_URL: '', TZ: 'Europe/Kyiv' };
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });
const base = `http://127.0.0.1:${PORT}/api`;
async function call(method, p, body, user = 111) {
  const res = await fetch(base + p, { method, headers: { 'x-dev-user': String(user), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} → ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('✔', name); } catch (e) { console.error('✘', name, '\n ', e.message); process.exitCode = 1; } };
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

try {
  const meta = await ok('GET', '/pages/meta');
  let task;
  await test('meta: statuses, priorities, members', async () => {
    assert.deepEqual(meta.statuses.map((s) => s.id), ['todo', 'doing', 'review', 'done']);
    assert.ok(meta.members.length >= 1);
  });
  await test('create task with properties and blocks; HTML is sanitized', async () => {
    task = await ok('POST', '/pages', {
      kind: 'task', title: '  Зверстати   головну ', status: 'doing', priority: 'high', due: '2026-11-02', tags: ['#дизайн', 'сайт', 'сайт'],
      blocks: [{ type: 'todo', text: 'Хедер', checked: true }, { type: 'todo', text: 'Каталог' }, { type: 'p', text: '<img src=x onerror=alert(1)><b onclick="x">ok</b> <a href="javascript:alert(1)">bad</a> <a href="https://kk.ua">good</a>' }, { type: 'evil', text: 'x' }],
    });
    assert.equal(task.title, 'Зверстати головну');
    assert.deepEqual(task.tags, ['дизайн', 'сайт']);
    assert.deepEqual(task.checklist, { done: 1, total: 2 });
    const html = task.blocks[2].text;
    assert.ok(!/onerror|onclick|javascript|<img/i.test(html), html);
    assert.match(html, /<b>ok<\/b>/);
    assert.match(html, /href="https:\/\/kk\.ua"/);
    assert.equal(task.blocks[3].type, 'p');
  });
  await test('templates prefill blocks', async () => {
    const t = await ok('POST', '/pages', { template: 'brief' });
    assert.equal(t.kind, 'task');
    assert.ok(t.blocks.length > 5);
    assert.ok(t.tags.includes('ТЗ'));
  });
  await test('patch status/sort; done_at set; filters work', async () => {
    const p = await ok('PATCH', `/pages/${task.id}`, { status: 'done', sort: 0.5 });
    assert.equal(p.status, 'done');
    assert.ok(p.done_at);
    const open = await ok('GET', '/pages?kind=task&open=1');
    assert.ok(!open.some((x) => x.id === task.id));
    const byTag = await ok('GET', '/pages?kind=task&tag=' + encodeURIComponent('дизайн'));
    assert.equal(byTag.length, 1);
    const q = await ok('GET', '/pages?q=' + encodeURIComponent('Каталог'));
    assert.ok(q.some((x) => x.id === task.id));
    const back = await ok('PATCH', `/pages/${task.id}`, { status: 'todo' });
    assert.equal(back.done_at, null);
  });
  await test('bad values rejected', async () => {
    assert.equal((await call('PATCH', `/pages/${task.id}`, { status: 'weird' })).status, 400);
    assert.equal((await call('PATCH', `/pages/${task.id}`, { due: '02.11.2026' })).status, 400);
    assert.equal((await call('PATCH', `/pages/${task.id}`, { assignee_id: 99999 })).status, 400);
    assert.equal((await call('GET', '/pages/99999')).status, 404);
  });
  await test('nested pages, breadcrumbs, no cycles, trash and restore', async () => {
    const root = await ok('POST', '/pages', { kind: 'page', title: 'База знань' });
    const child = await ok('POST', '/pages', { kind: 'page', title: 'Як здавати', parent_id: root.id });
    const grand = await ok('POST', '/pages', { kind: 'page', title: 'Чекліст', parent_id: child.id });
    const g = await ok('GET', `/pages/${grand.id}`);
    assert.deepEqual(g.crumbs.map((c) => c.title), ['База знань', 'Як здавати']);
    assert.equal((await ok('GET', `/pages/${root.id}`)).children.length, 1);
    assert.equal((await call('PATCH', `/pages/${root.id}`, { parent_id: grand.id })).status, 400);
    const del = await ok('DELETE', `/pages/${root.id}`);
    assert.equal(del.n, 3);
    assert.equal((await ok('GET', '/pages?kind=page')).length, 0);
    assert.equal((await ok('GET', '/pages?trash=1')).length, 3);
    await ok('POST', `/pages/${root.id}/restore`);
    assert.equal((await ok('GET', '/pages?kind=page')).length, 3);
    assert.equal((await call('DELETE', `/pages/${child.id}/purge`)).status, 400); // спершу в кошик
    await ok('DELETE', `/pages/${child.id}`);
    await ok('DELETE', `/pages/${child.id}/purge`);
    assert.equal((await call('GET', `/pages/${grand.id}`)).status, 404); // каскадом
  });
  await test('comments, duplicate, search includes pages', async () => {
    const c = await ok('POST', `/pages/${task.id}/comments`, { text: 'Глянь, будь ласка' });
    assert.equal(c.user_name, 'Ангеліна');
    assert.equal((await ok('GET', `/pages/${task.id}`)).comments, 1);
    assert.equal((await call('POST', `/pages/${task.id}/comments`, { text: '   ' })).status, 400);
    const d = await ok('POST', `/pages/${task.id}/duplicate`);
    assert.match(d.title, /копія/);
    assert.equal(d.blocks.length, task.blocks.length);
    const s = await ok('GET', '/search?q=' + encodeURIComponent('Зверстати'));
    assert.ok(s.pages.length >= 2);
    await ok('DELETE', `/comments/${c.id}`);
  });
  await test('viewer read-only; member writes; only admins can be assignees', async () => {
    // заводимо людей через API доступів
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(env.DB_PATH);
    db.exec("INSERT INTO users(tg_id, name, role, status) VALUES(5001, 'Глядач', 'viewer', 'active'), (5002, 'Олег', 'member', 'active')");
    db.close();
    assert.ok((await ok('GET', '/pages?kind=task', null, 5001)).length >= 1);
    assert.equal((await call('POST', '/pages', { title: 'x' }, 5001)).status, 403);
    assert.equal((await call('PATCH', `/pages/${task.id}`, { status: 'doing' }, 5001)).status, 403);
    const m = await ok('POST', '/pages', { title: 'Задача від команди', assignee_id: null }, 5002);
    const memberId = (await ok('GET', '/me', null, 5002)).user.id;
    const adminId = (await ok('GET', '/me')).user.id;
    assert.equal((await call('PATCH', `/pages/${m.id}`, { assignee_id: memberId }, 5002)).status, 400);
    const meta2 = await ok('GET', '/pages/meta');
    assert.ok(meta2.members.every((u) => u.role === 'admin'));
    assert.ok(!meta2.members.some((u) => u.id === memberId));
    const assigned = await ok('PATCH', `/pages/${m.id}`, { assignee_id: adminId }, 5002);
    assert.equal(assigned.assignee_name, 'Ангеліна');
    assert.ok((await ok('GET', '/pages?kind=task&assignee=me')).some((x) => x.id === m.id));
  });
  await test('deleted (cancelled) project: task stays, project hidden from pickers', async () => {
    const deal = await ok('POST', '/deals', { section: 'Розробки', task: 'Лендинг', price: { amount: 10000, currency: 'USD' } });
    const t = await ok('POST', '/pages', { title: 'Задача проєкту', project_id: deal.id });
    assert.equal(t.project_name, 'Лендинг');
    assert.equal((await ok('GET', `/pages?kind=task&project_id=${deal.id}`)).length, 1);
    await ok('DELETE', `/deals/${deal.id}`);
    assert.equal((await ok('GET', `/pages/${t.id}`)).title, 'Задача проєкту');
    assert.ok(!(await ok('GET', '/pages/meta')).projects.some((p) => p.id === deal.id));
  });
} finally {
  srv.kill();
  if (process.exitCode) console.log(log.slice(-2000));
  console.log(`\n${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
