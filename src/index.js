import express from 'express';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { api, apiErrorHandler } from './api.js';
import { onNewUser } from './auth.js';
import { bot, notifyAdmins, scheduleJobs, startBot } from './bot.js';
import { ROLES } from './services/finance.js';
import { InlineKeyboard } from 'grammy';

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (req.path === '/api/import') return express.raw({ type: '*/*', limit: '25mb' })(req, res, next);
  return express.json({ limit: '2mb' })(req, res, next);
});
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// Google-таблиця ↔ бот (Apps Script). Авторизація — заголовок X-Sync-Token.
const syncRoute = (fn) => async (req, res) => {
  try {
    const { checkSyncToken } = await import('./services/sheetSync.js');
    checkSyncToken(req.get('x-sync-token'));
    res.json(await fn(req));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Внутрішня помилка' });
    if (!e.status) console.error('sync', e);
  }
};
app.get('/sync/export', syncRoute(async () => (await import('./services/sheetSync.js')).exportAll()));
app.post('/sync/row', syncRoute(async (req) => {
  const { upsertRow } = await import('./services/sheetSync.js');
  const b = req.body || {};
  return { row: upsertRow(b.sheet, b.columns || [], b.values || []) };
}));
app.post('/sync/remove', syncRoute(async (req) => {
  const { removeRow } = await import('./services/sheetSync.js');
  return { ok: removeRow(req.body?.sheet, req.body?.id) };
}));

app.use('/api', api);
app.use(apiErrorHandler);

if (bot) {
  app.post('/tg/webhook', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (body.update_id) await bot.handleUpdate(body);
    } catch (e) {
      console.error('webhook update', e);
    }
    if (!res.headersSent) res.sendStatus(200);
  });
}

// Monobank: GET — перевірка адреси при встановленні вебхука, POST — нова операція
app.get('/mono/webhook/:secret', (_req, res) => res.sendStatus(200));
app.post('/mono/webhook/:secret', async (req, res) => {
  res.sendStatus(200);
  try {
    const { getSetting } = await import('./db.js');
    if (req.params.secret !== getSetting('mono_webhook_secret')) return;
    const b = req.body || {};
    if (b.type !== 'StatementItem' || !b.data?.statementItem) return;
    const { importMonoItem } = await import('./services/integrations.js');
    const t = importMonoItem(b.data.account, b.data.statementItem);
    if (t) {
      const { fmt } = await import('./services/money.js');
      notifyAdmins(`🏦 Monobank: ${t.type === 'income' ? '➕' : '➖'} ${fmt(t.amount, t.currency)} · ${String(t.comment || '').replace(/[<>&]/g, '')}${t.category_name ? `\n🏷 ${t.category_name}` : '\n🏷 без категорії — признач у Mini App'}`, { silent: true }).catch(() => {});
    }
  } catch (e) {
    console.warn('mono webhook', e.message || e);
  }
});

app.get('/health', (_req, res) => res.json({
  ok: true,
  webAppUrl: config.webAppUrl || null,
  webhook: config.useWebhook,
}));
app.use(express.static(path.join(ROOT, 'public'), {
  maxAge: 0,
  etag: false,
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-store');
  },
}));
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

onNewUser(async (user) => {
  const kb = new InlineKeyboard()
    .text('✅ Дозволити', `user:active:${user.id}`)
    .text('🚫 Відхилити', `user:blocked:${user.id}`);
  await notifyAdmins(
    `👤 Нова заявка на доступ\n<b>${user.name}</b>${user.username ? ` @${user.username}` : ''}\nроль за замовчуванням: ${ROLES[user.role]}`,
    { reply_markup: kb },
  );
});

// Знімок таблиці «KING KONG LAB ПРОЄКТИ» → угоди. Виконується один раз для кожної версії файлу.
try {
  const fs = await import('node:fs');
  const crypto = await import('node:crypto');
  const file = path.join(ROOT, 'data', 'kk-deals-2026.json');
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    const hash = crypto.createHash('sha1').update(raw).digest('hex');
    const { getSetting, setSetting } = await import('./db.js');
    if (getSetting('deals_snapshot') !== hash) {
      const { importSnapshot } = await import('./services/deals.js');
      const r = importSnapshot(JSON.parse(raw));
      setSetting('deals_snapshot', hash);
      console.log('Deals snapshot imported', r);
    }
  }
} catch (e) {
  console.error('deals snapshot import failed', e);
}

app.listen(config.port, config.host, () => {
  console.log(`KK-Buh http://${config.host}:${config.port}${config.devMode ? ' (dev)' : ''}${config.webAppUrl ? ` → ${config.webAppUrl}` : ''}`);
  startBot().catch((e) => console.error('bot start failed', e));
  scheduleJobs();
});
