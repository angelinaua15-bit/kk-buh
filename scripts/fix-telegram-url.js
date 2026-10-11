import { bot, webAppKb, appBtn } from '../src/bot.js';
import { config } from '../src/config.js';
import { appUrl } from '../src/auth.js';

const admin = config.adminIds[0];
if (!bot || !admin) {
  console.error('bot or ADMIN_IDS missing');
  process.exit(1);
}

const url = appUrl(admin);
console.log('WEBAPP_URL', config.webAppUrl);
console.log('SESSION_URL', url);

const me = await bot.api.getMe();
console.log('bot', me.username);

await bot.api.setChatMenuButton({
  menu_button: { type: 'web_app', text: 'Бухгалтерія', web_app: { url: config.webAppUrl } },
});
await bot.api.setChatMenuButton({
  chat_id: admin,
  menu_button: { type: 'web_app', text: 'Бухгалтерія', web_app: { url } },
});
if (config.onRailway || process.env.SET_WEBHOOK === '1') {
  await bot.api.setWebhook(`${config.webAppUrl}/tg/webhook`, { secret_token: config.webhookSecret || undefined });
}
try {
  await bot.api.sendMessage(
    admin,
    '🦍 Бухгалтерія готова.\n\nТисни <b>🦍 Бухгалтерія KK</b> внизу — застосунок відкриється.',
    { parse_mode: 'HTML', reply_markup: webAppKb({ tg_id: admin }) },
  );
  await bot.api.sendMessage(admin, 'Або відкрий тут:', { reply_markup: appBtn({ tg_id: admin }) });
} catch (e) {
  console.warn('sendMessage', e.message || e);
}
const menu = await bot.api.getChatMenuButton({ chat_id: admin });
console.log('menu', menu);
const hook = await bot.api.getWebhookInfo();
console.log('webhook', hook.url);
process.exit(0);
