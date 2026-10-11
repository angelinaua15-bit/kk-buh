import { bot, webAppKb, appBtn } from '../src/bot.js';
import { config } from '../src/config.js';

const admin = config.adminIds[0];
if (!bot || !admin) {
  console.error('bot or ADMIN_IDS missing');
  process.exit(1);
}

const url = config.webAppUrl;
console.log('WEBAPP_URL', url);

await bot.api.setChatMenuButton({
  menu_button: { type: 'web_app', text: 'Бухгалтерія', web_app: { url } },
});
await bot.api.setChatMenuButton({
  chat_id: admin,
  menu_button: { type: 'web_app', text: 'Бухгалтерія', web_app: { url } },
});
await bot.api.setWebhook(`${url}/tg/webhook`, { secret_token: config.webhookSecret || undefined });
await bot.api.sendMessage(admin, 'Прибираю стару кнопку з тунелем…', { reply_markup: { remove_keyboard: true } });
await bot.api.sendMessage(
  admin,
  '🦍 Бухгалтерія на сервері.\n\nЗакрий чорне «no tunnel». Нова кнопка внизу: <b>🦍 Бухгалтерія KK</b>.',
  { parse_mode: 'HTML', reply_markup: webAppKb() },
);
await bot.api.sendMessage(admin, 'Або відкрий тут:', { reply_markup: appBtn() });
const menu = await bot.api.getChatMenuButton();
console.log('menu', menu);
const hook = await bot.api.getWebhookInfo();
console.log('webhook', hook.url);
process.exit(0);
