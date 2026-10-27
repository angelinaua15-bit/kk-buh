import { Router } from 'express';
import { all, get, getSetting, run, setSetting } from './db.js';
import { INVITE_ROLES, authMiddleware, inviteLink, inviteRole, openAccess, openRole, resetInviteCode, sessionToken } from './auth.js';
import { config } from './config.js';
import { buildWorkbook } from './services/export.js';
import {
  HttpError, ROLES, audit, balances, byCategory, can, clients, createTx, dashboard, deleteTx,
  getTx, listTx, monthBounds, monthOf, monthlySeries, pnl, projects, recalcBase, restoreTx,
  runRecurring, setTxStatus, team, today, upcoming, updateTx,
} from './services/finance.js';
import { baseCurrency, currencies, fmt, fromMinor, refreshRatesFromNBU, setRate } from './services/money.js';
import { importBuffer } from './services/importSheet.js';
import {
  checkLimit, compare, debts, forecast, listTemplates, memberCabinet, payouts, planPayouts, planTaxes,
  profitability, projectMembers, reminderText, saveTaxSettings, saveTemplate, setProjectMember, taxes, useTemplate,
} from './services/extras.js';
import { createDocument, listDocuments, renderDocument, requisites, saveRequisites } from './services/documents.js';
import { linkMonoAccount, makeBackup, monoAccounts, monoEnabled, setMonoWebhook, syncMono } from './services/integrations.js';
import { aiEnabled } from './services/ai.js';
import {
  COVERS, PAGE_TEMPLATES, assignable, projectLabels, taskInviteLink, PRIORITIES, STATUSES, addComment, createPage, deleteComment, duplicatePage, getPage, listPages,
  purgePage, restorePage, tagList, trashPage, updatePage,
} from './services/tasks.js';
import { METHODS, SECTIONS, dealBalances, deleteDeal, getDeal, importSnapshot, listDeals, monthlySummary, saveDeal } from './services/deals.js';

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

const seeAll = guard(can.seeAll, 'Цей розділ бачить лише адмін або фінансист');

/** Попередження про ліміти категорій — адмінам у Telegram. */
function afterTx(t) {
  try {
    const alert = checkLimit(t);
    if (alert) import('./bot.js').then(({ notifyAdmins }) => notifyAdmins(alert.text)).catch(() => {});
  } catch (e) {
    console.warn('limit check', e.message || e);
  }
}
async function sendToChat(user, buffer, filename, caption) {
  if (!user.tg_id) throw new HttpError(400, 'Немає Telegram-чату для надсилання');
  const { sendFile } = await import('./bot.js');
  try {
    await sendFile(user.tg_id, buffer, filename, caption);
  } catch (e) {
    throw new HttpError(400, `Не вдалося надіслати в Telegram: ${e.message || e}`);
  }
}

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
    features: { ai: aiEnabled(), mono: monoEnabled(), sheet: Boolean(config.syncToken) },
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
  afterTx(t);
  if (t.status === 'pending') {
    const { notifyAdmins } = await import('./bot.js');
    const { fmt } = await import('./services/money.js');
    notifyAdmins(
      `⏳ Нова операція на перевірку\n${t.type === 'income' ? '➕' : '➖'} ${fmt(t.amount, t.currency)}\n${t.comment || '—'}\nвід ${req.user.name}`,
    ).catch(() => {});
  }
  res.status(201).json(t);
});
api.patch('/transactions/:id', (req, res) => {
  const t = updateTx(needId(req), req.body, req.user);
  afterTx(t);
  res.json(t);
});
api.delete('/transactions/:id', (req, res) => {
  deleteTx(needId(req), req.user);
  res.json({ ok: true });
});
api.post('/transactions/:id/status', guard(can.approve), (req, res) => res.json(setTxStatus(needId(req), req.body.status, req.user)));
api.post('/transactions/:id/restore', guard(can.writeAnyTx), (req, res) => res.json(restoreTx(needId(req), req.user)));

