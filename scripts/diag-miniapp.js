import { bot } from '../src/bot.js';
import { config } from '../src/config.js';
import { appUrl } from '../src/auth.js';

const admin = config.adminIds[0];
const me = await bot.api.getMe();
const hook = await bot.api.getWebhookInfo();
const menu = await bot.api.getChatMenuButton({ chat_id: admin }).catch((e) => e.description || e.message);
const defMenu = await bot.api.getChatMenuButton().catch((e) => e.description || e.message);
console.log(JSON.stringify({
  me: me.username,
  webAppUrl: config.webAppUrl,
  sampleAppUrl: appUrl(admin),
  hook: { url: hook.url, pending: hook.pending_update_count, lastError: hook.last_error_message },
  menu,
  defMenu,
}, null, 2));
process.exit(0);
