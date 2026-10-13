import { Router } from 'express';
import { all, get, getSetting, run, setSetting } from './db.js';
import { authMiddleware, sessionToken } from './auth.js';
import { config } from './config.js';
import { buildWorkbook } from './services/export.js';
import {
  HttpError, ROLES, audit, balances, byCategory, can, clients, createTx, dashboard, deleteTx,
  getTx, listTx, monthBounds, monthOf, monthlySeries, pnl, projects, recalcBase, restoreTx,
  runRecurring, setTxStatus, team, today, upcoming, updateTx,
} from './services/finance.js';
import { baseCurrency, currencies, fmt, fromMinor, refreshRatesFromNBU, setRate } from './services/money.js';
import { importBuffer } from './services/importSheet.js';

const api = Router();
const guard = (check, msg = 'Недостатньо прав') => (req, res, next) => (check(req.user) ? next() : res.status(403).json({ error: msg }));
const needId = (req) => {
  const id = Number(req.params.id);
  if (!id) throw new HttpError(400, 'Невірний id');
  return id;
};

api.get('/launch', (_req, res) => {
  const bot = getSetting('bot_username') || 'KKLabSystemBot';
  res.json({
    company: getSetting('company_name') || config.companyName,
    bot,
    telegram: bot ? `https://t.me/${bot}?startapp` : '',
    webAppUrl: config.webAppUrl,
  });
});

api.use(authMiddleware);

api.get('/me', (req, res) => {
  res.json({
    user: req.user,
    roles: ROLES,
    can: Object.fromEntries(Object.entries(can).map(([k, fn]) => [k, fn(req.user)])),
    session: req.user.tg_id ? sessionToken(req.user.tg_id) : null,
    settings: {
      company: getSetting('company_name') || 'King Kong Lab',
      base_currency: baseCurrency(),
      member_sees_all: getSetting('member_sees_all') === '1',
      member_needs_approval: getSetting('member_needs_approval') === '1',
    },
  });
});

api.get('/bootstrap', (req, res) => {
  res.json({
    accounts: all('SELECT * FROM accounts ORDER BY archived, sort, id'),
    categories: all('SELECT * FROM categories ORDER BY kind, archived, sort, id'),
    clients: all('SELECT * FROM clients WHERE archived = 0 ORDER BY name'),
    projects: all("SELECT id, name, client_id, status, budget, currency FROM projects WHERE status != 'cancelled' ORDER BY status='active' DESC, name"),
    members: all("SELECT id, name, role, position FROM users WHERE status = 'active' ORDER BY name"),
    rates: currencies(),
    base: baseCurrency(),
    today: today(),
  });
});

api.get('/dashboard', (req, res) => res.json(dashboard(req.user, req.query.month || monthOf(today()))));

api.get('/transactions', (req, res) => res.json(listTx(req.query, req.user)));
api.get('/transactions/:id', (req, res) => {
  const t = getTx(needId(req));
  if (!t) return res.status(404).json({ error: 'Не знайдено' });
  res.json(t);
});
api.post('/transactions', async (req, res) => {
  const t = createTx(req.body, req.user);
  if (t.status === 'pending') {
    const { notifyAdmins } = await import('./bot.js');
    const { fmt } = await import('./services/money.js');
    notifyAdmins(
      `⏳ Нова операція на перевірку\n${t.type === 'income' ? '➕' : '➖'} ${fmt(t.amount, t.currency)}\n${t.comment || '—'}\nвід ${req.user.name}`,
    ).catch(() => {});
  }
  res.status(201).json(t);
});
api.patch('/transactions/:id', (req, res) => res.json(updateTx(needId(req), req.body, req.user)));
api.delete('/transactions/:id', (req, res) => {
  deleteTx(needId(req), req.user);
  res.json({ ok: true });
});
api.post('/transactions/:id/status', guard(can.approve), (req, res) => res.json(setTxStatus(needId(req), req.body.status, req.user)));
api.post('/transactions/:id/restore', guard(can.writeAnyTx), (req, res) => res.json(restoreTx(needId(req), req.user)));