api.get('/reports/balances', seeAll, (req, res) => res.json(balances({ includeArchived: req.query.all === '1' })));
api.get('/reports/categories', seeAll, (req, res) => {
  const [from, to] = req.query.from && req.query.to ? [req.query.from, req.query.to] : monthBounds(req.query.month || monthOf(today()));
  res.json({
    from,
    to,
    income: byCategory(from, to, 'income'),
    expense: byCategory(from, to, 'expense'),
    series: monthlySeries(12, from.slice(0, 7)),
  });
});
api.get('/reports/pnl', seeAll, (req, res) => res.json(pnl(Number(req.query.year) || Number(today().slice(0, 4)))));
api.get('/reports/upcoming', seeAll, (req, res) => res.json(upcoming(Number(req.query.days) || 45)));

const MONEY_FIELDS = ['budget', 'budget_base', 'income_base', 'expense_base', 'planned_base', 'profit_base', 'debt_base', 'paid_pct', 'margin_pct'];
function visibleProjects(user, query = {}) {
  const rows = projects(query);
  if (can.seeAll(user)) return rows;
  const mine = new Set([
    ...all('SELECT project_id FROM project_members WHERE user_id=?', user.id).map((r) => r.project_id),
    ...all('SELECT DISTINCT project_id FROM transactions WHERE (member_id=? OR created_by=?) AND project_id IS NOT NULL', user.id, user.id).map((r) => r.project_id),
  ]);
  return rows.filter((p) => mine.has(p.id)).map((p) => {
    const o = { ...p, limited: true };
    for (const k of MONEY_FIELDS) delete o[k];
    return o;
  });
}
api.get('/projects', (req, res) => res.json(visibleProjects(req.user, req.query)));
api.get('/projects/:id', (req, res) => {
  const p = visibleProjects(req.user).find((x) => x.id === needId(req));
  if (!p) return res.status(404).json({ error: 'Не знайдено' });
  const txs = listTx({ project_id: p.id, limit: 200 }, req.user).rows;
  res.json({ ...p, transactions: txs, members: projectMembers(p.id), documents: can.seeAll(req.user) ? listDocuments(p.id) : [] });
});
api.get('/projects/:id/members', seeAll, (req, res) => res.json(projectMembers(needId(req))));
api.post('/projects/:id/members', guard(can.writeRefs), (req, res) => {
  const id = needId(req);
  const list = setProjectMember(id, req.body || {});
  audit(req.user.id, 'members', 'project', id, req.body);
  res.json(list);
});
const needName = (b, field = 'name') => {
  if (!String(b?.[field] || '').trim()) throw new HttpError(400, 'Вкажіть назву');
};

api.post('/projects', guard(can.writeRefs), (req, res) => {
  const b = req.body;
  needName(b);
  const r = run(
    'INSERT INTO projects(name, client_id, status, budget, currency, manager_id, start_date, deadline, notes, work_type, payment_method) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    String(b.name).trim(), b.client_id || null, b.status || 'active', Math.round(Number(b.budget) || 0), b.currency || 'USD',
    b.manager_id || null, b.start_date || null, b.deadline || null, b.notes || null, b.work_type || null, b.payment_method || null,
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
    'UPDATE projects SET name=?, client_id=?, status=?, budget=?, currency=?, manager_id=?, start_date=?, deadline=?, notes=?, work_type=?, payment_method=? WHERE id=?',
    b.name, b.client_id || null, b.status, Math.round(Number(b.budget) || 0), b.currency,
    b.manager_id || null, b.start_date || null, b.deadline || null, b.notes || null, b.work_type || null, b.payment_method || null, id,
  );
  audit(req.user.id, 'update', 'project', id, b);
  res.json(get('SELECT * FROM projects WHERE id=?', id));
});

