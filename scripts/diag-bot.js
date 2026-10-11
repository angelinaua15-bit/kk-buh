import { bot } from '../src/bot.js';
import { config } from '../src/config.js';

const info = await bot.api.getWebhookInfo();
const me = await bot.api.getMe();
console.log(JSON.stringify({
  me: { username: me.username, id: me.id },
  webAppUrl: config.webAppUrl,
  webhook: {
    url: info.url,
    pending: info.pending_update_count,
    lastError: info.last_error_message,
    lastErrorDate: info.last_error_date,
    lastSync: info.last_synchronization_error_date,
    ip: info.ip_address,
    maxConnections: info.max_connections,
    hasSecret: Boolean(info.has_custom_certificate),
  },
}, null, 2));

try {
  await bot.api.sendMessage(config.adminIds[0], '🔧 Перевірка: бот живий. Напиши /start ще раз, якщо не було відповіді.');
  console.log('sendMessage: ok');
} catch (e) {
  console.log('sendMessage:', e.description || e.message);
}
process.exit(0);
