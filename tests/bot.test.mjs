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

await test('deal wizard asks every column of the sheet and saves a deal', async () => {
  sent.length = 0;
  await text(111, '➕ Новий проєкт');
  const tapOpt = async (label) => {
    const btn = (lastReply().payload.reply_markup?.inline_keyboard || []).flat().find((b) => b.text.startsWith(label));
    assert.ok(btn, `no button «${label}» in: ${lastReply().payload.text}`);
    assert.ok(Buffer.byteLength(btn.callback_data) <= 64, 'callback_data ≤ 64 bytes');
    await tap(111, btn.callback_data);
  };
  await tapOpt('Розробки');
  assert.match(lastReply().payload.text, /Виконавець/);
  await text(111, 'Роман розробка');
  assert.match(lastReply().payload.text, /Замовник/);
  await text(111, '@wizardclient');
  assert.match(lastReply().payload.text, /Тип роботи/);
  await text(111, 'Бот тг');
  assert.match(lastReply().payload.text, /Завдання/);
  await text(111, 'Бот для замовлень');
  assert.match(lastReply().payload.text, /Дата початку/);
  await text(111, '01.10');
  assert.match(lastReply().payload.text, /Дата завершення/);
  await tapOpt('Пропустити');
  assert.match(lastReply().payload.text, /Метод оплати/);
  await tapOpt('ФОП');
  assert.match(lastReply().payload.text, /Ціна/);
  await text(111, 'дорого');
  assert.match(lastReply().payload.text, /Напиши суму/);
  await text(111, '12000 грн');
  assert.match(lastReply().payload.text, /Передоплата від замовника/);
  await text(111, '6000');
  assert.match(lastReply().payload.text, /Передоплата прог/);
  await text(111, '2000 грн');
  assert.match(lastReply().payload.text, /Маржа/);
  await text(111, '20000 грн');
  assert.match(lastReply().payload.text, /не може бути більшою/);
  await text(111, '6000 грн');
  assert.match(lastReply().payload.text, /Доп\. послуга/);
  await tapOpt('Пропустити');
  assert.match(lastReply().payload.text, /закрита/);
  await tapOpt('⏳');
  assert.match(lastReply().payload.text, /Виконавцю вже виплачено/);
  await tapOpt('Ні, ще винні');
  const card = lastReply().payload.text;
  assert.match(card, /Перевір проєкт/);
  assert.match(card, /Виконавцю всього: 6\s?000 ₴/);
  assert.match(card, /замовник винен 6\s?000 ₴/);
  await tapOpt('✅ Зберегти');
  const p = get("SELECT * FROM projects WHERE name = 'Бот для замовлень'");
  assert.ok(p && p.section === 'Розробки' && p.closed === 0);
  // закрити з бота
  sent.length = 0;
  await text(111, '📋 Проєкти');
  const close = sent.flatMap((x) => (x.payload.reply_markup?.inline_keyboard || []).flat()).find((b) => b.callback_data === `dclose:${p.id}`);
  assert.ok(close, 'close button');
  await tap(111, close.callback_data);
  assert.equal(get('SELECT closed FROM projects WHERE id=?', p.id).closed, 1);
});

await test('/summary and member deals', async () => {
  sent.length = 0;
  await text(111, '/summary');
  assert.match(lastReply().payload.text, /Підсумки/);
  sent.length = 0;
  await text(333, '➕ Новий проєкт');
  assert.match(lastReply().payload.text, /адмін або фінансист/);
});

await test('HTML in names is escaped', async () => {
  run("UPDATE accounts SET name = 'Mono <b>x</b> & co' WHERE id = 1");
  await text(111, '💼 Баланс');
  assert.ok(lastReply().payload.text.includes('&lt;b&gt;x&lt;/b&gt; &amp; co'));
});