api.get('/clients', seeAll, (req, res) => res.json(clients()));
api.post('/clients', guard(can.writeRefs), (req, res) => {
  const b = req.body;
  needName(b);
  const r = run('INSERT INTO clients(name, contact, phone, email, notes, tg_username, legal_name, legal_code, address) VALUES(?,?,?,?,?,?,?,?,?)',
    String(b.name).trim(), b.contact || null, b.phone || null, b.email || null, b.notes || null, b.tg_username || null, b.legal_name || null, b.legal_code || null, b.address || null);
  res.status(201).json(get('SELECT * FROM clients WHERE id=?', r.lastInsertRowid));
});
api.patch('/clients/:id', guard(can.writeRefs), (req, res) => {
  const id = needId(req);
  const cur = get('SELECT * FROM clients WHERE id=?', id);
  if (!cur) return res.status(404).json({ error: 'Не знайдено' });
  const b = { ...cur, ...req.body };
  run('UPDATE clients SET name=?, contact=?, phone=?, email=?, notes=?, archived=?, tg_username=?, legal_name=?, legal_code=?, address=? WHERE id=?',
    b.name, b.contact, b.phone, b.email, b.notes, Number(!!b.archived), b.tg_username || null, b.legal_name || null, b.legal_code || null, b.address || null, id);
  res.json(get('SELECT * FROM clients WHERE id=?', id));
});

api.get('/team', seeAll, (req, res) => {
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
    summary_by: getSetting('summary_by', 'end'),
  });
});
api.post('/settings', guard(can.manageSettings), (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) {
    if (['company_name', 'base_currency', 'member_sees_all', 'member_needs_approval', 'notify_new_tx', 'daily_digest', 'summary_by'].includes(k)) {
      setSetting(k, typeof v === 'boolean' ? (v ? '1' : '0') : v);
    }
  }
  if (req.body.base_currency) recalcBase(req.user.id);
  res.json({ ok: true });
});

// запрошення за посиланням і відкритий доступ
const inviteState = () => ({ link: inviteLink(), role: inviteRole(), open_access: openAccess(), open_role: openRole() });
api.get('/invite', guard(can.manageUsers), (req, res) => res.json(inviteState()));
api.post('/invite', guard(can.manageUsers), (req, res) => {
  const b = req.body || {};
  if (b.reset) resetInviteCode();
  if (INVITE_ROLES.includes(b.role)) setSetting('invite_role', b.role);
  if (INVITE_ROLES.includes(b.open_role)) setSetting('open_role', b.open_role);
  if (typeof b.open_access === 'boolean') setSetting('open_access', b.open_access ? '1' : '0');
  audit(req.user.id, 'invite_settings', 'settings', null, b);
  res.json(inviteState());
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
  const buf = await buildWorkbook({ from, to, user: req.user });
  await sendToChat(req.user, Buffer.from(buf), `KKLab_${from}_${to}.xlsx`, `📊 Звіт ${from} — ${to}`);
  res.json({ ok: true });
});

