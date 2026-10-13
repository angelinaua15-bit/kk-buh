/**
 * Monobank (особистий API), щоденний бекап бази, автооновлення курсів.
 * Monobank: https://api.monobank.ua/docs/ — client-info, statement, webhook.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { all, db, get, getSetting, run, setSetting } from '../db.js';
import { createTx, today } from './finance.js';
import { guessCategory } from './nlp.js';
import { refreshRatesFromNBU } from './money.js';

const MONO = 'https://api.monobank.ua';
const ISO = { 980: 'UAH', 840: 'USD', 978: 'EUR', 985: 'PLN', 826: 'GBP' };

export const monoEnabled = () => Boolean(config.monoToken);

async function mono(pathname, init = {}) {
  if (!monoEnabled()) throw new Error('Monobank не підключено: додайте MONO_TOKEN');
  const res = await fetch(`${MONO}${pathname}`, {
    ...init,
    headers: { 'X-Token': config.monoToken, ...(init.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 429) throw new Error('Monobank: забагато запитів, спробуйте за хвилину');
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).errorDescription || msg; } catch {}
    throw new Error(`Monobank: ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

/** Секрет для URL вебхука (щоб ніхто сторонній не міг слати фейкові операції). */
export function monoWebhookSecret() {
  let s = getSetting('mono_webhook_secret');
  if (!s) {
    s = crypto.randomBytes(18).toString('base64url');
    setSetting('mono_webhook_secret', s);
  }
  return s;
}

export async function monoAccounts() {
  const info = await mono('/personal/client-info');
  const linked = Object.fromEntries(all('SELECT id, mono_account FROM accounts WHERE mono_account IS NOT NULL').map((a) => [a.mono_account, a.id]));
  return {
    name: info.name,
    accounts: (info.accounts || []).map((a) => ({
      id: a.id,
      currency: ISO[a.currencyCode] || String(a.currencyCode),
      type: a.type,
      pan: (a.maskedPan || [])[0] || a.iban || '',
      balance: a.balance,
      linked_account_id: linked[a.id] || null,
    })),
  };
}

/** Привʼязати рахунок Mono до рахунку бухгалтерії (або створити новий). */
export function linkMonoAccount(monoId, accountId, meta = {}) {
  run('UPDATE accounts SET mono_account = NULL WHERE mono_account = ?', monoId);
  if (accountId === 'new') {
    const name = `Mono ${meta.type === 'fop' ? 'ФОП' : 'картка'} ${meta.pan ? meta.pan.slice(-4) : ''}`.trim();
    const r = run('INSERT INTO accounts(name, type, currency, emoji, mono_account) VALUES(?,?,?,?,?)',
      name, meta.type === 'fop' ? 'bank' : 'card', meta.currency || 'UAH', meta.type === 'fop' ? '🏦' : '💳', monoId);
    return Number(r.lastInsertRowid);
  }
  if (accountId) run('UPDATE accounts SET mono_account = ? WHERE id = ?', monoId, Number(accountId));
  return accountId ? Number(accountId) : null;
}

/** Одна операція з виписки Mono → операція в бухгалтерії. Повертає tx або null (дубль/непривʼязаний рахунок). */
export function importMonoItem(monoAccountId, item) {
  if (!item?.id || get('SELECT id FROM mono_seen WHERE id = ?', item.id)) return null;
  const acc = get('SELECT * FROM accounts WHERE mono_account = ?', monoAccountId);
  if (!acc) return null;
  const amountMinor = Math.abs(Number(item.amount));
  if (!amountMinor) return null;
  const type = Number(item.amount) > 0 ? 'income' : 'expense';
  const text = [item.description, item.comment, item.counterName].filter(Boolean).join(' · ');
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date(Number(item.time) * 1000));
  const cat = guessCategory(type, text);
  const tx = createTx({
    type,
    amount: amountMinor,
    account_id: acc.id,
    category_id: cat?.id || null,
    date,
    comment: `Mono · ${text || 'операція'}`.slice(0, 300),
  }, { id: null, role: 'admin' });
  run('INSERT INTO mono_seen(id, account, tx_id) VALUES(?,?,?)', item.id, monoAccountId, tx.id);
  return tx;
}

/** Підтягує виписку за останні N днів для всіх привʼязаних рахунків (ліміт Mono — 1 запит/хв на рахунок). */
export async function syncMono(days = 3) {
  const linked = all('SELECT id, mono_account FROM accounts WHERE mono_account IS NOT NULL AND archived = 0');
  const to = Math.floor(Date.now() / 1000);
  const from = to - Math.min(days, 30) * 86400;
  const created = [];
  const errors = [];
  for (let i = 0; i < linked.length; i++) {
    const a = linked[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 61000));
    try {
      const items = await mono(`/personal/statement/${a.mono_account}/${from}/${to}`);
      for (const it of [...items].reverse()) {
        const tx = importMonoItem(a.mono_account, it);
        if (tx) created.push(tx);
      }
    } catch (e) {
      errors.push(e.message);
    }
  }
  setSetting('mono_last_sync', new Date().toISOString());
  return { created, errors };
}

export async function setMonoWebhook(baseUrl) {
  const url = `${baseUrl.replace(/\/$/, '')}/mono/webhook/${monoWebhookSecret()}`;
  await mono('/personal/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ webHookUrl: url }) });
  setSetting('mono_webhook_url', url);
  return url;
}

/* ───────────── Бекап ───────────── */

export function makeBackup() {
  const file = path.join(os.tmpdir(), `kkbuh-backup-${today()}-${Date.now()}.sqlite`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const buf = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return { buffer: buf, filename: `kkbuh-backup-${today()}.sqlite` };
}

/* ───────────── Курси ───────────── */

export async function dailyRates() {
  if (getSetting('rates_day') === today()) return 0;
  const n = await refreshRatesFromNBU();
  setSetting('rates_day', today());
  return n;
}
