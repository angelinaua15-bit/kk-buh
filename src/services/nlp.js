/**
 * Розбір операції з вільного тексту (або розшифрованого голосу):
 *   «отримала 500$ від ABV за сайт на ФОП»
 *   «-300 грн реклама в інсту вчора»
 *   «виплата Максу 400$ за бота»
 * Повертає чернетку, яку бот показує на підтвердження. Нічого не зберігає сам.
 */
import { all, get } from '../db.js';
import { today } from './finance.js';

const CURRENCY_WORDS = [
  [/(usdt|тезер|₮|юсдт)/i, 'USDT'],
  [/(\$|usd|дол(л)?ар|бакс|доларів|долари)/i, 'USD'],
  [/(€|eur|євро|евро)/i, 'EUR'],
  [/(zł|pln|злот)/i, 'PLN'],
  [/(£|gbp|фунт)/i, 'GBP'],
  [/(₴|грн|гривн|гривень|uah)/i, 'UAH'],
];

const INCOME_RE = /(отрима|прийш|надійш|зайшл|оплатив нам|оплатила нам|заплатив нам|заплатила нам|передоплат|аванс від|дохід|доход|продаж|від клієнт|\bвід\b|скинув|скинула|перевів нам|перевела нам)/i;
const EXPENSE_RE = /(витрат|заплатил|заплатив|оплатил|оплатив|купил|купив|виплат|зарплат|переказал[аи]? (?!нам)|реклам|податок|комісі|хостинг|домен|підписк|сервіс)/i;

const CATEGORY_RULES = {
  income: [
    [/(бот|mini ?app|міні ?ап|телеграм)/i, 'Telegram-боти / Mini Apps'],
    [/(сайт|ленд|верстк|hubspot|wordpress|веб)/i, 'Розробка сайтів'],
    [/(seo|сео)/i, 'SEO'],
    [/(таргет|трафік|реклам|ads)/i, 'Трафік / таргет'],
    [/(дизайн|ui|ux|логотип|брендинг|фігма|figma)/i, 'Дизайн / UI/UX'],
    [/(підтримк|супровід|абонплат)/i, 'Підтримка / супровід'],
  ],
  expense: [
    [/(виплат|зарплат|зп\b|команд)/i, 'Виплати команді'],
    [/(фріланс|підрядник|субпідряд|аутсорс)/i, 'Субпідрядники / фріланс'],
    [/(реклам|таргет|бюджет|ads|інст|фейсбук|meta|google ads)/i, 'Реклама (бюджети)'],
    [/(хостинг|домен|сервер|vps)/i, 'Хостинг / домени'],
    [/(підписк|сервіс|chatgpt|figma|notion|canva|adobe|claude)/i, 'Сервіси та підписки'],
    [/(податок|єсв|єп\b|військов)/i, 'Податки'],
    [/(комісі|банк|еквайринг)/i, 'Банк / комісії'],
    [/(реферал|партнер|відсот)/i, '% партнерам / реферали'],
    [/(офіс|оренд|ноутбук|техні|монітор)/i, 'Офіс / техніка'],
    [/(курс|навчан|книг)/i, 'Навчання'],
  ],
};

const ACCOUNT_RULES = [
  [/(фоп|fop|рахунок фоп)/i, (a) => a.type === 'bank'],
  [/(готівк|кеш|cash|налик)/i, (a) => a.type === 'cash'],
  [/(крипт|usdt|trc|бінанс|binance)/i, (a) => a.type === 'crypto'],
  [/(моно|mono|карт)/i, (a) => a.type === 'card'],
];

