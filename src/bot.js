import https from 'node:https';
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { config } from './config.js';

const TG_IP = '149.154.167.220';
function telegramFetch(url, opts = {}) {
  const u = new URL(url, 'https://api.telegram.org');
  if (u.hostname !== 'api.telegram.org') return fetch(url, opts);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: TG_IP,
        servername: 'api.telegram.org',
        path: `${u.pathname}${u.search}`,
        method: opts.method || 'GET',
        headers: { host: 'api.telegram.org', ...(opts.headers || {}) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('telegram timeout')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
import { all, get, getSetting, run } from './db.js';
import { upsertTelegramUser } from './auth.js';
import {
  ROLES, balances, can, createTx, dashboard, monthOf, setTxStatus, team, today, upcoming,
} from './services/finance.js';
import { baseCurrency, fmt } from './services/money.js';

export const bot = config.botToken
  ? new Bot(config.botToken, config.forceTelegramIp ? { client: { fetch: telegramFetch } } : {})
  : null;
const pending = new Map();

export const webAppKb = () => {
  const kb = new Keyboard();
  if (config.webAppUrl) kb.webApp('🦍 Бухгалтерія KK', config.webAppUrl);
  kb.text('➕ Дохід').text('➖ Витрата').row().text('💼 Баланс').text('📊 Місяць').row().text('📅 План').text('👥 Команда');
  return kb.resized().persistent();
};

export const appBtn = () => (config.webAppUrl ? InlineKeyboard.from([[{ text: '🦍 Відкрити Mini App', web_app: { url: config.webAppUrl } }]]) : undefined);

export function userFromCtx(ctx) {
  if (!ctx.from) return null;
  return upsertTelegramUser(ctx.from);
}

function needActive(ctx, user) {
  if (!user) return false;
  if (user.status === 'blocked') {
    ctx.reply('Доступ заблоковано адміністратором.');
    return false;
  }
  if (user.status !== 'active') {
    ctx.reply('Заявку надіслано адміну. Після підтвердження зʼявиться повний доступ.', { reply_markup: appBtn() });
    return false;
  }
  return true;
}

function moneyLine(n, cur = baseCurrency()) {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${fmt(Math.abs(n), cur)}`;
}

if (bot) {
  bot.use(async (ctx, next) => {
    ctx.kk = userFromCtx(ctx);
    await next();
  });

  bot.command('start', async (ctx) => {
    const u = ctx.kk;
    if (!u) return;
    if (u.status === 'pending') {
      return ctx.reply(
        `Привіт, ${u.name}!\n\nЗаявку на доступ до бухгалтерії <b>${config.companyName}</b> надіслано адміну. Напишемо, щойно підтвердять.`,
        { parse_mode: 'HTML', reply_markup: appBtn() },
      );
    }
    if (!needActive(ctx, u)) return;
    await ctx.reply('Оновлюю кнопку застосунку…', { reply_markup: { remove_keyboard: true } }).catch(() => {});
    await ctx.reply(
      `🦍 <b>${config.companyName}</b> · бухгалтерія\n\n` +
        `Привіт, ${u.name}. Роль: <b>${ROLES[u.role] || u.role}</b>.\n\n` +
        `Тисни <b>🦍 Бухгалтерія KK</b> внизу — застосунок на сервері.\n` +
        `Або пиши суму в чат, наприклад <code>+1200 сайт клієнта</code> / <code>-450 хостинг</code>.`,
      { parse_mode: 'HTML', reply_markup: webAppKb() },
    );
  });

  bot.command('app', async (ctx) => {
    if (!needActive(ctx, ctx.kk)) return;
    if (!config.webAppUrl) return ctx.reply('WEBAPP_URL ще не налаштовано в .env');
    await ctx.reply('Відкрий бухгалтерію:', { reply_markup: appBtn() });
  });

  bot.command('balance', async (ctx) => {
    if (!needActive(ctx, ctx.kk) || !can.seeAll(ctx.kk)) return ctx.reply(can.seeAll(ctx.kk) ? '' : 'Немає доступу до загальних балансів.');
    const b = balances();
    const lines = b.accounts.map((a) => `${a.emoji} <b>${a.name}</b> · ${fmt(a.balance, a.currency)}`);
    await ctx.reply(`💼 <b>Рахунки</b>\n\n${lines.join('\n')}\n\nРазом ≈ <b>${fmt(b.total, b.base)}</b>`, { parse_mode: 'HTML' });
  });

  bot.command('report', async (ctx) => {
    if (!needActive(ctx, ctx.kk)) return;
    const d = dashboard(ctx.kk);
    if (d.limited) {
      return ctx.reply(
        `👤 ${ctx.kk.name}\nВиплати цього місяця: <b>${fmt(d.payouts, d.base)}</b>\nЗа рік: <b>${fmt(d.yearPayouts, d.base)}</b>\nНа перевірці: ${d.pending}`,
        { parse_mode: 'HTML' },
      );
    }
    await ctx.reply(monthCard(d), { parse_mode: 'HTML', reply_markup: appBtn() });
  });

  bot.command('pending', async (ctx) => {
    if (!needActive(ctx, ctx.kk) || !can.approve(ctx.kk)) return;
    const rows = all("SELECT t.id, t.date, t.type, t.amount, t.currency, t.comment, u.name AS who FROM transactions t LEFT JOIN users u ON u.id=t.created_by WHERE t.status='pending' AND t.deleted_at IS NULL ORDER BY t.id DESC LIMIT 15");
    if (!rows.length) return ctx.reply('Немає операцій на перевірці.');
    for (const t of rows) {
      const kb = new InlineKeyboard().text('✅ Провести', `ok:${t.id}`).text('❌ Відхилити', `no:${t.id}`);
      await ctx.reply(
        `⏳ #${t.id} · ${t.date}\n${t.type === 'income' ? '➕' : '➖'} ${fmt(t.amount, t.currency)}\n${t.comment || '—'}\nвід ${t.who || '—'}`,
        { reply_markup: kb },
      );
    }
  });

  bot.callbackQuery(/^ok:(\d+)$/, async (ctx) => {
    if (!can.approve(ctx.kk)) return ctx.answerCallbackQuery({ text: 'Немає прав' });
    setTxStatus(Number(ctx.match[1]), 'done', ctx.kk);
    await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ Проведено');
    await ctx.answerCallbackQuery({ text: 'Проведено' });
  });
  bot.callbackQuery(/^no:(\d+)$/, async (ctx) => {
    if (!can.approve(ctx.kk)) return ctx.answerCallbackQuery({ text: 'Немає прав' });
    setTxStatus(Number(ctx.match[1]), 'rejected', ctx.kk);
    await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ Відхилено');
    await ctx.answerCallbackQuery({ text: 'Відхилено' });
  });
  bot.callbackQuery(/^user:(active|blocked):(\d+)$/, async (ctx) => {
    if (!can.manageUsers(ctx.kk)) return ctx.answerCallbackQuery({ text: 'Немає прав' });
    const id = Number(ctx.match[2]);
    const { run } = await import('./db.js');
    run('UPDATE users SET status=? WHERE id=?', ctx.match[1], id);
    const u = get('SELECT * FROM users WHERE id=?', id);
    await ctx.editMessageText(`${u.name} · ${ctx.match[1] === 'active' ? 'доступ надано' : 'заблоковано'}`);
    if (u.tg_id && ctx.match[1] === 'active') {
      await bot.api.sendMessage(u.tg_id, `✅ Доступ до бухгалтерії ${config.companyName} підтверджено.`, { reply_markup: webAppKb() }).catch(() => {});
    }
    await ctx.answerCallbackQuery();
  });

  const textMap = {
    '💼 Баланс': 'balance',
    '📊 Місяць': 'report',
    '📅 План': 'plan',
    '👥 Команда': 'team',
    '➕ Дохід': 'income',
    '➖ Витрата': 'expense',
  };

  bot.on('message:text', async (ctx, next) => {
    const t = ctx.message.text;
    if (t.startsWith('/')) return next();
    const u = ctx.kk;
    if (!needActive(ctx, u)) return;

    if (textMap[t] === 'balance') {
      if (!can.seeAll(u)) return ctx.reply('Немає доступу до загальних балансів.');
      const b = balances();
      return ctx.reply(`💼 <b>Рахунки</b>\n\n${b.accounts.map((a) => `${a.emoji} <b>${a.name}</b> · ${fmt(a.balance, a.currency)}`).join('\n')}\n\nРазом ≈ <b>${fmt(b.total, b.base)}</b>`, { parse_mode: 'HTML' });
    }
    if (textMap[t] === 'report') {
      return ctx.reply(monthCard(dashboard(u)), { parse_mode: 'HTML', reply_markup: appBtn() });
    }
    if (textMap[t] === 'plan') {
      const rows = upcoming(21);
      if (!rows.length) return ctx.reply('Немає запланованих платежів на 3 тижні.');
      return ctx.reply(rows.map((x) => `${x.overdue ? '⚠️' : '📅'} ${x.date} · ${x.type === 'income' ? '+' : '−'}${fmt(x.amount, x.currency)} · ${x.comment || x.category_name || '—'}`).join('\n'), { parse_mode: 'HTML' });
    }
    if (textMap[t] === 'team') {
      if (!can.seeAll(u)) return ctx.reply('Немає доступу.');
      const m = monthOf(today());
      const [from, to] = [`${m}-01`, today()];
      const rows = team(from, to);
      return ctx.reply(`👥 <b>Виплати ${m}</b>\n\n` + rows.filter((x) => x.paid_base).map((x) => `• ${x.name} — ${fmt(x.paid_base, baseCurrency())}`).join('\n'), { parse_mode: 'HTML' });
    }
    if (textMap[t] === 'income' || textMap[t] === 'expense') {
      pending.set(u.id, { type: textMap[t] });
      return ctx.reply(`Напиши суму${textMap[t] === 'income' ? ' доходу' : ' витрати'} і коментар.\nНаприклад: <code>1200 сайт клієнта</code>`, { parse_mode: 'HTML' });
    }

    const draft = pending.get(u.id);
    const parsed = parseQuick(t, draft?.type);
    if (parsed) {
      try {
        const acc = defaultAccount(parsed.currencyHint);
        const tx = createTx({
          type: parsed.type,
          amount: parsed.amount,
          account_id: acc?.id,
          comment: parsed.comment,
          date: today(),
        }, u);
        pending.delete(u.id);
        const extra = tx.status === 'pending' ? '\n⏳ На перевірці в адміна.' : '';
        return ctx.reply(`${tx.type === 'income' ? '➕' : '➖'} ${fmt(tx.amount, tx.currency)} · ${tx.comment || 'без коментаря'}${extra}`, { reply_markup: appBtn() });
      } catch (e) {
        return ctx.reply(e.message || 'Не вдалося зберегти. Відкрий Mini App.');
      }
    }
    return next();
  });

  bot.on('message:document', async (ctx) => {
    const u = ctx.kk;
    if (!needActive(ctx, u)) return;
    if (!can.manageSettings(u)) return ctx.reply('Імпорт таблиці лише для адміна.');
    const doc = ctx.message.document;
    const name = doc.file_name || '';
    if (!/\.(xlsx|xls|csv)$/i.test(name)) return ctx.reply('Надішли Excel (.xlsx) або CSV зі старої таблиці.');
    await ctx.reply('Імпортую таблицю…');
    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
      const res = await (config.forceTelegramIp
        ? telegramFetch(url)
        : fetch(url));
      const buf = Buffer.from(await res.arrayBuffer());
      const { importBuffer } = await import('./services/importSheet.js');
      const result = await importBuffer(buf, name, u);
      await ctx.reply(`Готово: імпортовано <b>${result.imported}</b>, пропущено ${result.skipped}.`, { parse_mode: 'HTML', reply_markup: appBtn() });
    } catch (e) {
      await ctx.reply(e.message || 'Не вдалося імпортувати файл.');
    }
  });

  bot.on('message:photo', async (ctx) => {
    const u = ctx.kk;
    if (!needActive(ctx, u)) return;
    const fileId = ctx.message.photo.at(-1).file_id;
    const last = get(
      'SELECT id FROM transactions WHERE created_by = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
      u.id,
    );
    if (!last) return ctx.reply('Спочатку додай операцію (сумою або в Mini App), потім надішли фото чека.');
    run('UPDATE transactions SET receipt_file_id = ? WHERE id = ?', fileId, last.id);
    await ctx.reply(`🖼 Чек прикріплено до операції #${last.id}`);
  });

  bot.catch((err) => console.error('bot error', err.error || err));
}