api.get('/reports/balances', (req, res) => res.json(balances({ includeArchived: req.query.all === '1' })));
api.get('/reports/categories', (req, res) => {
  const [from, to] = req.query.from && req.query.to ? [req.query.from, req.query.to] : monthBounds(req.query.month || monthOf(today()));
  res.json({
    from,
    to,
    income: byCategory(from, to, 'income'),
    expense: byCategory(from, to, 'expense'),
    series: monthlySeries(12, from.slice(0, 7)),
  });
});
api.get('/reports/pnl', (req, res) => res.json(pnl(Number(req.query.year) || Number(today().slice(0, 4)))));
api.get('/reports/upcoming', (req, res) => res.json(upcoming(Number(req.query.days) || 45)));

api.get('/projects', (req, res) => res.json(projects(req.query)));
api.get('/projects/:id', (req, res) => {
  const p = projects().find((x) => x.id === needId(req));
  if (!p) return res.status(404).json({ error: 'Не знайдено' });
  const txs = listTx({ project_id: p.id, limit: 200 }, req.user).rows;
  res.json({ ...p, transactions: txs });
});
const needName = (b, field = 'name') => {
  if (!String(b?.[field] || '').trim()) throw new HttpError(400, 'Вкажіть назву');
};

api.post('/projects', guard(can.writeRefs), (req, res) => {
  const b = req.body;
  needName(b);
  const r = run(
    'INSERT INTO projects(name, client_id, status, budget, currency, manager_id, start_date, deadline, notes) VALUES(?,?,?,?,?,?,?,?,?)',
    b.name, b.client_id || null, b.status || 'active', Math.round(Number(b.budget) || 0), b.currency || 'USD',
    b.manager_id || null, b.start_date || null, b.deadline || null, b.notes || null,
  );
  const id = Number(r.lastInsertRowid);
  audit(req.user.id, 'create', 'project', id, b);
  res.status(201).json(get('SELECT * FROM projects WHERE id=?', id));
});
api.patch('/projects/:id', guard(can.writeRefs), (req, res) => {
  const id = needId(req);
  const cur = get('SELECT * FROM projects WHERE id=?', id);
  if (!cur) return res.status(404).json({ error: 'Не знайдено' });
  const b = { ...cur, ...req.body };
  run(
    'UPDATE projects SET name=?, client_id=?, status=?, budget=?, currency=?, manager_id=?, start_date=?, deadline=?, notes=? WHERE id=?',
    b.name, b.client_id || null, b.status, Math.round(Number(b.budget) || 0), b.currency,
    b.manager_id || null, b.start_date || null, b.deadline || null, b.notes || null, id,
  );
  audit(req.user.id, 'update', 'project', id, b);
  res.json(get('SELECT * FROM projects WHERE id=?', id));
});

api.get('/clients', (req, res) => res.json(clients()));
api.post('/clients', guard(can.writeRefs), (req, res) => {
  const b = req.body;
  needName(b);
  const r = run('INSERT INTO clients(name, contact, phone, email, notes) VALUES(?,?,?,?,?)', b.name, b.contact || null, b.phone || null, b.email || null, b.notes || null);
  res.status(201).json(get('SELECT * FROM clients WHERE id=?', r.lastInsertRowid));
});
api.patch('/clients/:id', guard(can.writeRefs), (req, res) => {
  const id = needId(req);
  const cur = get('SELECT * FROM clients WHERE id=?', id);
  if (!cur) return res.status(404).json({ error: 'Не знайдено' });
  const b = { ...cur, ...req.body };
  run('UPDATE clients SET name=?, contact=?, phone=?, email=?, notes=?, archived=? WHERE id=?', b.name, b.contact, b.phone, b.email, b.notes, Number(!!b.archived), id);
  res.json(get('SELECT * FROM clients WHERE id=?', id));
});

api.get('/team', (req, res) => {
  const [from, to] = req.query.from && req.query.to ? [req.query.from, req.query.to] : monthBounds(req.query.month || monthOf(today()));
  res.json({ from, to, members: team(from, to) });
});

api.get('/users', guard(can.manageUsers), (req, res) => res.json(all("SELECT * FROM users ORDER BY status='pending' DESC, status, name")));
api.patch('/users/:id', guard(can.manageUsers), (req, res) => {
  const id = needId(req);
  const u = get('SELECT * FROM users WHERE id=?', id);
  if (!u) return res.status(404).json({ error: 'Не знайдено' });
  const { role, status, name, position, notify } = req.body;
  run(
    'UPDATE users SET role=COALESCE(?,role), status=COALESCE(?,status), name=COALESCE(?,name), position=COALESCE(?,position), notify=COALESCE(?,notify) WHERE id=?',
    role ?? null, status ?? null, name ?? null, position ?? null, notify === undefined ? null : Number(!!notify), id,
  );
  audit(req.user.id, 'update', 'user', id, req.body);
  res.json(get('SELECT * FROM users WHERE id=?', id));
});

