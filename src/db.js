import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  tg_id INTEGER UNIQUE,
  name TEXT NOT NULL,
  username TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'pending',
  position TEXT,
  notify INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'card',
  currency TEXT NOT NULL DEFAULT 'UAH',
  emoji TEXT DEFAULT '💳',
  initial_balance INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('income','expense')),
  name TEXT NOT NULL,
  emoji TEXT DEFAULT '•',
  color TEXT DEFAULT '#7B5CFF',
  monthly_limit INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  email TEXT,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  budget INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  start_date TEXT,
  deadline TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('income','expense','transfer')),
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','planned','pending','rejected')),
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  rate REAL NOT NULL DEFAULT 1,
  amount_base INTEGER NOT NULL,
  account_id INTEGER REFERENCES accounts(id),
  to_account_id INTEGER REFERENCES accounts(id),
  to_amount INTEGER,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  member_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  comment TEXT,
  receipt_file_id TEXT,
  recurring_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS tx_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS tx_project ON transactions(project_id);
CREATE INDEX IF NOT EXISTS tx_member ON transactions(member_id);

CREATE TABLE IF NOT EXISTS recurring (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income','expense')),
  amount INTEGER NOT NULL,
  account_id INTEGER REFERENCES accounts(id),
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  member_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  day_of_month INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  last_month TEXT
);

CREATE TABLE IF NOT EXISTS rates (
  currency TEXT PRIMARY KEY,
  uah REAL NOT NULL,
  source TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS audit_created ON audit(created_at);
`;

db.exec(SCHEMA);

/* ───── v2: шаблони, ставки команди, рахунки-фактури, Monobank ───── */
db.exec(`
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  emoji TEXT DEFAULT '⚡',
  type TEXT NOT NULL CHECK (type IN ('income','expense')),
  amount INTEGER NOT NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  member_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  comment TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS project_members (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'pct' CHECK (kind IN ('pct','fixed')),
  value REAL NOT NULL DEFAULT 0,
  currency TEXT,
  role TEXT,
  UNIQUE(project_id, user_id)
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('invoice','act')),
  number TEXT NOT NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  description TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mono_seen (
  id TEXT PRIMARY KEY,
  account TEXT,
  tx_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts_sent (
  key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

function addColumn(table, col, ddl) {
  const cols = all(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumn('projects', 'work_type', 'work_type TEXT');
addColumn('projects', 'payment_method', 'payment_method TEXT');
addColumn('clients', 'tg_username', 'tg_username TEXT');
addColumn('accounts', 'mono_account', 'mono_account TEXT');
addColumn('users', 'default_pct', 'default_pct REAL');
addColumn('clients', 'legal_name', 'legal_name TEXT');
addColumn('clients', 'legal_code', 'legal_code TEXT');
addColumn('clients', 'address', 'address TEXT');


export function getSetting(key, def = null) {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : def;
}
export function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

function seed() {
  if (getSetting('seeded')) return;
  tx(() => {
    setSetting('base_currency', 'USD');
    setSetting('member_sees_all', '0');
    setSetting('member_needs_approval', '1');
    setSetting('notify_new_tx', '1');
    setSetting('daily_digest', '1');

    const accounts = [
      ['Monobank ФОП', 'bank', 'UAH', '🏦'],
      ['Картка Mono', 'card', 'UAH', '💳'],
      ['Готівка $', 'cash', 'USD', '💵'],
      ['USDT (TRC20)', 'crypto', 'USDT', '🪙'],
    ];
    accounts.forEach((a, i) => run('INSERT INTO accounts(name, type, currency, emoji, sort) VALUES(?,?,?,?,?)', ...a, i));

    const income = [
      ['Розробка сайтів', '💻', '#7B5CFF'],
      ['Telegram-боти / Mini Apps', '🤖', '#2AABEE'],
      ['Трафік / таргет', '📈', '#22C55E'],
      ['SEO', '🔍', '#14B8A6'],
      ['Дизайн / UI/UX', '🎨', '#D400FF'],
      ['Підтримка / супровід', '🛠', '#F59E0B'],
      ['Інші надходження', '💰', '#94A3B8'],
    ];
    const expense = [
      ['Виплати команді', '👥', '#7B5CFF'],
      ['Субпідрядники / фріланс', '🤝', '#A855F7'],
      ['Реклама (бюджети)', '📣', '#EF4444'],
      ['Сервіси та підписки', '🧩', '#3B82F6'],
      ['Хостинг / домени', '🌐', '#06B6D4'],
      ['Податки', '🧾', '#F97316'],
      ['Банк / комісії', '🏦', '#64748B'],
      ['% партнерам / реферали', '🤑', '#EAB308'],
      ['Офіс / техніка', '🖥', '#10B981'],
      ['Навчання', '📚', '#EC4899'],
      ['Інші витрати', '📦', '#94A3B8'],
    ];
    income.forEach((c, i) => run('INSERT INTO categories(kind, name, emoji, color, sort) VALUES(?,?,?,?,?)', 'income', ...c, i));
    expense.forEach((c, i) => run('INSERT INTO categories(kind, name, emoji, color, sort) VALUES(?,?,?,?,?)', 'expense', ...c, i));

    const rates = [['UAH', 1], ['USD', 41.5], ['EUR', 48], ['USDT', 41.5], ['PLN', 11.3], ['GBP', 55]];
    for (const [c, r] of rates) run('INSERT OR IGNORE INTO rates(currency, uah, source) VALUES(?,?,?)', c, r, 'default');

    setSetting('company_name', config.companyName);
    setSetting('seeded', '1');
  });
}
seed();

for (const id of config.adminIds) {
  const row = get('SELECT id, role, status FROM users WHERE tg_id = ?', id);
  if (!row) {
    run("INSERT INTO users(tg_id, name, role, status) VALUES(?, 'Ангеліна', 'admin', 'active')", id);
  } else if (row.role !== 'admin' || row.status !== 'active') {
    run("UPDATE users SET role='admin', status='active' WHERE tg_id=?", id);
  }
}
