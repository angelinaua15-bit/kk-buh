/** Monobank: імпорт операції з вебхука, дедуплікація, захист секретом. node tests/mono.test.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkmono-'));
Object.assign(process.env, { DB_PATH: path.join(dir, 'db.sqlite'), BOT_TOKEN: '', TZ: 'Europe/Kyiv' });
const { get, run } = await import('../src/db.js');
const { importMonoItem, linkMonoAccount, monoWebhookSecret } = await import('../src/services/integrations.js');

const accId = linkMonoAccount('monoACC1', 'new', { type: 'fop', currency: 'UAH', pan: '537541******1234' });
assert.ok(get('SELECT * FROM accounts WHERE id=? AND mono_account=?', accId, 'monoACC1'));
const item = { id: 'ZuHWzqkKGVo=', time: 1760360000, description: 'Google Ads', mcc: 7311, amount: -125000, currency: 980 };
const t = importMonoItem('monoACC1', item);
assert.equal(t.type, 'expense');
assert.equal(t.amount, 125000);
assert.equal(t.category_name, 'Реклама (бюджети)');
assert.equal(importMonoItem('monoACC1', item), null, 'duplicate must be skipped');
assert.equal(importMonoItem('unknown', { ...item, id: 'other' }), null, 'unlinked account skipped');
const inc = importMonoItem('monoACC1', { id: 'in1', time: 1760360000, description: 'Від: ТОВ АБВ', comment: 'оплата за сайт', amount: 2000000, currency: 980 });
assert.equal(inc.type, 'income');
assert.equal(inc.category_name, 'Розробка сайтів');
// relink to existing account moves the link
const other = get("SELECT id FROM accounts WHERE name='Картка Mono'").id;
linkMonoAccount('monoACC1', other);
assert.equal(get('SELECT mono_account FROM accounts WHERE id=?', accId).mono_account, null);
assert.ok(monoWebhookSecret().length > 10);
console.log('✔ mono import, dedupe, categories, relink');
fs.rmSync(dir, { recursive: true, force: true });
