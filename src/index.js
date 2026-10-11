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

if (bot && config.useWebhook) {
  app.post('/tg/webhook', (req, res) => {
    if (config.webhookSecret && req.get('x-telegram-bot-api-secret-token') !== config.webhookSecret) {
      return res.sendStatus(401);
    }
    bot.handleUpdate(req.body).finally(() => res.sendStatus(200));
  });
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(ROOT, 'public'), { maxAge: config.devMode ? 0 : '1h', etag: true }));
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