// ── запрошення ──
{
  const { inviteLink, resetInviteCode } = await import('../src/auth.js');
  await test('/invite → link + roles, only for admin', async () => {
    await text(111, '/invite');
    const r = lastReply();
    assert.match(r.payload.text, /start=join_[a-f0-9]+/);
    assert.ok(lastKbData().includes('inv:reset'));
  });
  await test('opening invite link → active admin, no approval request', async () => {
    const code = inviteLink().split('join_')[1];
    await text(9222, `/start join_${code}`);
    const u = get('SELECT * FROM users WHERE tg_id=9222');
    assert.equal(u.status, 'active');
    assert.equal(u.role, 'admin');
    assert.match(lastReply().payload.text, /запрошенням/);
    assert.ok(!sent.some((x) => /Нова заявка/.test(x.payload.text || '')));
  });
  await test('stale invite code → pending request as before', async () => {
    const old = inviteLink().split('join_')[1];
    resetInviteCode();
    await text(9333, `/start join_${old}`);
    const u = get('SELECT * FROM users WHERE tg_id=9333');
    assert.equal(u.status, 'pending');
    await tap(111, `user:admin:${u.id}`);
    const u2 = get('SELECT * FROM users WHERE tg_id=9333');
    assert.equal(u2.role, 'admin');
    assert.equal(u2.status, 'active');
  });
  await test('invite role switch → finance; non-admin cannot invite', async () => {
    await tap(111, 'inv:role:finance');
    const code = inviteLink().split('join_')[1];
    await text(9444, `/start join_${code}`);
    assert.equal(get('SELECT role FROM users WHERE tg_id=9444').role, 'finance');
    await text(9444, '/invite');
    assert.match(lastReply().payload.text, /лише адмін/);
    await tap(111, 'inv:role:admin');
  });
  await test('open access → anyone becomes admin; off again → pending', async () => {
    const { setSetting } = await import('../src/db.js');
    setSetting('open_access', '1');
    await text(9555, '/start');
    assert.equal(get('SELECT status FROM users WHERE tg_id=9555').status, 'active');
    setSetting('open_access', '0');
    await text(9666, '/start');
    assert.equal(get('SELECT status FROM users WHERE tg_id=9666').status, 'pending');
  });
}


await test('/task → task with assignee, due, priority, tags; buttons work', async () => {
  run("INSERT OR IGNORE INTO users(tg_id, name, username, role, status) VALUES(9777, 'Олена Дизайн', 'olena_d', 'admin', 'active')");
  run("INSERT OR IGNORE INTO users(tg_id, name, username, role, status) VALUES(9778, 'Ігор Команда', 'igor_m', 'member', 'active')");
  // не адміна відповідальним не призначаємо — @нік лишається в назві
  await text(111, '/task Перевірити рекламу @igor_m');
  assert.equal(get("SELECT assignee_id FROM pages WHERE title LIKE 'Перевірити рекламу%'").assignee_id, get('SELECT id FROM users WHERE tg_id=111').id);
  await text(111, '/task Банер для ABV @olena_d завтра !! #дизайн');
  const r = lastReply();
  assert.match(r.payload.text, /Банер для ABV/);
  assert.match(r.payload.text, /Олена Дизайн/);
  assert.match(r.payload.text, /Терміново/);
  const p = get("SELECT * FROM pages WHERE title = 'Банер для ABV'");
  assert.equal(p.priority, 'urgent');
  assert.deepEqual(JSON.parse(p.tags), ['дизайн']);
  assert.ok(p.due);
  // виконавцю прийшло сповіщення
  assert.ok(sent.some((x) => x.method === 'sendMessage' && x.payload.chat_id === 9777 && /призначив/.test(x.payload.text)));
  const kb = lastKbData();
  assert.ok(kb.includes(`tk:done:${p.id}`));
  sent.length = 0;
  await tap(9777, `tk:doing:${p.id}`);
  assert.equal(get('SELECT status FROM pages WHERE id=?', p.id).status, 'doing');
  await tap(9777, `tk:done:${p.id}`);
  assert.equal(get('SELECT status FROM pages WHERE id=?', p.id).status, 'done');
  // автору (адміну) — що задачу закрили
  assert.ok(sent.some((x) => x.method === 'sendMessage' && x.payload.chat_id === 111 && /закрив/.test(x.payload.text)));
});

await test('📝 Задача button → next message becomes a task, not an operation', async () => {
  const txBefore = get('SELECT COUNT(*) AS n FROM transactions').n;
  await text(111, '📝 Задача');
  assert.match(lastReply().payload.text, /Напиши задачу/);
  await text(111, 'Оплатити 300 грн за домен пт');
  assert.equal(get('SELECT COUNT(*) AS n FROM transactions').n, txBefore);
  const p = get("SELECT * FROM pages WHERE title LIKE 'Оплатити 300 грн%'");
  assert.ok(p && p.due && p.assignee_id);
});

await test('/tasks lists my open tasks with ✅ buttons', async () => {
  await text(111, '/tasks');
  const r = lastReply();
  assert.match(r.payload.text, /Мої задачі/);
  assert.match(r.payload.text, /Оплатити 300 грн/);
  assert.ok(lastKbData().some((d) => d?.startsWith('tk:done:')));
});

console.log(`\n${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(process.exitCode || 0);
