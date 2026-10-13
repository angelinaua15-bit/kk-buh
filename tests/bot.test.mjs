/**
 * Тести бота без Telegram: node tests/bot.test.mjs
 * Підміняємо Bot API трансформером і проганяємо апдейти через bot.handleUpdate.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkbot-test-'));
Object.assign(process.env, { DB_PATH: path.join(dir, 'db.sqlite'), BOT_TOKEN: '123:TEST', ADMIN_IDS: '111', WEBAPP_URL: 'https://kk.example.com', TZ: 'Europe/Kyiv', OPENAI_API_KEY: '' });

const { bot } = await import('../src/bot.js');
const { all, get, run } = await import('../src/db.js');
bot.botInfo = { id: 1, is_bot: true, first_name: 'KK', username: 'KKLabSystemBot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };

const sent = [];
let msgId = 100;
bot.api.config.use(async (_prev, method, payload) => {
  sent.push({ method, payload });
  if (method === 'getFile') return { ok: true, result: { file_id: 'f', file_unique_id: 'u', file_path: 'x.ogg' } };
  return { ok: true, result: method.startsWith('send') || method === 'editMessageText' ? { message_id: ++msgId, date: 0, chat: { id: payload.chat_id || 111, type: 'private' }, text: payload.text || '' } : true };
});

let upd = 1;
const from = (id, name = 'Ангеліна') => ({ id, is_bot: false, first_name: name, username: `u${id}` });
const text = (id, t) => bot.handleUpdate({ update_id: upd++, message: { message_id: upd, date: 0, chat: { id, type: 'private' }, from: from(id), text: t, ...(t.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: t.split(' ')[0].length }] } : {}) } });
const tap = (id, data) => bot.handleUpdate({ update_id: upd++, callback_query: { id: String(upd), from: from(id), chat_instance: 'c', data, message: { message_id: 50, date: 0, chat: { id, type: 'private' }, text: 'x' } } });
const lastReply = () => [...sent].reverse().find((s) => s.method === 'sendMessage');
const lastKbData = () => (lastReply()?.payload.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data);

let passed = 0;
const test = async (name, fn) => {
  sent.length = 0;
  try { await fn(); passed++; console.log('✔', name); } catch (e) { console.error('✘', name, '\n ', e.stack.split('\n').slice(0, 3).join('\n  ')); process.exitCode = 1; }
};

run("INSERT INTO clients(name) VALUES('ABV Traffic')");
run("INSERT INTO projects(name, client_id, budget, currency, status) VALUES('Сайт ABV', 1, 100000, 'USD', 'active')");

await test('/start admin → keyboard with Mini App', async () => {
  await text(111, '/start');
  const r = lastReply();
  assert.match(r.payload.text, /Ангеліна/);
  const kb = r.payload.reply_markup.keyboard.flat().map((b) => b.text);
  assert.ok(kb.includes('📌 Борги') && kb.includes('⚡ Шаблони'));
});

await test('free text → draft card, nothing saved until ✅', async () => {
  const before = get('SELECT COUNT(*) AS n FROM transactions').n;
  await text(111, 'отримала 500$ від ABV за сайт на ФОП');
  const r = lastReply();
  assert.match(r.payload.text, /Дохід/);
  assert.match(r.payload.text, /ABV Traffic/);
  assert.match(r.payload.text, /на рахунок/); // $ на гривневий ФОП → конвертація
  assert.equal(get('SELECT COUNT(*) AS n FROM transactions').n, before);
  const save = lastKbData().find((d) => d.startsWith('d:save:'));
  const id = save.split(':')[2];
  await tap(111, `d:acc:${id}`); // інший рахунок
  await tap(111, `d:type:${id}`); // перемкнути тип
  await tap(111, `d:type:${id}`); // назад
  await tap(111, save);
  const tx = get('SELECT * FROM transactions ORDER BY id DESC LIMIT 1');
  assert.equal(tx.type, 'income');
  assert.equal(tx.project_id, 1);
  assert.equal(tx.status, 'done');
  // повторне натискання не створює дубль
  await tap(111, save);
  assert.equal(get('SELECT COUNT(*) AS n FROM transactions').n, before + 1);
});

await test('number without type → hint, no crash', async () => {
  await text(111, '1200 щось');
  assert.match(lastReply().payload.text, /дохід чи витрата/);
});

await test('➖ Витрата then text → forced expense draft', async () => {
  await text(111, '➖ Витрата');
  await text(111, '300 грн таксі');
  assert.match(lastReply().payload.text, /Витрата/);
});

await test('menu buttons for admin work', async () => {
  for (const b of ['💼 Баланс', '📊 Місяць', '📅 План', '👥 Команда', '📌 Борги', '⚡ Шаблони']) {
    sent.length = 0;
    await text(111, b);
    assert.ok(lastReply(), `no reply for ${b}`);
  }
});

await test('commands: debts, forecast, taxes, payouts, week, compare, my', async () => {
  for (const c of ['/debts', '/forecast', '/taxes', '/payouts', '/week', '/compare', '/my', '/pending', '/balance', '/report', '/templates']) {
    sent.length = 0;
    await text(111, c);
    assert.ok(sent.some((s) => s.method === 'sendMessage'), `no reply for ${c}`);
  }
});

await test('debt reminder text callback', async () => {
  await text(111, '/debts');
  const rem = sent.flatMap((s) => (s.payload.reply_markup?.inline_keyboard || []).flat()).find((b) => b.callback_data?.startsWith('rem:'));
  assert.ok(rem, 'no reminder button');
  sent.length = 0;
  await tap(111, rem.callback_data);
  assert.match(lastReply().payload.text, /Нагадуємо про оплату/);
});

await test('/backup sends a document', async () => {
  await text(111, '/backup');
  assert.ok(sent.some((s) => s.method === 'sendDocument'));
});

await test('new user → pending + admin notified; then approved', async () => {
  await text(333, '/start');
  assert.match(lastReply().payload.text, /Заявку/);
  const u = get('SELECT * FROM users WHERE tg_id = 333');
  assert.equal(u.status, 'pending');
  await tap(111, `user:active:${u.id}`);
  assert.equal(get('SELECT status FROM users WHERE id=?', u.id).status, 'active');
});

await test('member: limited keyboard, expense goes to review, admin approves', async () => {
  sent.length = 0;
  await text(333, '/start');
  const kb = lastReply().payload.reply_markup.keyboard.flat().map((b) => b.text);
  assert.ok(kb.includes('👤 Мій кабінет') && !kb.includes('💼 Баланс'));
  await text(333, '💼 Баланс');
  assert.match(lastReply().payload.text, /Немає доступу/);
  await text(333, '-450 грн таксі до клієнта');
  const save = lastKbData().find((d) => d.startsWith('d:save:'));
  await tap(333, save);
  const tx = get('SELECT * FROM transactions ORDER BY id DESC LIMIT 1');
  assert.equal(tx.status, 'pending');
  // чужий користувач не може зберегти чужу чернетку
  await text(333, '-10 грн кава');
  const foreign = lastKbData().find((d) => d.startsWith('d:save:'));
  const n = get('SELECT COUNT(*) AS n FROM transactions').n;
  await tap(111, foreign);
  assert.equal(get('SELECT COUNT(*) AS n FROM transactions').n, n);
  await tap(111, `ok:${tx.id}`);
  assert.equal(get('SELECT status FROM transactions WHERE id=?', tx.id).status, 'done');
});

await test('voice without OPENAI key → polite message', async () => {
  await bot.handleUpdate({ update_id: upd++, message: { message_id: 9, date: 0, chat: { id: 111, type: 'private' }, from: from(111), voice: { file_id: 'v', file_unique_id: 'vu', duration: 3 } } });
  assert.match(lastReply().payload.text, /OPENAI_API_KEY/);
});

await test('photo with caption → draft with receipt attached', async () => {
  await bot.handleUpdate({ update_id: upd++, message: { message_id: 10, date: 0, chat: { id: 111, type: 'private' }, from: from(111), caption: '-450 грн хостинг', photo: [{ file_id: 'ph1', file_unique_id: 'p', width: 10, height: 10 }] } });
  const save = lastKbData().find((d) => d.startsWith('d:save:'));
  await tap(111, save);
  const tx = get('SELECT * FROM transactions ORDER BY id DESC LIMIT 1');
  assert.equal(tx.receipt_file_id, 'ph1');
  assert.equal(tx.amount, 45000);
});

await test('template tap creates tx', async () => {
  run("INSERT INTO templates(title, type, amount, account_id) VALUES('Оренда', 'expense', 1500000, 1)");
  const id = get('SELECT id FROM templates ORDER BY id DESC').id;
  await tap(111, `tpl:${id}`);
  const tx = get('SELECT * FROM transactions ORDER BY id DESC LIMIT 1');
  assert.equal(tx.amount, 1500000);
});

await test('HTML in names is escaped', async () => {
  run("UPDATE accounts SET name = 'Mono <b>x</b> & co' WHERE id = 1");
  await text(111, '💼 Баланс');
  assert.ok(lastReply().payload.text.includes('&lt;b&gt;x&lt;/b&gt; &amp; co'));
});

console.log(`\n${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(process.exitCode || 0);