/* ───── Угоди (як у таблиці «KING KONG LAB ПРОЄКТИ») ───── */
const MONEY_DEAL = ['price', 'prepay', 'prog_prepay', 'margin', 'calc'];
function visibleDeal(user, d) {
  if (can.seeAll(user)) return d;
  if (d.executor_id !== user.id) return null;
  const o = { ...d, limited: true };
  for (const k of MONEY_DEAL) delete o[k];
  o.my = { total: d.calc.executor_total, paid: d.prog_prepay, left: d.calc.executor_left, currency: d.calc.currency };
  return o;
}
api.get('/deals/meta', (req, res) => res.json({
  sections: SECTIONS,
  methods: METHODS,
  executors: all("SELECT DISTINCT u.id, u.name FROM users u JOIN projects p ON p.executor_id = u.id ORDER BY u.name"),
  types: all("SELECT work_type AS name, COUNT(*) AS n FROM projects WHERE work_type IS NOT NULL AND work_type != '' GROUP BY lower(work_type) ORDER BY n DESC LIMIT 20").map((r) => r.name),
  summary_by: getSetting('summary_by', 'end'),
}));
api.get('/deals/summary', seeAll, (req, res) => res.json(monthlySummary(Number(req.query.year) || Number(today().slice(0, 4)), req.query.by === 'start' || req.query.by === 'end' ? req.query.by : undefined)));
api.get('/deals/balances', seeAll, (req, res) => res.json(dealBalances()));
api.get('/deals', (req, res) => res.json(listDeals({ section: req.query.section || '', status: req.query.status || '', q: req.query.q || '' }).map((d) => visibleDeal(req.user, d)).filter(Boolean)));
api.get('/deals/:id', (req, res) => {
  const d = getDeal(needId(req));
  const v = d && visibleDeal(req.user, d);
  if (!v) return res.status(404).json({ error: 'Не знайдено' });
  res.json(v);
});
api.post('/deals', guard(can.writeRefs), (req, res) => {
  const d = saveDeal(req.body || {}, req.user);
  audit(req.user.id, 'create', 'deal', d.id, req.body);
  res.status(201).json(d);
});
api.patch('/deals/:id', guard(can.writeRefs), (req, res) => {
  const id = needId(req);
  const cur = getDeal(id);
  if (!cur) return res.status(404).json({ error: 'Не знайдено' });
  const money = (v, c) => (v === null || v === undefined ? '' : { amount: v, currency: c });
  const base = {
    section: cur.section, executor: cur.executor, client: cur.client, type: cur.type, task: cur.task, start: cur.start_date, end: cur.end_date,
    method: cur.method, price: money(cur.price, cur.currency), prepay: money(cur.prepay, cur.prepay_currency), prog: money(cur.prog_prepay, cur.prog_currency),
    margin: cur.margin === null ? '' : money(cur.margin, cur.margin_currency), extra: cur.extra, closed: cur.closed,
    executor_paid: cur.executor_paid,
  };
  const d = saveDeal({ ...base, ...req.body }, req.user, { id });
  audit(req.user.id, 'update', 'deal', id, req.body);
  res.json(d);
});
api.delete('/deals/:id', guard(can.writeRefs), (req, res) => {
  deleteDeal(needId(req));
  audit(req.user.id, 'delete', 'deal', Number(req.params.id));
  res.json({ ok: true });
});
api.post('/deals/import-snapshot', guard(can.manageSettings), async (req, res) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { ROOT } = await import('./config.js');
  const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'kk-deals-2026.json'), 'utf8'));
  res.json(importSnapshot(snap, req.user));
});

/* ───── Шаблони ───── */
api.get('/templates', (req, res) => res.json(listTemplates()));
api.post('/templates', guard(can.writeRefs), (req, res) => res.status(201).json(saveTemplate(req.body || {})));
api.patch('/templates/:id', guard(can.writeRefs), (req, res) => {
  const id = needId(req);
  const cur = get('SELECT * FROM templates WHERE id=?', id);
  if (!cur) return res.status(404).json({ error: 'Не знайдено' });
  res.json(saveTemplate({ ...cur, ...req.body }, id));
});
api.post('/templates/:id/use', (req, res) => {
  const t = useTemplate(needId(req), req.user, req.body || {});
  afterTx(t);
  res.status(201).json(t);
});

/* ───── Борги, прогноз, податки ───── */
api.get('/debts', seeAll, (req, res) => res.json(debts().map((d) => ({ ...d, reminder: reminderText(d) }))));
api.get('/forecast', seeAll, (req, res) => res.json(forecast(Math.min(Math.max(Number(req.query.weeks) || 4, 1), 12))));
api.get('/taxes', seeAll, (req, res) => res.json(taxes()));
api.post('/taxes/settings', guard(can.manageSettings), (req, res) => res.json(saveTaxSettings(req.body || {})));
api.post('/taxes/plan', guard(can.writeRefs), (req, res) => res.json({ created: planTaxes(req.user, req.body?.account_id).length }));

/* ───── Команда ───── */
api.get('/payouts', seeAll, (req, res) => res.json(payouts()));
api.post('/payouts/plan', guard(can.writeRefs), (req, res) => {
  const ids = Array.isArray(req.body?.user_ids) ? req.body.user_ids.map(Number) : null;
  res.json({ created: planPayouts(req.user, req.body?.account_id, ids).length });
});
api.get('/cabinet', (req, res) => res.json(memberCabinet(req.user)));
api.get('/profitability', seeAll, (req, res) => {
  const [from, to] = req.query.from && req.query.to ? [req.query.from, req.query.to] : [`${today().slice(0, 4)}-01-01`, today()];
  res.json(profitability(from, to));
});
api.get('/compare', seeAll, (req, res) => res.json(compare(/^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : monthOf(today()))));