function monthCard(d) {
  if (d.limited) {
    return `👤 Твій місяць\nВиплати: <b>${fmt(d.payouts, d.base)}</b>\nЗа рік: <b>${fmt(d.yearPayouts, d.base)}</b>`;
  }
  const c = d.current;
  return (
    `📊 <b>${d.month}</b> · ${d.base}\n\n` +
    `Доходи   ${moneyLine(c.income, d.base)}\n` +
    `Витрати  ${moneyLine(-c.expense, d.base)}\n` +
    `Прибуток <b>${moneyLine(c.profit, d.base)}</b>\n\n` +
    `На рахунках ≈ ${fmt(d.balances.total, d.base)}\n` +
    (d.pendingCount ? `⏳ На перевірці: ${d.pendingCount}\n` : '') +
    (d.receivable ? `📌 Борг клієнтів ≈ ${fmt(d.receivable, d.base)}` : '')
  );
}

function parseQuick(text, forcedType) {
  const m = text.match(/^\s*([+\-])?\s*(\d+(?:[.,]\d{1,2})?)\s*(uah|грн|usd|\$|eur|€|usdt|₮)?\s*(.*)$/i);
  if (!m) return null;
  const type = forcedType || (m[1] === '-' ? 'expense' : m[1] === '+' ? 'income' : null);
  if (!type) return null;
  const amount = Math.round(Number(m[2].replace(',', '.')) * 100);
  if (!(amount > 0)) return null;
  const hint = { uah: 'UAH', грн: 'UAH', usd: 'USD', $: 'USD', eur: 'EUR', '€': 'EUR', usdt: 'USDT', '₮': 'USDT' }[(m[3] || '').toLowerCase()];
  return { type, amount, currencyHint: hint, comment: (m[4] || '').trim() };
}

