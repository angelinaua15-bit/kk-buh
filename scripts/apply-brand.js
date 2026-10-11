import path from 'node:path';
import { InputFile } from 'grammy';
import { bot } from '../src/bot.js';
import { config } from '../src/config.js';
import { ROOT } from '../src/config.js';

const NAME = 'KK Lab · Бухгалтерія';
const SHORT = 'Бухгалтерія King Kong Lab: каса, проєкти, P&L і доступ команди в Mini App.';
const DESCRIPTION = [
  'King Kong Lab — бухгалтерія команди.',
  '',
  'Каса, доходи й витрати, проєкти, P&L, доступи. Усе в Mini App замість спільної таблиці.',
  '',
  'Натисни «Бухгалтерія KK» або /start.',
  '',
  'Сайт: https://angelinaua15-bit.github.io/kingkonglab-site/',
].join('\n');

if (!bot) {
  console.error('BOT_TOKEN missing');
  process.exit(1);
}

await bot.api.setMyName({ name: NAME });
await bot.api.setMyShortDescription({ short_description: SHORT });
await bot.api.setMyDescription({ description: DESCRIPTION });
console.log('name + descriptions set');

const avatar = path.join(ROOT, 'public/brand/avatar.png');
const banner = path.join(ROOT, 'public/brand/banner.png');
const admin = config.adminIds[0];

if (admin) {
  await bot.api.sendPhoto(admin, new InputFile(avatar), {
    caption: 'Аватар бота (640×640). Якщо не став сам — @BotFather → /setuserpic',
  });
  await bot.api.sendPhoto(admin, new InputFile(banner), {
    caption: 'Банер бота (1280×720). @BotFather → About / description picture, або обкладинка.',
  });
  console.log('sent assets to admin');
}

const me = await bot.api.getMe();
const desc = await bot.api.getMyDescription();
const short = await bot.api.getMyShortDescription();
console.log({ username: me.username, name: me.first_name, desc: desc.description, short: short.short_description });
process.exit(0);