/* ───── Документи ───── */
api.get('/requisites', guard(can.writeRefs), (req, res) => res.json(requisites()));
api.post('/requisites', guard(can.manageSettings), (req, res) => res.json(saveRequisites(req.body || {})));
api.get('/documents', seeAll, (req, res) => res.json(listDocuments(Number(req.query.project_id) || null)));
api.post('/documents', guard(can.writeRefs), async (req, res) => {
  const { doc, buffer } = await createDocument(req.body || {}, req.user);
  audit(req.user.id, 'create', 'document', doc.id, doc);
  let sent = false;
  if (req.body?.send !== false && req.user.tg_id) {
    try { await sendToChat(req.user, buffer, `${doc.number}.pdf`, `${doc.kind === 'invoice' ? '🧾 Рахунок' : '📄 Акт'} ${doc.number}`); sent = true; } catch (e) { console.warn('doc send', e.message); }
  }
  res.status(201).json({ ...doc, sent });
});
api.get('/documents/:id.pdf', seeAll, async (req, res) => {
  const doc = get('SELECT * FROM documents WHERE id=?', needId(req));
  if (!doc) return res.status(404).json({ error: 'Не знайдено' });
  const buf = await renderDocument(doc);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.number)}.pdf"`);
  res.send(buf);
});
api.post('/documents/:id/send', seeAll, async (req, res) => {
  const doc = get('SELECT * FROM documents WHERE id=?', needId(req));
  if (!doc) return res.status(404).json({ error: 'Не знайдено' });
  await sendToChat(req.user, await renderDocument(doc), `${doc.number}.pdf`, doc.number);
  res.json({ ok: true });
});

/* ───── Monobank, бекап ───── */
api.get('/mono', guard(can.manageSettings), async (req, res) => {
  if (!monoEnabled()) return res.json({ enabled: false });
  res.json({ enabled: true, ...(await monoAccounts()), last_sync: getSetting('mono_last_sync'), webhook: getSetting('mono_webhook_url') });
});
api.post('/mono/link', guard(can.manageSettings), (req, res) => {
  const b = req.body || {};
  if (!b.mono_id) throw new HttpError(400, 'Оберіть рахунок Monobank');
  res.json({ account_id: linkMonoAccount(String(b.mono_id), b.account_id, b) });
});
api.post('/mono/sync', guard(can.manageSettings), (req, res) => {
  const days = Math.min(Number(req.body?.days) || 3, 30);
  syncMono(days).then(async (r) => {
    const { notifyUser } = await import('./bot.js');
    notifyUser(req.user.tg_id, `🏦 Monobank: додано операцій — <b>${r.created.length}</b>${r.errors.length ? `\n⚠️ ${r.errors.join('; ')}` : ''}`);
  }).catch((e) => console.warn('mono sync', e.message));
  res.json({ started: true });
});
api.post('/mono/webhook', guard(can.manageSettings), async (req, res) => {
  if (!config.webAppUrl) throw new HttpError(400, 'Немає публічної адреси (WEBAPP_URL)');
  res.json({ url: await setMonoWebhook(config.webAppUrl) });
});
api.post('/backup', guard(can.manageSettings), async (req, res) => {
  const { buffer, filename } = makeBackup();
  await sendToChat(req.user, buffer, filename, '💾 Резервна копія бази');
  res.json({ ok: true, size: buffer.length });
});

api.get('/search', (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  if (q.length < 3) return res.json({ transactions: [], projects: [], clients: [], pages: [] });
  res.json({
    transactions: listTx({ q: req.query.q, limit: 15 }, req.user).rows,
    projects: all('SELECT id, name, status FROM projects WHERE name LIKE ? LIMIT 8', q),
    clients: all('SELECT id, name FROM clients WHERE name LIKE ? LIMIT 8', q),
    pages: listPages({ q: req.query.q, limit: 10 }),
  });
});

