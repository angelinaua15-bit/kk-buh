import { all, get, getSetting, run } from '../db.js';

export const CURRENCY_SYMBOLS = { UAH: '₴', USD: '$', EUR: '€', USDT: '₮', PLN: 'zł', GBP: '£' };

export const baseCurrency = () => getSetting('base_currency', 'USD');

export const toMinor = (v) => Math.round(Number(String(v).replace(/\s/g, '').replace(',', '.')) * 100);
export const fromMinor = (v) => (Number(v) || 0) / 100;

export function fmt(minor, currency) {
  const n = fromMinor(minor);
  const s = n.toLocaleString('uk-UA', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const sym = CURRENCY_SYMBOLS[currency] || currency || '';
  return currency === 'USD' || currency === 'EUR' || currency === 'GBP' ? `${sym}${s}` : `${s} ${sym}`;
}

export function rateMap() {
  const m = {};
  for (const r of all('SELECT currency, uah FROM rates')) m[r.currency] = r.uah;
  m.UAH = 1;
  return m;
}

/** Multiplier converting an amount in `from` into `to` at current rates. */
export function rateBetween(from, to, rates = rateMap()) {
  if (from === to) return 1;
  const a = rates[from];
  const b = rates[to];
  if (!a || !b) throw new Error(`Немає курсу для ${!a ? from : to}`);
  return a / b;
}

export const convert = (minor, from, to, rates) => Math.round(minor * rateBetween(from, to, rates));

export function currencies() {
  return all('SELECT currency, uah, source, updated_at FROM rates ORDER BY currency = ? DESC, currency', 'UAH');
}

export function setRate(currency, uah, source = 'manual') {
  run(
    `INSERT INTO rates(currency, uah, source, updated_at) VALUES(?,?,?,datetime('now'))
     ON CONFLICT(currency) DO UPDATE SET uah = excluded.uah, source = excluded.source, updated_at = excluded.updated_at`,
    currency.toUpperCase(),
    Number(uah),
    source,
  );
}

/** Pulls official NBU rates. Manual overrides (source = 'manual') are kept. */
export async function refreshRatesFromNBU() {
  const res = await fetch('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json', {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`NBU ${res.status}`);
  const list = await res.json();
  const known = new Set(all('SELECT currency FROM rates WHERE source != ?', 'manual').map((r) => r.currency));
  let updated = 0;
  for (const r of list) {
    if (known.has(r.cc)) {
      setRate(r.cc, r.rate, 'НБУ');
      updated++;
    }
  }
  const usd = list.find((r) => r.cc === 'USD');
  if (usd && known.has('USDT')) setRate('USDT', usd.rate, 'НБУ (=USD)');
  return updated;
}

export const accountCurrency = (accountId) => get('SELECT currency FROM accounts WHERE id = ?', accountId)?.currency;