function defaultAccount(currency) {
  if (currency) {
    const a = get('SELECT * FROM accounts WHERE archived=0 AND currency=? ORDER BY sort LIMIT 1', currency);
    if (a) return a;
  }
  return get('SELECT * FROM accounts WHERE archived=0 ORDER BY sort LIMIT 1');
}

export async function notifyAdmins(html, extra = {}) {
  if (!bot) return;
  const admins = all("SELECT tg_id FROM users WHERE role='admin' AND status='active' AND notify=1 AND tg_id IS NOT NULL");
  for (const a of admins) {
    await bot.api.sendMessage(a.tg_id, html, { parse_mode: 'HTML', disable_notification: extra.silent, ...extra }).catch(() => {});
  }
}

export async function notifyUser(tgId, html, extra = {}) {
  if (!bot || !tgId) return;
  await bot.api.sendMessage(tgId, html, { parse_mode: 'HTML', ...extra }).catch(() => {});
}

export async function startBot() {
  if (!bot) {
    console.log('BOT_TOKEN не задано — працює лише Mini App (dev).');
    return;
  }
  const setup = async () => {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Відкрити бухгалтерію' },
      { command: 'app', description: 'Mini App' },
      { command: 'balance', description: 'Баланси рахунків' },
      { command: 'report', description: 'Звіт за місяць' },
      { command: 'pending', description: 'Операції на перевірці' },
    ]);
    if (config.webAppUrl) {
      await bot.api.setChatMenuButton({
        menu_button: { type: 'web_app', text: 'Бухгалтерія', web_app: { url: config.webAppUrl } },
      });
    }
  };
  if (config.useWebhook && config.webAppUrl) {
    await bot.api.setWebhook(`${config.webAppUrl}/tg/webhook`, { secret_token: config.webhookSecret || undefined });
    console.log('Webhook set', config.webAppUrl);
  } else {
    const poll = async () => {
      for (;;) {
        try {
          await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
          await bot.start({
            drop_pending_updates: false,
            onStart: (i) => console.log(`Bot @${i.username} online`),
          });
          return;
        } catch (e) {
          const conflict = e?.error_code === 409 || /409|setWebhook/i.test(String(e?.message || e));
          console.warn(conflict ? 'Webhook conflict, retry polling…' : e?.message || e);
          await new Promise((r) => setTimeout(r, conflict ? 2500 : 8000));
        }
      }
    };
    poll();
  }
  setup().catch((e) => console.error('bot setup', e.message || e));
}

export function scheduleJobs() {
  const tick = async () => {
    const now = new Date();
    const kyivH = Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', hour12: false }).format(now));
    const kyivM = Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, minute: '2-digit' }).format(now));
    const stamp = `${now.toISOString().slice(0, 10)}-${kyivH}`;
    if (kyivH === 9 && kyivM < 5 && getSetting('last_digest') !== stamp && getSetting('daily_digest') === '1') {
      const { runRecurring } = await import('./services/finance.js');
      const created = runRecurring();
      const d = dashboard({ role: 'admin', id: 0 });
      if (!d.limited) {
        await notifyAdmins('🗓 <b>Ранковий дайджест</b>\n\n' + monthCard(d) + (created.length ? `\n\n🔁 Створено регулярних: ${created.length}` : ''), { silent: true });
      }
      const { setSetting } = await import('./db.js');
      setSetting('last_digest', stamp);
    }
  };
  setInterval(tick, 60_000);
}