/* ───────── Задачі та сторінки (як у Notion) ───────── */
const writePages = guard((u) => u.role !== 'viewer', 'У режимі перегляду не можна змінювати задачі');
function pageQuery(req) {
  const q = { ...req.query };
  if (q.assignee === 'me') q.assignee_id = req.user.id;
  else if (q.assignee === 'none') q.unassigned = true;
  else if (q.assignee) q.assignee_id = Number(q.assignee);
  q.open = q.open === '1';
  q.trash = q.trash === '1';
  if (q.parent === 'root') q.parent_id = null;
  else if (q.parent) q.parent_id = Number(q.parent);
  return q;
}
/** Якщо відповідальний ще не користується ботом — посилання, яке йому треба переслати. */
function withReach(page, actor) {
  if (!page.assignee_id || page.assignee_id === actor.id) return page;
  const u = get('SELECT id, name, tg_id, status, notify FROM users WHERE id = ?', page.assignee_id);
  if (u && !(u.tg_id && u.notify && u.status !== 'contact')) page.assignee_invite = taskInviteLink(page.id, u.id);
  return page;
}
/** Сповіщення в Telegram: призначили задачу / новий коментар. Не блокує відповідь. */
function notifyPage(kind, page, actor, extra = {}) {
  import('./bot.js').then(({ notifyTask }) => notifyTask?.(kind, page, actor, extra)).catch((e) => console.warn('notify page', e.message || e));
}

api.get('/pages/meta', (req, res) => res.json({
  statuses: STATUSES, priorities: PRIORITIES, covers: COVERS, tags: tagList(), templates: Object.keys(PAGE_TEMPLATES),
  members: assignable(),
  projects: all("SELECT id, name, status, section FROM projects WHERE status != 'cancelled' ORDER BY closed, id DESC LIMIT 300"),
  project_labels: projectLabels(),
}));
api.get('/pages', (req, res) => res.json(listPages(pageQuery(req))));
api.get('/pages/:id', (req, res) => res.json(getPage(needId(req))));
api.post('/pages', writePages, (req, res) => {
  const body = req.body || {};
  const tpl = PAGE_TEMPLATES[body.template] ? PAGE_TEMPLATES[body.template]() : {};
  const page = createPage({ ...tpl, ...Object.fromEntries(Object.entries(body).filter(([k, v]) => k !== 'template' && v !== undefined && !(k === 'title' && !v && tpl.title))) }, req.user);
  if (page.assignee_id && page.assignee_id !== req.user.id) notifyPage('assigned', page, req.user);
  res.status(201).json(withReach(page, req.user));
});
api.patch('/pages/:id', writePages, (req, res) => {
  const { page, before } = updatePage(needId(req), req.body || {}, req.user);
  if (page.assignee_id && page.assignee_id !== before.assignee_id && page.assignee_id !== req.user.id) notifyPage('assigned', page, req.user);
  if (page.status !== before.status && page.status === 'done' && before.created_by && before.created_by !== req.user.id) notifyPage('done', page, req.user, { to: before.created_by });
  res.json(page.assignee_id !== before.assignee_id ? withReach(page, req.user) : page);
});
api.post('/pages/:id/duplicate', writePages, (req, res) => res.status(201).json(duplicatePage(needId(req), req.user)));
api.delete('/pages/:id', writePages, (req, res) => res.json(trashPage(needId(req), req.user)));
api.post('/pages/:id/restore', writePages, (req, res) => res.json(restorePage(needId(req), req.user)));
api.delete('/pages/:id/purge', writePages, (req, res) => res.json(purgePage(needId(req), req.user)));
api.post('/pages/:id/comments', writePages, (req, res) => {
  const c = addComment(needId(req), req.body?.text, req.user);
  notifyPage('comment', getPage(needId(req)), req.user, { text: c.text });
  res.status(201).json(c);
});
api.delete('/comments/:id', writePages, (req, res) => res.json(deleteComment(needId(req), req.user, req.user.role === 'admin')));

export { api, fmt, fromMinor };
export const apiErrorHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Внутрішня помилка' });
};