api.get('/accounts', (req, res) => res.json(all('SELECT * FROM accounts ORDER BY archived, sort, id')));
api.post('/accounts', guard(can.writeRefs), (req, res) => {
  const b = req.body;
  needName(b);
  const r = run('INSERT INTO accounts(name, type, currency, emoji, initial_balance, sort) VALUES(?,?,?,?,?,?)',
    b.name, b.type || 'card', b.currency || 'UAH', b.emoji || '💳', Math.round(Number(b.initial_balance) || 0), Number(b.sort) || 0);
  res.status(201).json(get('SELECT * FROM accounts WHERE id=?', r.lastInsertRowid));
});
api.patch('/accounts/:id', guard(can.writeRefs), (req, res) => {
  const id = needId(req);
  const cur = get('SELECT * FROM accounts WHERE id=?', id);
  if (!cur) return res.status(404).json({ error: 'Не знайдено' });
  const b = { ...cur, ...req.body };
  run('UPDATE accounts SET name=?, type=?, currency=?, emoji=?, initial_balance=?, archived=?, sort=? WHERE id=?',
    b.name, b.type, b.currency, b.emoji, Math.round(Number(b.initial_balance) || 0), Number(!!b.archived), Number(b.sort) || 0, id);
  res.json(get('SELECT * FROM accounts WHERE id=?', id));
});

api.get('/categories', (req, res) => res.json(all('SELECT * FROM categories ORDER BY kind, archived, sort, id')));
api.post('/categories', guard(can.writeRefs), (req, res) => {
  const b = req.body;
  needName(b);
  const r = run('INSERT INTO categories(kind, name, emoji, color, monthly_limit, sort) VALUES(?,?,?,?,?,?)',
    b.kind, b.name, b.emoji || '•', b.color || '#7B5CFF', b.monthly_limit ? Math.round(Number(b.monthly_limit)) : null, Number(b.sort) || 0);
  res.status(201).json(get('SELECT * FROM categories WHERE id=?', r.lastInsertRowid));
});
api.patch('/categories/:id', guard(can.writeRefs), (req, res) => {
  const id = needId(req);
  const cur = get('SELECT * FROM categories WHERE id=?', id);
  if (!cur) return res.status(404).json({ error: 'Не знайдено' });
  const b = { ...cur, ...req.body };
  run('UPDATE categories SET kind=?, name=?, emoji=?, color=?, monthly_limit=?, archived=?, sort=? WHERE id=?',
    b.kind, b.name, b.emoji, b.color, b.monthly_limit ? Math.round(Number(b.monthly_limit)) : null, Number(!!b.archived), Number(b.sort) || 0, id);
  res.json(get('SELECT * FROM categories WHERE id=?', id));
});

api.get('/recurring', (req, res) => res.json(all(
  `SELECT r.*, a.name AS account_name, c.name AS category_name FROM recurring r
   LEFT JOIN accounts a ON a.id=r.account_id LEFT JOIN categories c ON c.id=r.category_id ORDER BY r.active DESC, r.day_of_month`,
)));
api.post('/recurring', guard(can.writeRefs), (req, res) => {
  const b = req.body;
  needName(b, 'title');
  if (!(Number(b.amount) > 0)) throw new HttpError(400, 'Сума має бути більше 0');
  if (!b.account_id) throw new HttpError(400, 'Оберіть рахунок');
  const r = run('INSERT INTO recurring(title, type, amount, account_id, category_id, project_id, client_id, member_id, day_of_month, active) VALUES(?,?,?,?,?,?,?,?,?,?)',
    b.title, b.type, Math.round(Number(b.amount)), b.account_id, b.category_id || null, b.project_id || null, b.client_id || null, b.member_id || null, Number(b.day_of_month) || 1, b.active === 0 ? 0 : 1);
  res.status(201).json(get('SELECT * FROM recurring WHERE id=?', r.lastInsertRowid));
});
api.patch('/recurring/:id', guard(can.writeRefs), (req, res) => {
  const id = needId(req);
  const cur = get('SELECT * FROM recurring WHERE id=?', id);
  if (!cur) return res.status(404).json({ error: 'Не знайдено' });
  const b = { ...cur, ...req.body };
  run('UPDATE recurring SET title=?, type=?, amount=?, account_id=?, category_id=?, project_id=?, client_id=?, member_id=?, day_of_month=?, active=? WHERE id=?',
    b.title, b.type, Math.round(Number(b.amount)), b.account_id, b.category_id || null, b.project_id || null, b.client_id || null, b.member_id || null, Number(b.day_of_month) || 1, Number(!!b.active), id);
  res.json(get('SELECT * FROM recurring WHERE id=?', id));
});
api.post('/recurring/run', guard(can.writeRefs), (req, res) => res.json({ created: runRecurring() }));