const norm = (s) => String(s || '').toLowerCase().replace(/[’'`ʼ]/g, '').replace(/\s+/g, ' ').trim();

/** Український відмінок: «Максу», «Максом» → «макс»; «ABV-шці» тощо. Порівнюємо за основою. */
function stemMatch(text, name) {
  const n = norm(name);
  if (n.length < 2) return 0;
  const t = ` ${norm(text).replace(/[^\p{L}\p{N}\s]/gu, ' ')} `;
  if (t.includes(` ${n} `)) return 3;
  if (t.includes(n)) return 2;
  const words = n.split(' ').filter((w) => w.length >= 3);
  for (const w of words) {
    const stem = w.length >= 3 ? w.slice(0, w.length - 1) : w;
    if (new RegExp(`(^|\\s)${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\p{L}{0,3}(\\s|$)`, 'u').test(t)) return 1;
  }
  return 0;
}

function bestMatch(text, rows) {
  let best = null;
  let score = 0;
  for (const r of rows) {
    const s = stemMatch(text, r.name);
    if (s > score || (s === score && s > 0 && best && r.name.length > best.name.length)) {
      best = r;
      score = s;
    }
  }
  return score > 0 ? best : null;
}

function parseAmount(text) {
  const re = /([+\-−])?\s*(\d{1,3}(?:[  .]\d{3})+|\d+)(?:[.,](\d{1,2}))?\s*(к|k|тис\.?|тисяч)?(?![\d])/gi;
  let m;
  const found = [];
  while ((m = re.exec(text))) {
    const whole = m[2].replace(/[  .]/g, '');
    let n = Number(`${whole}${m[3] ? '.' + m[3] : ''}`);
    if (m[4]) n *= 1000;
    const before = text.slice(Math.max(0, m.index - 1), m.index);
    const after = text.slice(re.lastIndex, re.lastIndex + 2);
    const hasCur = /^\s?[$€₴₮£]/.test(after) || /[$€₴₮£]\s?$/.test(before);
    // час 15:00
    if (/^:/.test(after) || /:$/.test(before)) continue;
    // дата 05.10 / 05.10.2026 (а не 12.50$)
    if (!hasCur && !m[4] && m[3] && Number(m[2]) >= 1 && Number(m[2]) <= 31 && Number(m[3]) >= 1 && Number(m[3]) <= 12 && m[2].length <= 2) continue;
    if (/^[./]\d/.test(after) || /\d[./]$/.test(text.slice(Math.max(0, m.index - 2), m.index))) continue;
    if (n > 0) found.push({ n, sign: m[1], index: m.index, len: m[0].length });
  }
  if (!found.length) return null;
  return found.sort((a, b) => b.n - a.n)[0];
}

function parseDate(text) {
  const t = norm(text);
  const base = new Date(`${today()}T12:00:00Z`);
  const shift = (d) => new Date(base.getTime() - d * 864e5).toISOString().slice(0, 10);
  if (/позавчора/.test(t)) return shift(2);
  if (/вчора/.test(t)) return shift(1);
  const m = t.match(/(?:^|\s)(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?:\s|$)/);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : today().slice(0, 4);
    const d = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (!Number.isNaN(Date.parse(d))) return d;
  }
  return today();
}

export function parseOperation(text, { forcedType } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const amt = parseAmount(raw);
  if (!amt) return null;

  let currency = null;
  for (const [re, c] of CURRENCY_WORDS) if (re.test(raw)) { currency = c; break; }

  let type = forcedType || null;
  if (!type) {
    if (amt.sign === '+') type = 'income';
    else if (amt.sign === '-' || amt.sign === '−') type = 'expense';
    else if (/(\bвід\b|отрима|прийш|надійш|передоплат|аванс)/i.test(raw)) type = 'income';
    else if (EXPENSE_RE.test(raw)) type = 'expense';
    else if (INCOME_RE.test(raw)) type = 'income';
  }
  if (!type) return null;
  const PAID_RE = /(оплатил|оплатив|заплатил|заплатив|скинул|скинув|перевел|перевів|переказал|переказав|розрахувал|розрахувався)/i;

  const accounts = all('SELECT * FROM accounts WHERE archived = 0 ORDER BY sort, id');
  let account = null;
  for (const [re, pred] of ACCOUNT_RULES) {
    if (re.test(raw)) {
      account = accounts.find((a) => pred(a) && (!currency || a.currency === currency || (currency === 'USD' && a.currency === 'USDT'))) || accounts.find(pred) || null;
      if (account) break;
    }
  }
  if (!account && currency) account = accounts.find((a) => a.currency === currency) || null;
  if (!account) account = accounts[0] || null;
  if (!currency && account) currency = account.currency;

  const clients = all('SELECT id, name FROM clients WHERE archived = 0');
  const projects = all("SELECT id, name, client_id FROM projects WHERE status NOT IN ('cancelled')");
  const members = all("SELECT id, name, username FROM users WHERE status = 'active'");

  const project = bestMatch(raw, projects);
  let client = bestMatch(raw, clients);
  if (!client && project?.client_id) client = clients.find((c) => c.id === project.client_id) || null;
  const memberHit = bestMatch(raw, members.map((m) => ({ ...m, name: m.name })))
    || bestMatch(raw, members.filter((m) => m.username).map((m) => ({ ...m, name: m.username })));
  // «Толстікова оплатила 1200 за бота» — платить клієнт, отже це дохід
  if (!forcedType && !amt.sign && type === 'expense' && client && !memberHit && PAID_RE.test(raw)
    && !CATEGORY_RULES.expense.slice(1).some(([re]) => re.test(raw))) {
    type = 'income';
  }
  const member = type === 'expense' ? memberHit : null;

  let categoryName = null;
  for (const [re, name] of CATEGORY_RULES[type]) if (re.test(raw)) { categoryName = name; break; }
  if (type === 'expense' && member && !categoryName) categoryName = 'Виплати команді';
  const category = categoryName
    ? get('SELECT id, name, emoji FROM categories WHERE kind = ? AND name = ? AND archived = 0', type, categoryName)
    : null;

  // коментар — текст без суми й валюти
  const comment = raw
    .replace(raw.substr(amt.index, amt.len), ' ')
    .replace(/(\$|₴|€|₮|usdt|usd|uah|eur|грн\.?|гривень|доларів|долари|долар|баксів)/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.:;–—-]+|[\s,.:;–—-]+$/g, '')
    .slice(0, 300);

  return {
    type,
    amount: Math.round(amt.n * 100),
    currency,
    account_id: account?.id || null,
    account_name: account?.name || null,
    account_currency: account?.currency || null,
    category_id: category?.id || null,
    category_name: category?.name || null,
    project_id: project?.id || null,
    project_name: project?.name || null,
    client_id: client?.id || null,
    client_name: client?.name || null,
    member_id: member?.id || null,
    member_name: member?.name || null,
    date: parseDate(raw),
    comment: comment || null,
    currencyMismatch: Boolean(account && currency && account.currency !== currency
      && !(currency === 'USD' && account.currency === 'USDT')),
  };
}

/** Категорія за текстом (для Monobank, чеків тощо). */
export function guessCategory(type, text) {
  for (const [re, name] of CATEGORY_RULES[type] || []) {
    if (re.test(String(text || ''))) {
      return get('SELECT id, name FROM categories WHERE kind = ? AND name = ? AND archived = 0', type, name) || null;
    }
  }
  return null;
}
