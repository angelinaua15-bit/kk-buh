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

app.listen(config.port, config.host, () => {
  console.log(`KK-Buh http://${config.host}:${config.port}${config.devMode ? ' (dev)' : ''}${config.webAppUrl ? ` → ${config.webAppUrl}` : ''}`);
  startBot().catch((e) => console.error('bot start failed', e));
  scheduleJobs();
});