api.get('/rates', (req, res) => res.json({ base: baseCurrency(), rates: currencies() }));
api.post('/rates', guard(can.manageSettings), (req, res) => {
  setRate(req.body.currency, req.body.uah, 'manual');
  res.json({ rates: currencies() });
});
api.post('/rates/refresh', guard(can.manageSettings), async (req, res) => {
  const n = await refreshRatesFromNBU();
  res.json({ updated: n, rates: currencies() });
});
api.post('/rates/recalc', guard(can.manageSettings), (req, res) => res.json({ n: recalcBase(req.user.id) }));

api.get('/settings', guard(can.manageSettings), (req, res) => {
  res.json({
    company_name: getSetting('company_name') || 'King Kong Lab',
    base_currency: baseCurrency(),
    member_sees_all: getSetting('member_sees_all') === '1',
    member_needs_approval: getSetting('member_needs_approval') === '1',
    notify_new_tx: getSetting('notify_new_tx') === '1',
    daily_digest: getSetting('daily_digest') === '1',
  });
});
api.post('/settings', guard(can.manageSettings), (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) {
    if (['company_name', 'base_currency', 'member_sees_all', 'member_needs_approval', 'notify_new_tx', 'daily_digest'].includes(k)) {
      setSetting(k, typeof v === 'boolean' ? (v ? '1' : '0') : v);
    }
  }
  if (req.body.base_currency) recalcBase(req.user.id);
  res.json({ ok: true });
});

api.get('/audit', guard(can.manageUsers), (req, res) => {
  res.json(all(
    `SELECT a.*, u.name AS user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200`,
  ));
});

api.post('/import', guard(can.manageSettings), async (req, res, next) => {
  try {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    if (!buf.length) return res.status(400).json({ error: 'Файл порожній' });
    const filename = req.get('x-filename') || 'import.xlsx';
    const result = await importBuffer(buf, filename, req.user);
    audit(req.user.id, 'import', 'transactions', null, result);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

api.get('/export.xlsx', async (req, res) => {
  const from = req.query.from || `${today().slice(0, 4)}-01-01`;
  const to = req.query.to || today();
  const buf = await buildWorkbook({ from, to, user: req.user });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="KKLab_${from}_${to}.xlsx"`);
  res.send(Buffer.from(buf));
});

api.post('/export/send', async (req, res) => {
  const from = req.body?.from || `${today().slice(0, 4)}-01-01`;
  const to = req.body?.to || today();
  if (!req.user.tg_id) throw new HttpError(400, 'Немає Telegram-чату для надсилання');
  const buf = await buildWorkbook({ from, to, user: req.user });
  const { sendFile } = await import('./bot.js');
  await sendFile(req.user.tg_id, Buffer.from(buf), `KKLab_${from}_${to}.xlsx`, `📊 Звіт ${from} — ${to}`);
  res.json({ ok: true });
});

api.get('/search', (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  if (q.length < 3) return res.json({ transactions: [], projects: [], clients: [] });
  res.json({
    transactions: listTx({ q: req.query.q, limit: 15 }, req.user).rows,
    projects: all('SELECT id, name, status FROM projects WHERE name LIKE ? LIMIT 8', q),
    clients: all('SELECT id, name FROM clients WHERE name LIKE ? LIMIT 8', q),
  });
});

export { api, fmt, fromMinor };
export const apiErrorHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Внутрішня помилка' });
};
