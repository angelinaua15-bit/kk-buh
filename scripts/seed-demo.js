import { all, get, run } from '../src/db.js';
import { createTx } from '../src/services/finance.js';

if (get("SELECT COUNT(*) AS n FROM transactions").n) {
  console.log('База вже має операції — демо не чіпаю.');
  process.exit(0);
}

const acc = Object.fromEntries(all('SELECT name, id FROM accounts').map((a) => [a.name, a.id]));
const cat = Object.fromEntries(all('SELECT name, id FROM categories').map((c) => [c.name, c.id]));

run("INSERT INTO clients(name, contact, notes) VALUES(?,?,?)", 'ABV Traffic', 'Олексій', 'трафік + лендінги');
run("INSERT INTO clients(name, contact) VALUES(?,?)", 'Food by Dr. Tolstikova', 'Марина');
run("INSERT INTO clients(name) VALUES(?)", 'TopTrend Shop');
const clients = Object.fromEntries(all('SELECT name, id FROM clients').map((c) => [c.name, c.id]));

run("INSERT INTO projects(name, client_id, status, budget, currency, deadline) VALUES(?,?,?,?,?,?)",
  'Сайт + SEO ABV', clients['ABV Traffic'], 'active', 450000, 'USD', '2026-11-30');
run("INSERT INTO projects(name, client_id, status, budget, currency) VALUES(?,?,?,?,?)",
  'Mini App Tolstikova', clients['Food by Dr. Tolstikova'], 'active', 180000, 'USD');
run("INSERT INTO projects(name, client_id, status, budget, currency) VALUES(?,?,?,?,?)",
  'Магазин TopTrend', clients['TopTrend Shop'], 'done', 220000, 'USD');
const projects = Object.fromEntries(all('SELECT name, id FROM projects').map((p) => [p.name, p.id]));

run("INSERT INTO users(name, role, status, position) VALUES(?,?,?,?)", 'Іра', 'member', 'active', 'дизайнер');
run("INSERT INTO users(name, role, status, position) VALUES(?,?,?,?)", 'Макс', 'member', 'active', 'розробник');
run("INSERT INTO users(name, role, status, position) VALUES(?,?,?,?)", 'Софія', 'finance', 'active', 'акаунт');
const people = Object.fromEntries(all("SELECT name, id FROM users").map((u) => [u.name, u.id]));

const admin = { id: people['Софія'] || null, role: 'admin' };
const tx = (t) => createTx(t, admin);

const rows = [
  { type: 'income', date: '2026-08-12', amount: 150000, account: 'Готівка $', cat: 'Розробка сайтів', project: 'Сайт + SEO ABV', client: 'ABV Traffic', comment: 'Передплата 50%' },
  { type: 'income', date: '2026-09-03', amount: 180000, account: 'USDT (TRC20)', cat: 'Telegram-боти / Mini Apps', project: 'Mini App Tolstikova', client: 'Food by Dr. Tolstikova', comment: 'Запуск Mini App' },
  { type: 'income', date: '2026-09-20', amount: 220000, account: 'Готівка $', cat: 'Розробка сайтів', project: 'Магазин TopTrend', client: 'TopTrend Shop', comment: 'Фінальний платіж' },
  { type: 'income', date: '2026-10-05', amount: 120000, account: 'Готівка $', cat: 'SEO', project: 'Сайт + SEO ABV', client: 'ABV Traffic', comment: 'Другий транш SEO' },
  { type: 'expense', date: '2026-09-01', amount: 80000, account: 'Готівка $', cat: 'Виплати команді', member: 'Макс', comment: 'Вересень розробка' },
  { type: 'expense', date: '2026-09-01', amount: 45000, account: 'Готівка $', cat: 'Виплати команді', member: 'Іра', comment: 'Вересень дизайн' },
  { type: 'expense', date: '2026-10-01', amount: 85000, account: 'Готівка $', cat: 'Виплати команді', member: 'Макс', comment: 'Жовтень' },
  { type: 'expense', date: '2026-10-01', amount: 45000, account: 'Готівка $', cat: 'Виплати команді', member: 'Іра', comment: 'Жовтень' },
  { type: 'expense', date: '2026-09-10', amount: 2500000, account: 'Картка Mono', cat: 'Реклама (бюджети)', project: 'Сайт + SEO ABV', comment: 'Meta Ads ABV' },
  { type: 'expense', date: '2026-10-04', amount: 1800000, account: 'Картка Mono', cat: 'Реклама (бюджети)', comment: 'Google Ads' },
  { type: 'expense', date: '2026-08-20', amount: 120000, account: 'Картка Mono', cat: 'Сервіси та підписки', comment: 'Figma + Notion + ChatGPT' },
  { type: 'expense', date: '2026-09-15', amount: 89000, account: 'Картка Mono', cat: 'Хостинг / домени', comment: 'Vercel + домени' },
  { type: 'expense', date: '2026-10-08', amount: 320000, account: 'Monobank ФОП', cat: 'Податки', comment: 'ЄСВ + ЄП' },
  { type: 'transfer', date: '2026-10-02', amount: 40000, account: 'Готівка $', to: 'Картка Mono', comment: 'Обмін $ → картка' },
  { type: 'income', date: '2026-11-15', amount: 180000, account: 'Готівка $', cat: 'Розробка сайтів', project: 'Сайт + SEO ABV', client: 'ABV Traffic', comment: 'Фінал за договором', status: 'planned' },
];

for (const r of rows) {
  tx({
    type: r.type,
    status: r.status || 'done',
    date: r.date,
    amount: r.amount,
    account_id: acc[r.account],
    to_account_id: r.to ? acc[r.to] : null,
    category_id: r.cat ? cat[r.cat] : null,
    project_id: r.project ? projects[r.project] : null,
    client_id: r.client ? clients[r.client] : null,
    member_id: r.member ? people[r.member] : null,
    comment: r.comment,
  });
}

run("INSERT INTO recurring(title, type, amount, account_id, category_id, day_of_month) VALUES(?,?,?,?,?,?)",
  'Підписки (Figma/Notion/AI)', 'expense', 120000, acc['Картка Mono'], cat['Сервіси та підписки'], 5);
run("INSERT INTO recurring(title, type, amount, account_id, category_id, member_id, day_of_month) VALUES(?,?,?,?,?,?,?)",
  'Виплата Макс', 'expense', 85000, acc['Готівка $'], cat['Виплати команді'], people['Макс'], 1);

console.log('Демо-дані King Kong Lab завантажено. Відкрий Mini App.');
