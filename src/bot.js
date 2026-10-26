import https from 'node:https';
import { Bot, InlineKeyboard, InputFile, Keyboard } from 'grammy';
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
import { all, get, getSetting, run, setSetting } from './db.js';
import { INVITE_ROLES, appUrl, inviteLink, inviteRole, openAccess, resetInviteCode, upsertTelegramUser } from './auth.js';
import {
  ROLES, balances, can, createTx, dashboard, monthOf, setTxStatus, team, today, upcoming,
} from './services/finance.js';
import { baseCurrency, convert, fmt } from './services/money.js';
import { guessCategory, parseOperation } from './services/nlp.js';
import { aiEnabled, readReceipt, transcribe } from './services/ai.js';
import {
  checkLimit, compare, debts, forecast, listTemplates, memberCabinet, payouts, reminderText, taxes, useTemplate, weeklyReport,
} from './services/extras.js';
import { dailyRates, makeBackup, monoEnabled, syncMono } from './services/integrations.js';
import {
  addPerson, assignable, canBeAssignee, claimTaskLink, createPage, taskInviteLink, dueDigest, getPage, myOpenTasks, pageAppUrl, parseTaskText, priorityName, statusName, taskLine, updatePage,
} from './services/tasks.js';
import { METHODS, SECTIONS, calcDeal, dealBalances, getDeal, listDeals, monthlySummary, normalizeDeal, parseDate, parseMoney, saveDeal } from './services/deals.js';

export const bot = config.botToken
  ? new Bot(config.botToken, config.forceTelegramIp ? { client: { fetch: telegramFetch } } : {})
  : null;
const pending = new Map();

export const webAppKb = (user) => {
  const kb = new Keyboard();
  const url = appUrl(user?.tg_id);
  if (url) kb.webApp('🦍 Бухгалтерія KK', url).row();
  kb.text('➕ Дохід').text('➖ Витрата').row();
  if (user?.role !== 'viewer') kb.text('📝 Задача').text('✅ Мої задачі').row();
  if (user && can.seeAll(user)) {
    kb.text('➕ Новий проєкт').text('📋 Проєкти').row();
    kb.text('💼 Баланс').text('📊 Місяць').row().text('📌 Борги').text('📅 План').row().text('⚡ Шаблони').text('👥 Команда');
  } else {
    kb.text('👤 Мій кабінет').text('⚡ Шаблони');
  }
  return kb.resized().persistent();
};

export const appBtn = (user) => {
  const url = appUrl(user?.tg_id);
  return url ? InlineKeyboard.from([[{ text: '🦍 Відкрити Mini App', web_app: { url } }]]) : undefined;
};

export function userFromCtx(ctx) {
  if (!ctx.from) return null;
  const m = String(ctx.message?.text || '').match(/^\/start(?:@\w+)?\s+join_([a-f0-9]+)/i);
  return upsertTelegramUser(ctx.from, { invite: m?.[1] });
}

const ROLE_HINT = {
  admin: 'бачить і редагує все, керує доступами',
  finance: 'бачить усе, вносить і підтверджує операції',
  member: 'вносить свої операції, бачить свої проєкти',
  viewer: 'лише переглядає звіти',
};
function inviteText() {
  return `🔗 <b>Запрошення в бухгалтерію</b>\n\n${inviteLink()}\n\n`
    + `Хто відкриє це посилання, одразу отримає роль <b>${ROLES[inviteRole()]}</b> — ${ROLE_HINT[inviteRole()]}.\n`
    + `Надішли його людям, яким довіряєш. Якщо посилання потрапило не туди — натисни «🔄 Новий код», і старе перестане працювати.`
    + (openAccess() ? '\n\n⚠️ Зараз увімкнено <b>відкритий доступ</b>: будь-хто, хто напише боту, отримує доступ.' : '');
}
function inviteKb() {
  const kb = new InlineKeyboard();
  INVITE_ROLES.forEach((r, i) => { kb.text(`${inviteRole() === r ? '● ' : ''}${ROLES[r]}`, `inv:role:${r}`); if (i === 1) kb.row(); });
  return kb.row().text('🔄 Новий код', 'inv:reset');
}

function needActive(ctx, user) {
  if (!user) return false;
  if (user.status === 'blocked') {
    ctx.reply('Доступ заблоковано адміністратором.');
    return false;
  }
  if (user.status !== 'active') {
    ctx.reply('Заявку надіслано адміну. Після підтвердження зʼявиться повний доступ.', { reply_markup: appBtn(user) });
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
    try {
      ctx.kk = userFromCtx(ctx);
    } catch (e) {
      console.error('userFromCtx', e);
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    try {
      const u = ctx.kk;
      if (!u) {
        return ctx.reply('🦍 King Kong Lab · бухгалтерія\nНапиши /start ще раз.');
      }
      const tm = String(ctx.message?.text || '').match(/\stask_(\d+)(?:_([a-f0-9]+))?/);
      if (tm) {
        try {
          const claimed = tm[2] ? claimTaskLink(Number(tm[1]), tm[2], u) : null;
          const me = claimed || u;
          ctx.kk = me;
          const p = getPage(Number(tm[1]));
          if (p.assignee_id === me.id || me.status === 'active') {
            return ctx.reply(`📌 ${p.assignee_id === me.id ? 'Тобі призначено задачу' : 'Задача'} в ${esc(config.companyName)}\n\n${taskCard(p)}\n\nКоли задачу призначать ще раз — сповіщення прийде сюди.`, { parse_mode: 'HTML', reply_markup: taskKb(p, me) });
          }
        } catch {}
      }
      if (u.status === 'pending') {
        return ctx.reply(
          `Привіт, ${esc(u.name)}!\n\nЗаявку на доступ до бухгалтерії <b>${config.companyName}</b> надіслано адміну. Напишемо, щойно підтвердять.`,
          { parse_mode: 'HTML', reply_markup: appBtn(u) },
        );
      }
      if (!needActive(ctx, u)) return;
      if (config.webAppUrl) {
        await bot.api.setChatMenuButton({
          chat_id: ctx.chat.id,
          menu_button: { type: 'web_app', text: 'Бухгалтерія', web_app: { url: appUrl(u.tg_id) } },
        }).catch(() => {});
      }
      const joined = /\sjoin_/.test(ctx.message?.text || '');
      await ctx.reply(
        `🦍 <b>${config.companyName}</b> · бухгалтерія\n\n` +
          (joined ? `✅ Ти в команді! Доступ відкрито за запрошенням.\n\n` : '') +
          `Привіт, ${esc(u.name)}. Роль: <b>${ROLES[u.role] || u.role}</b>.\n\n` +
          `Тисни <b>🦍 Бухгалтерія KK</b> внизу або кнопку нижче.`,
        { parse_mode: 'HTML', reply_markup: webAppKb(u) },
      );
    } catch (e) {
      console.error('/start', e);
      await ctx.reply('🦍 Бухгалтерія KK. Тисни кнопку внизу або /app.', { reply_markup: webAppKb(ctx.kk || ctx.from) }).catch(() => {});
    }
  });

  bot.command(['invite', 'admins'], async (ctx) => {
    if (!needActive(ctx, ctx.kk)) return;
    if (!can.manageUsers(ctx.kk)) return ctx.reply('Запрошувати людей може лише адмін.');
    const team = all("SELECT name, username, role FROM users WHERE status='active' AND tg_id IS NOT NULL ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'finance' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, name");
    const list = team.map((u) => `• ${esc(u.name)}${u.username ? ` @${esc(u.username)}` : ''} — ${ROLES[u.role]}`).join('\n');
    await ctx.reply(`${inviteText()}\n\n👥 <b>Зараз мають доступ:</b>\n${list || '—'}`, { parse_mode: 'HTML', reply_markup: inviteKb(), link_preview_options: { is_disabled: true } });
  });
  bot.callbackQuery(/^inv:role:(\w+)$/, async (ctx) => {
    if (!can.manageUsers(ctx.kk)) return ctx.answerCallbackQuery({ text: 'Немає прав' });
    if (!INVITE_ROLES.includes(ctx.match[1])) return ctx.answerCallbackQuery();
    setSetting('invite_role', ctx.match[1]);
    await ctx.editMessageText(inviteText(), { parse_mode: 'HTML', reply_markup: inviteKb(), link_preview_options: { is_disabled: true } }).catch(() => {});
    await ctx.answerCallbackQuery({ text: `Роль за посиланням: ${ROLES[ctx.match[1]]}` });
  });
  bot.callbackQuery('inv:reset', async (ctx) => {
    if (!can.manageUsers(ctx.kk)) return ctx.answerCallbackQuery({ text: 'Немає прав' });
    resetInviteCode();
    await ctx.editMessageText(inviteText(), { parse_mode: 'HTML', reply_markup: inviteKb(), link_preview_options: { is_disabled: true } }).catch(() => {});
    await ctx.answerCallbackQuery({ text: 'Старе посилання більше не працює' });
  });

  bot.command('app', async (ctx) => {
    if (!needActive(ctx, ctx.kk)) return;
    if (!config.webAppUrl) return ctx.reply('WEBAPP_URL ще не налаштовано в .env');
    await ctx.reply('Відкрий бухгалтерію:', { reply_markup: appBtn(ctx.kk) });
  });

  bot.command('balance', async (ctx) => {
    if (!needActive(ctx, ctx.kk)) return;
    if (!can.seeAll(ctx.kk)) return ctx.reply('Немає доступу до загальних балансів.');
    const b = balances();
    const lines = b.accounts.map((a) => `${a.emoji} <b>${esc(a.name)}</b> · ${fmt(a.balance, a.currency)}`);
    await ctx.reply(`💼 <b>Рахунки</b>\n\n${lines.join('\n')}\n\nРазом ≈ <b>${fmt(b.total, b.base)}</b>`, { parse_mode: 'HTML' });
  });

  bot.command('report', async (ctx) => {
    if (!needActive(ctx, ctx.kk)) return;
    const d = dashboard(ctx.kk);
    if (d.limited) {
      return ctx.reply(
        `👤 ${esc(ctx.kk.name)}\nВиплати цього місяця: <b>${fmt(d.payouts, d.base)}</b>\nЗа рік: <b>${fmt(d.yearPayouts, d.base)}</b>\nНа перевірці: ${d.pending}`,
        { parse_mode: 'HTML' },
      );
    }
    await ctx.reply(monthCard(d), { parse_mode: 'HTML', reply_markup: appBtn(ctx.kk) });
  });

  bot.command('pending', async (ctx) => {
    if (!needActive(ctx, ctx.kk)) return;
    if (!can.approve(ctx.kk)) return ctx.reply('Перевіряти операції може адмін або фінансист.');
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
    try { setTxStatus(Number(ctx.match[1]), 'done', ctx.kk); } catch (e) { return ctx.answerCallbackQuery({ text: e.message }); }
    await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ Проведено').catch(() => {});
    await ctx.answerCallbackQuery({ text: 'Проведено' });
  });
  bot.callbackQuery(/^no:(\d+)$/, async (ctx) => {
    if (!can.approve(ctx.kk)) return ctx.answerCallbackQuery({ text: 'Немає прав' });
    try { setTxStatus(Number(ctx.match[1]), 'rejected', ctx.kk); } catch (e) { return ctx.answerCallbackQuery({ text: e.message }); }
    await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ Відхилено').catch(() => {});
    await ctx.answerCallbackQuery({ text: 'Відхилено' });
  });
  bot.callbackQuery(/^user:(active|blocked|admin):(\d+)$/, async (ctx) => {
    if (!can.manageUsers(ctx.kk)) return ctx.answerCallbackQuery({ text: 'Немає прав' });
    const id = Number(ctx.match[2]);
    const { run } = await import('./db.js');
    const asAdmin = ctx.match[1] === 'admin';
    if (asAdmin) run("UPDATE users SET status='active', role='admin' WHERE id=?", id);
    else run('UPDATE users SET status=? WHERE id=?', ctx.match[1], id);
    const u = get('SELECT * FROM users WHERE id=?', id);
    if (!u) return ctx.answerCallbackQuery({ text: 'Користувача не знайдено' });
    await ctx.editMessageText(`${u.name} · ${asAdmin ? 'тепер адмін 👑' : ctx.match[1] === 'active' ? 'доступ надано' : 'заблоковано'}`);
    if (u.tg_id && ctx.match[1] !== 'blocked') {
      await bot.api.sendMessage(u.tg_id, `✅ Доступ до бухгалтерії ${config.companyName} підтверджено.`, { reply_markup: webAppKb(u) }).catch(() => {});
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
    '⚡ Шаблони': 'templates',
    '📌 Борги': 'debts',
    '👤 Мій кабінет': 'cabinet',
    '➕ Новий проєкт': 'newdeal',
    '📋 Проєкти': 'deals',
    '📝 Задача': 'newtask',
    '✅ Мої задачі': 'mytasks',
  };

  bot.command(['task', 't'], (ctx) => {
    const u = ctx.kk;
    if (!needActive(ctx, u)) return;
    if (u.role === 'viewer') return ctx.reply('У режимі перегляду не можна створювати задачі.');
    const text = String(ctx.match || '').trim();
    if (!text) {
      pendingTask.set(u.id, true);
      return ctx.reply('📝 Яку задачу додати? Напиши одним повідомленням.\nНаприклад: <code>Правки на сайт Sensora @olena пт !</code>', { parse_mode: 'HTML' });
    }
    return quickTask(ctx, u, text);
  });
  bot.command(['tasks', 'mytasks'], (ctx) => needActive(ctx, ctx.kk) && sendMyTasks(ctx, ctx.kk));
  bot.callbackQuery(/^tk:as:(\d+)$/, async (ctx) => {
    const u = ctx.kk;
    if (!u || u.status !== 'active' || u.role === 'viewer') return ctx.answerCallbackQuery({ text: 'Немає доступу' });
    await ctx.answerCallbackQuery();
    return askAssignee(ctx, u, Number(ctx.match[1]));
  });
  bot.callbackQuery(/^tk:set:(\d+):(\d+)$/, async (ctx) => {
    const u = ctx.kk;
    if (!u || u.status !== 'active' || u.role === 'viewer') return ctx.answerCallbackQuery({ text: 'Немає доступу' });
    assignWait.delete(u.id);
    try {
      await ctx.answerCallbackQuery({ text: 'Призначено' });
      await assignTo(ctx, u, Number(ctx.match[1]), Number(ctx.match[2]), true);
    } catch (e) { await ctx.answerCallbackQuery({ text: e.message }).catch(() => {}); }
  });
  bot.callbackQuery(/^tk:(done|doing|review|todo|tmr|me|view):(\d+)$/, async (ctx) => {
    const u = ctx.kk;
    const [, act, idStr] = ctx.match;
    const id = Number(idStr);
    const own = u && u.status !== 'blocked' && get('SELECT assignee_id FROM pages WHERE id = ?', id)?.assignee_id === u.id;
    if (!u || (u.status !== 'active' && !own)) return ctx.answerCallbackQuery({ text: 'Немає доступу' });
    try {
      if (act === 'view') {
        await ctx.answerCallbackQuery();
        return ctx.reply(taskCard(getPage(id)), { parse_mode: 'HTML', reply_markup: taskKb(getPage(id), u) });
      }
      if (u.role === 'viewer') return ctx.answerCallbackQuery({ text: 'Лише перегляд' });
      const patch = act === 'tmr' ? { due: addDay(today(), 1) } : act === 'me' ? { assignee_id: u.id } : { status: act };
      const { page, before } = updatePage(id, patch, u);
      if (act === 'done' && before.created_by && before.created_by !== u.id) notifyTask('done', page, u, { to: before.created_by });
      await ctx.answerCallbackQuery({ text: act === 'done' ? '✅ Готово' : act === 'tmr' ? '📅 Перенесено на завтра' : act === 'me' ? 'Тепер це твоя задача' : statusName(page.status) });
      await ctx.editMessageText(taskCard(page), { parse_mode: 'HTML', reply_markup: taskKb(page, u) }).catch(() => {});
    } catch (e) {
      await ctx.answerCallbackQuery({ text: e.message || 'Помилка' });
    }
  });
  bot.command('deal', (ctx) => needActive(ctx, ctx.kk) && startDealWizard(ctx));
  bot.command('deals', (ctx) => needActive(ctx, ctx.kk) && sendDeals(ctx));
  bot.command('summary', async (ctx) => {
    if (!needActive(ctx, ctx.kk)) return;
    if (!can.seeAll(ctx.kk)) return ctx.reply('Підсумки бачить адмін або фінансист.');
    await ctx.reply(summaryText(monthlySummary()), { parse_mode: 'HTML', reply_markup: appBtn(ctx.kk) });
  });
  bot.callbackQuery(/^dw:([\w-]+):(.*)$/, async (ctx) => {
    const w = wizards.get(ctx.kk?.id);
    if (!w) return ctx.answerCallbackQuery({ text: 'Майстер закрито — почни знову «➕ Новий проєкт»' });
    await ctx.answerCallbackQuery();
    return wizardInput(ctx, w, ctx.match[1], ctx.match[2]);
  });
  bot.callbackQuery(/^dclose:(\d+)$/, async (ctx) => {
    if (!can.writeRefs(ctx.kk || {})) return ctx.answerCallbackQuery({ text: 'Немає прав' });
    try {
      const d = getDeal(Number(ctx.match[1]));
      if (!d) return ctx.answerCallbackQuery({ text: 'Проєкт не знайдено' });
      const saved = saveDeal({ ...dealToInput(d), closed: true }, ctx.kk, { id: d.id });
      await ctx.editMessageText(`✅ Закрито: ${esc(saved.task)} · ${esc(saved.client)}\nМаржа ${fmt(saved.calc.margin_original.amount, saved.calc.margin_original.currency)}`, { parse_mode: 'HTML' }).catch(() => {});
      return ctx.answerCallbackQuery({ text: 'Проєкт закрито' });
    } catch (e) {
      return ctx.answerCallbackQuery({ text: (e.message || 'Помилка').slice(0, 190), show_alert: true });
    }
  });

  bot.command('templates', (ctx) => needActive(ctx, ctx.kk) && sendTemplates(ctx));
  bot.command('debts', (ctx) => needActive(ctx, ctx.kk) && sendDebts(ctx));
  bot.command('my', (ctx) => needActive(ctx, ctx.kk) && sendCabinet(ctx));
  bot.command('forecast', async (ctx) => {
    if (!needActive(ctx, ctx.kk)) return;
    if (!can.seeAll(ctx.kk)) return ctx.reply('Прогноз бачить адмін або фінансист.');
    const f = forecast(4);
    const lines = f.weeks.map((w) => `${w.end_balance < 0 ? '🔴' : '🟢'} ${w.from.slice(5)}–${w.to.slice(5)}: +${fmt(w.income, f.base)} / −${fmt(w.expense, f.base)} → <b>${fmt(w.end_balance, f.base)}</b>`);
    await ctx.reply(`🔮 <b>Прогноз каси на 4 тижні</b>\nЗараз: ${fmt(f.start_balance, f.base)}\n\n${lines.join('\n')}\n\n${f.gap ? `⚠️ Касовий розрив: до ${fmt(f.min_balance, f.base)} близько ${f.min_date}` : '✅ Касового розриву не видно'}`, { parse_mode: 'HTML' });
  });
  bot.command('taxes', async (ctx) => {
    if (!needActive(ctx, ctx.kk)) return;
    if (!can.seeAll(ctx.kk)) return ctx.reply('Податки бачить адмін або фінансист.');
    await ctx.reply(taxesText(taxes()), { parse_mode: 'HTML', reply_markup: appBtn(ctx.kk) });
  });
  bot.command('payouts', async (ctx) => {
    if (!needActive(ctx, ctx.kk)) return;
    if (!can.seeAll(ctx.kk)) return sendCabinet(ctx);
    const p = payouts();
    if (!p.people.length) return ctx.reply('Ставки команди ще не задані. Відкрий проєкт у Mini App → «Команда проєкту».', { reply_markup: appBtn(ctx.kk) });
    await ctx.reply(`👥 <b>Виплати команді</b>\n\n${p.people.map((x) => `• ${esc(x.name)}: нараховано ${fmt(x.accrued, p.base)}, виплачено ${fmt(x.paid, p.base)}${x.planned ? `, заплановано ${fmt(x.planned, p.base)}` : ''} → <b>до виплати ${fmt(x.due, p.base)}</b>`).join('\n')}\n\nРазом до виплати: <b>${fmt(p.total_due, p.base)}</b>`, { parse_mode: 'HTML', reply_markup: appBtn(ctx.kk) });
  });
  bot.command('week', async (ctx) => {
    if (!needActive(ctx, ctx.kk)) return;
    if (!can.seeAll(ctx.kk)) return ctx.reply('Звіт бачить адмін або фінансист.');
    await ctx.reply(weeklyReport(), { parse_mode: 'HTML' });
  });
  bot.command('compare', async (ctx) => {
    if (!needActive(ctx, ctx.kk)) return;
    if (!can.seeAll(ctx.kk)) return ctx.reply('Звіт бачить адмін або фінансист.');
    await ctx.reply(compareText(compare()), { parse_mode: 'HTML' });
  });
  bot.command('backup', async (ctx) => {
    if (!needActive(ctx, ctx.kk)) return;
    if (!can.manageSettings(ctx.kk)) return ctx.reply('Бекап робить лише адмін.');
    const { buffer, filename } = makeBackup();
    await ctx.replyWithDocument(new InputFile(buffer, filename), { caption: '💾 Резервна копія бази' });
  });

  bot.callbackQuery(/^tpl:(\d+)$/, async (ctx) => {
    const u = ctx.kk;
    if (!u || u.status !== 'active') return ctx.answerCallbackQuery({ text: 'Немає доступу' });
    try {
      const tx = useTemplate(Number(ctx.match[1]), u);
      afterTx(tx);
      await ctx.answerCallbackQuery({ text: 'Записано' });
      await ctx.reply(`${tx.type === 'income' ? '➕' : '➖'} ${fmt(tx.amount, tx.currency)} · ${esc(tx.comment || '')}${tx.status === 'pending' ? '\n⏳ На перевірці в адміна.' : ''}`, { parse_mode: 'HTML' });
    } catch (e) {
      await ctx.answerCallbackQuery({ text: (e.message || 'Помилка').slice(0, 190), show_alert: true });
    }
  });
  bot.callbackQuery(/^rem:(\d+)$/, async (ctx) => {
    if (!can.seeAll(ctx.kk || {})) return ctx.answerCallbackQuery({ text: 'Немає прав' });
    const d = debts().find((x) => x.project_id === Number(ctx.match[1]));
    if (!d) return ctx.answerCallbackQuery({ text: 'Боргу вже немає' });
    await ctx.answerCallbackQuery();
    await ctx.reply(`Скопіюй і надішли клієнту:\n\n<code>${esc(reminderText(d))}</code>`, { parse_mode: 'HTML' });
  });

  // чернетки операцій (з тексту, голосу, фото) — зберігаємо лише після «✅»
  bot.callbackQuery(/^d:(save|type|acc|cancel):([\w-]+)$/, async (ctx) => {
    const [, action, id] = ctx.match;
    const d = drafts.get(id);
    const u = ctx.kk;
    if (!d || !u || d.userId !== u.id) return ctx.answerCallbackQuery({ text: 'Чернетка застаріла — надішли ще раз' });
    if (action === 'cancel') {
      drafts.delete(id);
      await ctx.editMessageText('❌ Скасовано').catch(() => {});
      return ctx.answerCallbackQuery();
    }
    if (action === 'type') {
      d.data.type = d.data.type === 'income' ? 'expense' : 'income';
      d.data.category_id = null;
      d.data.category_name = null;
      if (d.data.type === 'income') { d.data.member_id = null; d.data.member_name = null; }
      const g = guessCategory(d.data.type, d.data.comment || '');
      if (g) { d.data.category_id = g.id; d.data.category_name = g.name; }
    }
    if (action === 'acc') {
      const accs = all('SELECT * FROM accounts WHERE archived = 0 ORDER BY sort, id');
      if (accs.length) {
        const i = accs.findIndex((a) => a.id === d.data.account_id);
        const next = accs[(i + 1) % accs.length];
        d.data.account_id = next.id;
        d.data.account_name = next.name;
        d.data.account_currency = next.currency;
        d.data.currencyMismatch = d.data.currency !== next.currency && !(d.data.currency === 'USD' && next.currency === 'USDT');
      }
    }
    if (action === 'save') {
      try {
        const tx = saveDraft(d, u);
        drafts.delete(id);
        await ctx.editMessageText(`✅ Збережено #${tx.id}\n${draftText(d.data)}${tx.status === 'pending' ? '\n\n⏳ На перевірці в адміна.' : ''}`, { parse_mode: 'HTML' }).catch(() => {});
        return ctx.answerCallbackQuery({ text: 'Збережено' });
      } catch (e) {
        return ctx.answerCallbackQuery({ text: (e.message || 'Помилка').slice(0, 190), show_alert: true });
      }
    }
    await ctx.editMessageText(`${draftText(d.data)}\n\nЗберегти?`, { parse_mode: 'HTML', reply_markup: draftKb(id, d.data) }).catch(() => {});
    return ctx.answerCallbackQuery();
  });

  bot.on('message:text', async (ctx, next) => {
    const t = ctx.message.text;
    if (t.startsWith('/')) return next();
    const u = ctx.kk;
    if (!needActive(ctx, u)) return;

    if (assignWait.has(u.id) && !textMap[t]) {
      const pageId = assignWait.get(u.id);
      assignWait.delete(u.id);
      try {
        const person = addPerson({ name: t }, u);
        return assignTo(ctx, u, pageId, person.id);
      } catch (e) { return ctx.reply(`⚠️ ${e.message}`); }
    }
    if (textMap[t]) assignWait.delete(u.id);
    if (textMap[t] === 'newtask') {
      if (u.role === 'viewer') return ctx.reply('У режимі перегляду не можна створювати задачі.');
      pendingTask.set(u.id, true);
      return ctx.reply('📝 Напиши задачу одним повідомленням, наприклад:\n<code>Зробити банер для ABV @olena завтра !! #дизайн</code>\n\n@нік — відповідальний, завтра / пт / 30.10 — дедлайн, ! чи !! — пріоритет, #тег — тег.', { parse_mode: 'HTML' });
    }
    if (textMap[t] === 'mytasks') return sendMyTasks(ctx, u);
    if (pendingTask.get(u.id) && !textMap[t]) {
      pendingTask.delete(u.id);
      return quickTask(ctx, u, t);
    }
    if (textMap[t]) pendingTask.delete(u.id);
    if (textMap[t] === 'newdeal') return startDealWizard(ctx);
    if (textMap[t] === 'deals') return sendDeals(ctx);
    const wiz = wizards.get(u.id);
    if (wiz && !textMap[t]) return wizardInput(ctx, wiz, 'text', t);
    if (wiz && textMap[t]) wizards.delete(u.id);

    if (textMap[t] === 'balance') {
      if (!can.seeAll(u)) return ctx.reply('Немає доступу до загальних балансів.');
      const b = balances();
      return ctx.reply(`💼 <b>Рахунки</b>\n\n${b.accounts.map((a) => `${a.emoji} <b>${esc(a.name)}</b> · ${fmt(a.balance, a.currency)}`).join('\n')}\n\nРазом ≈ <b>${fmt(b.total, b.base)}</b>`, { parse_mode: 'HTML' });
    }
    if (textMap[t] === 'report') {
      return ctx.reply(monthCard(dashboard(u)), { parse_mode: 'HTML', reply_markup: appBtn(u) });
    }
    if (textMap[t] === 'plan') {
      if (!can.seeAll(u)) return sendCabinet(ctx);
      const rows = upcoming(21);
      if (!rows.length) return ctx.reply('Немає запланованих платежів на 3 тижні.');
      return ctx.reply(rows.map((x) => `${x.overdue ? '⚠️' : '📅'} ${x.date} · ${x.type === 'income' ? '+' : '−'}${fmt(x.amount, x.currency)} · ${esc(x.comment || x.category_name || '—')}`).join('\n'), { parse_mode: 'HTML' });
    }
    if (textMap[t] === 'team') {
      if (!can.seeAll(u)) return ctx.reply('Немає доступу.');
      const m = monthOf(today());
      const [from, to] = [`${m}-01`, today()];
      const rows = team(from, to);
      const paid = rows.filter((x) => x.paid_base);
      return ctx.reply(`👥 <b>Виплати ${m}</b>\n\n` + (paid.map((x) => `• ${esc(x.name)} — ${fmt(x.paid_base, baseCurrency())}`).join('\n') || 'Цього місяця виплат ще не було.'), { parse_mode: 'HTML' });
    }
    if (textMap[t] === 'templates') return sendTemplates(ctx);
    if (textMap[t] === 'debts') return sendDebts(ctx);
    if (textMap[t] === 'cabinet') return sendCabinet(ctx);
    if (textMap[t] === 'income' || textMap[t] === 'expense') {
      pending.set(u.id, { type: textMap[t] });
      return ctx.reply(`Напиши${textMap[t] === 'income' ? ' дохід' : ' витрату'} як зручно, наприклад:\n<code>${textMap[t] === 'income' ? '500$ від ABV за сайт на ФОП' : '300 грн реклама в інсту'}</code>\nАбо надішли голосове 🎙`, { parse_mode: 'HTML' });
    }

    const forced = pending.get(u.id)?.type;
    const parsed = parseOperation(t, { forcedType: forced });
    if (parsed) {
      pending.delete(u.id);
      return showDraft(ctx, u, parsed);
    }
    if (/\d/.test(t)) {
      return ctx.reply('Не зрозумів, це дохід чи витрата 🤔\nНапиши, наприклад: <code>+1200 сайт клієнта</code>, <code>-300 реклама</code> або «отримала 500$ від ABV».', { parse_mode: 'HTML' });
    }
    return next();
  });

  // поділилися контактом (з Telegram чи телефонної книги) — додаємо людину, щоб призначати на задачі
  bot.on('message:contact', async (ctx) => {
    const u = ctx.kk;
    if (!needActive(ctx, u)) return;
    if (u.role === 'viewer') return ctx.reply('У режимі перегляду не можна додавати людей.');
    const c = ctx.message.contact;
    try {
      const person = addPerson({ name: [c.first_name, c.last_name].filter(Boolean).join(' '), phone: c.phone_number, tg_id: c.user_id }, u);
      const pageId = assignWait.get(u.id);
      if (pageId) { assignWait.delete(u.id); return assignTo(ctx, u, pageId, person.id); }
      return ctx.reply(`📇 ${person.existed ? 'Вже є в команді' : 'Додано в контакти'}: <b>${esc(person.name)}</b>${person.phone ? ` · ${esc(person.phone)}` : ''}\n\nТепер цю людину можна призначати відповідальною: у Mini App або <code>/task … @${esc(person.username || person.name.split(' ')[0])}</code>.${person.status === 'contact' ? '\nДоступу до бухгалтерії в неї немає — лише задачі.' : ''}`, { parse_mode: 'HTML' });
    } catch (e) {
      return ctx.reply(`⚠️ ${e.message}`);
    }
  });

  bot.on('message:voice', async (ctx) => {
    const u = ctx.kk;
    if (!needActive(ctx, u)) return;
    if (!aiEnabled()) return ctx.reply('🎙 Голосовий ввід ще не увімкнено (адміну треба додати OPENAI_API_KEY). Напиши текстом: «500$ від ABV за сайт».');
    if ((ctx.message.voice.duration || 0) > 120) return ctx.reply('Голосове задовге — до 2 хвилин, будь ласка.');
    const wait = await ctx.reply('🎙 Слухаю…');
    try {
      const text = await transcribe(await downloadFile(ctx), 'voice.ogg');
      const parsed = parseOperation(text, { forcedType: pending.get(u.id)?.type });
      await bot.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
      if (!parsed) return ctx.reply(`Почув: «${esc(text)}»\nАле не знайшов суму або тип. Спробуй: «отримала 500 доларів від ABV за сайт».`, { parse_mode: 'HTML' });
      pending.delete(u.id);
      return showDraft(ctx, u, parsed, { heard: text });
    } catch (e) {
      await bot.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
      return ctx.reply(e.message || 'Не вдалося розпізнати голосове.');
    }
  });

  bot.on('message:document', async (ctx) => {
    const u = ctx.kk;
    if (!needActive(ctx, u)) return;
    const doc = ctx.message.document;
    const name = doc.file_name || '';
    if (/^image\//.test(doc.mime_type || '')) return handleReceipt(ctx, u, doc.file_id, doc.mime_type);
    if (!can.manageSettings(u)) return ctx.reply('Імпорт таблиці лише для адміна.');
    if (!/\.(xlsx|xls|csv)$/i.test(name)) return ctx.reply('Надішли Excel (.xlsx) або CSV зі старої таблиці.');
    await ctx.reply('Імпортую таблицю…');
    try {
      const buf = await downloadFile(ctx);
      const { importBuffer } = await import('./services/importSheet.js');
      const result = await importBuffer(buf, name, u);
      await ctx.reply(`Готово: імпортовано <b>${result.imported}</b>, пропущено ${result.skipped}.`, { parse_mode: 'HTML', reply_markup: appBtn(u) });
    } catch (e) {
      await ctx.reply(e.message || 'Не вдалося імпортувати файл.');
    }
  });

  bot.on('message:photo', async (ctx) => {
    const u = ctx.kk;
    if (!needActive(ctx, u)) return;
    const fileId = ctx.message.photo.at(-1).file_id;
    const caption = ctx.message.caption || '';
    if (caption) {
      const parsed = parseOperation(caption, { forcedType: pending.get(u.id)?.type });
      if (parsed) {
        pending.delete(u.id);
        return showDraft(ctx, u, parsed, { fileId });
      }
    }
    return handleReceipt(ctx, u, fileId, 'image/jpeg');
  });
  bot.catch((err) => console.error('bot error', err.error || err));
}

function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export async function sendFile(chatId, buffer, filename, caption) {
  if (!bot) throw new Error('Бот не налаштований');
  await bot.api.sendDocument(chatId, new InputFile(buffer, filename), { caption });
}

/* ───────────── Майстер угоди (поля як у таблиці) ───────────── */
const wizards = new Map();
const STEPS = ['section', 'executor', 'client', 'type', 'task', 'start', 'end', 'method', 'price', 'prepay', 'prog', 'margin', 'extra', 'closed', 'executor_paid', 'confirm'];
const ASK = {
  section: 'Розділ таблиці:',
  executor: 'Виконавець (хто робить):',
  client: 'Замовник (@username, імʼя або id):',
  type: 'Тип роботи:',
  task: 'Завдання (коротко):',
  start: 'Дата початку (дд.мм):',
  end: 'Дата завершення (дд.мм) або «Пропустити», якщо ще в роботі:',
  method: 'Метод оплати:',
  price: 'Ціна для замовника (напр. <code>10000 грн</code> або <code>400$</code>):',
  prepay: 'Передоплата від замовника (0, якщо немає):',
  prog: 'Передоплата виконавцю — «Передоплата прог.» (0, якщо немає):',
  margin: 'Маржа (наш заробіток):',
  extra: 'Доп. послуга — ціна й число оплати (напр. <code>плюс 600 грн 10.03</code>) або «Пропустити»:',
  closed: 'Угода закрита й повністю оплачена?',
  executor_paid: 'Виконавцю вже виплачено все?',
};

function wizKb(w, step) {
  const kb = new InlineKeyboard();
  // значення кнопок зберігаємо в майстрі (callback_data ≤ 64 байти, а кирилиця — 2 байти на літеру)
  w.opts = w.opts || {};
  w.opts[step] = [];
  const btn = (label, value) => {
    w.opts[step].push(value);
    return kb.text(String(label).slice(0, 60), `dw:${step}:#${w.opts[step].length - 1}`);
  };
  if (step === 'section') SECTIONS.forEach((s, i) => { btn(s, s); if (i % 2) kb.row(); });
  if (step === 'executor') {
    btn('Я сама / сам', '__me').row();
    all('SELECT u.name, COUNT(*) n FROM projects p JOIN users u ON u.id = p.executor_id GROUP BY u.id ORDER BY n DESC LIMIT 6')
      .forEach((r, i) => { btn(r.name, r.name); if (i % 2) kb.row(); });
  }
  if (step === 'client') all("SELECT cl.name FROM projects p JOIN clients cl ON cl.id = p.client_id WHERE p.section IS NOT NULL GROUP BY cl.id ORDER BY MAX(p.id) DESC LIMIT 6")
    .forEach((r, i) => { btn(r.name, r.name); if (i % 2) kb.row(); });
  if (step === 'type') all("SELECT work_type AS t, COUNT(*) n FROM projects WHERE work_type != '' AND section = ? GROUP BY lower(work_type) ORDER BY n DESC LIMIT 6", w.data.section || '')
    .forEach((r, i) => { btn(r.t, r.t); if (i % 2) kb.row(); });
  if (step === 'start') btn('Сьогодні', today());
  if (step === 'end') btn('Сьогодні', today()).text('Пропустити', `dw:${step}:__skip`);
  if (step === 'method') METHODS.forEach((m) => btn(m, m));
  if (step === 'prepay' || step === 'prog') btn('0 — немає', '0');
  if (step === 'margin') {
    const price = parseMoney(w.data.price);
    const prog = parseMoney(w.data.prog, price?.currency);
    if (price && prog && prog.currency === price.currency && prog.amount) btn(`= Ціна − Передоплата прог. (${fmt(price.amount - prog.amount, price.currency)})`, '__auto');
    if (price) kb.row().text(`Уся ціна — робота своя (${fmt(price.amount, price.currency)})`, `dw:${step}:__all`);
  }
  if (step === 'extra') btn('Пропустити', '__skip');
  if (step === 'closed') btn('✅ Так, закрита', '1').text('⏳ Ні, в роботі', 'dw:closed:0');
  if (step === 'executor_paid') btn('✅ Так, виплачено все', '1').text('Ні, ще винні', 'dw:executor_paid:0');
  if (step === 'confirm') kb.text('✅ Зберегти', 'dw:confirm:save').row().text('✏️ Почати спочатку', 'dw:confirm:restart').text('❌ Скасувати', 'dw:confirm:cancel');
  if (!['section', 'confirm', 'closed', 'executor_paid'].includes(step)) kb.row().text('⬅️ Назад', `dw:${step}:__back`).text('❌', `dw:${step}:__cancel`);
  return kb;
}

async function askStep(ctx, w) {
  const step = STEPS[w.i];
  if (step === 'confirm') {
    let preview;
    try {
      const d = normalizeDeal(w.data);
      const c = calcDeal(d);
      preview = `<b>${esc(d.section)}</b> · ${esc(d.task)}\n`
        + `👤 Виконавець: ${esc(d.executor || '—')}\n🤝 Замовник: ${esc(d.client || '—')}\n🏷 ${esc(d.type || '—')}\n`
        + `📅 ${d.start_date || '—'} → ${d.end_date || 'в роботі'}\n💳 ${esc(d.method || '—')}\n\n`
        + `Ціна: <b>${fmt(d.price, d.price_currency)}</b>\nПередоплата: ${fmt(d.prepay, d.prepay_currency)}\nПередоплата прог.: ${fmt(d.prog_prepay, d.prog_currency)}\n`
        + `Маржа: <b>${fmt(c.margin_original.amount, c.margin_original.currency)}</b>\nВиконавцю всього: ${fmt(c.executor_total, c.currency)}\n`
        + `${d.extra ? `Доп. послуга: ${esc(d.extra)}\n` : ''}\n${d.closed ? '✅ Закрита й оплачена' : `⏳ В роботі · замовник винен ${fmt(c.client_left, c.currency)} · ${c.executor_paid ? 'виконавцю виплачено все' : `виконавцю ще ${fmt(c.executor_left, c.currency)}`}`}`;
    } catch (e) {
      w.i = STEPS.indexOf('price');
      await ctx.reply(`⚠️ ${esc(e.message)}`, { parse_mode: 'HTML' });
      return askStep(ctx, w);
    }
    return ctx.reply(`Перевір проєкт:\n\n${preview}`, { parse_mode: 'HTML', reply_markup: wizKb(w, 'confirm') });
  }
  return ctx.reply(`${w.i + 1}/${STEPS.length - 1} · ${ASK[step]}`, { parse_mode: 'HTML', reply_markup: wizKb(w, step) });
}

async function startDealWizard(ctx) {
  if (!can.writeRefs(ctx.kk)) return ctx.reply('Проєкти додає адмін або фінансист.');
  pending.delete(ctx.kk.id);
  const w = { i: 0, data: {} };
  wizards.set(ctx.kk.id, w);
  await ctx.reply('➕ <b>Новий проєкт</b> — як рядок у таблиці. Можна відповідати кнопками або текстом.', { parse_mode: 'HTML' });
  return askStep(ctx, w);
}

async function wizardInput(ctx, w, step, raw) {
  const cur = STEPS[w.i];
  if (step !== 'text' && step !== cur) return; // натиснули кнопку старого кроку
  let value = String(raw ?? '').trim();
  if (step !== 'text' && /^#\d+$/.test(value)) value = String(w.opts?.[cur]?.[Number(value.slice(1))] ?? '');
  if (value === '__cancel') { wizards.delete(ctx.kk.id); return ctx.reply('❌ Скасовано.'); }
  if (value === '__back') { w.i = Math.max(0, w.i - 1); return askStep(ctx, w); }
  if (cur === 'confirm') {
    if (value === 'cancel') { wizards.delete(ctx.kk.id); return ctx.reply('❌ Скасовано.'); }
    if (value === 'restart') { w.i = 0; w.data = {}; return askStep(ctx, w); }
    if (value === 'save') {
      try {
        const d = saveDeal(w.data, ctx.kk);
        wizards.delete(ctx.kk.id);
        return ctx.reply(`✅ Проєкт збережено (#${d.id}). Операції, борги й виплати перераховано.`, { reply_markup: appBtn(ctx.kk) });
      } catch (e) {
        return ctx.reply(`⚠️ ${e.message}`);
      }
    }
    return askStep(ctx, w);
  }
  const d = w.data;
  const setAndNext = (k, v) => { d[k] = v; w.i += 1; return askStep(ctx, w); };
  switch (cur) {
    case 'section': {
      const s = SECTIONS.find((x) => x.toLowerCase() === value.toLowerCase());
      if (!s) return ctx.reply('Обери розділ кнопкою.', { reply_markup: wizKb(w, cur) });
      return setAndNext('section', s);
    }
    case 'executor': return setAndNext('executor', value === '__me' ? ctx.kk.name : value);
    case 'client': case 'type': case 'task': case 'method':
      if (!value) return askStep(ctx, w);
      return setAndNext(cur, value);
    case 'start': case 'end': {
      if (cur === 'end' && (value === '__skip' || /^пропуст/i.test(value))) return setAndNext('end', '');
      const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : /сьогодні/i.test(value) ? today() : parseDate(value);
      if (!date) return ctx.reply('Не зрозумів дату. Напиши у форматі <code>дд.мм</code>, напр. <code>25.10</code>.', { parse_mode: 'HTML' });
      return setAndNext(cur, date);
    }
    case 'price': case 'prepay': case 'prog': {
      const fallback = /крипт/i.test(d.method || '') ? 'USD' : (parseMoney(d.price)?.currency || 'UAH');
      if (/^(0|немає|нема|-)$/i.test(value)) return setAndNext(cur, '0');
      const m = parseMoney(value, fallback);
      if (!m || (cur === 'price' && !m.amount)) return ctx.reply('Напиши суму, напр. <code>10000 грн</code> або <code>400$</code>.', { parse_mode: 'HTML' });
      return setAndNext(cur, `${m.amount / 100}${m.currency === 'UAH' ? 'грн' : '$'}`);
    }
    case 'margin': {
      const price = parseMoney(d.price);
      if (value === '__auto') {
        const prog = parseMoney(d.prog, price.currency);
        return setAndNext('margin', `${(price.amount - (prog?.amount || 0)) / 100}${price.currency === 'UAH' ? 'грн' : '$'}`);
      }
      if (value === '__all') return setAndNext('margin', d.price);
      const m = parseMoney(value, price?.currency || 'UAH');
      if (!m) return ctx.reply('Напиши маржу сумою, напр. <code>5000 грн</code>.', { parse_mode: 'HTML' });
      if (price && m.currency === price.currency && m.amount > price.amount) return ctx.reply('Маржа не може бути більшою за ціну. Спробуй ще раз.');
      return setAndNext('margin', `${m.amount / 100}${m.currency === 'UAH' ? 'грн' : '$'}`);
    }
    case 'extra': return setAndNext('extra', value === '__skip' || /^пропуст/i.test(value) ? '' : value);
    case 'closed': {
      const closed = value === '1' || /^(так|yes|✅)/i.test(value);
      d.closed = closed;
      w.i += closed ? 2 : 1; // закрита → виконавцю теж усе виплачено
      if (closed) d.executor_paid = true;
      return askStep(ctx, w);
    }
    case 'executor_paid': return setAndNext('executor_paid', value === '1' || /^(так|yes|✅)/i.test(value));
    default: return askStep(ctx, w);
  }
}

function dealToInput(d) {
  const money = (v, c) => (v === null || v === undefined ? '' : { amount: v, currency: c });
  return {
    section: d.section, executor: d.executor, client: d.client, type: d.type, task: d.task, start: d.start_date, end: d.end_date || (d.closed ? '' : ''),
    method: d.method, price: money(d.price, d.currency), prepay: money(d.prepay, d.prepay_currency), prog: money(d.prog_prepay, d.prog_currency),
    margin: d.margin === null ? '' : money(d.margin, d.margin_currency), extra: d.extra, closed: d.closed, executor_paid: d.executor_paid,
  };
}

async function sendDeals(ctx) {
  const u = ctx.kk;
  if (!can.seeAll(u)) {
    const mine = listDeals({ status: 'open' }).filter((d) => d.executor_id === u.id);
    if (!mine.length) return ctx.reply('У тебе немає проєктів у роботі.');
    return ctx.reply(`📋 <b>Мої проєкти в роботі</b>\n\n${mine.map((d) => `• ${esc(d.task)} · ${esc(d.client)}\n  отримаю ${fmt(d.calc.executor_total, d.calc.currency)}, вже ${fmt(d.prog_prepay, d.prog_currency || d.calc.currency)}`).join('\n')}`, { parse_mode: 'HTML' });
  }
  const b = dealBalances();
  if (!b.deals.length) return ctx.reply('Усі проєкти закриті 🎉', { reply_markup: appBtn(u) });
  await ctx.reply(`📋 <b>Проєкти в роботі: ${b.open}</b>\nЗамовники винні ≈ <b>${fmt(b.clients_owe_uah, 'UAH')}</b>\nВиконавцям ще ≈ <b>${fmt(b.we_owe_executors_uah, 'UAH')}</b>`, { parse_mode: 'HTML' });
  for (const d of b.deals.slice(0, 15)) {
    await ctx.reply(
      `<b>${esc(d.section)}</b> · ${esc(d.task)}\n🤝 ${esc(d.client || '—')} · 👤 ${esc(d.executor || '—')}\n📅 з ${d.start_date || '—'}\n`
      + `Ціна ${fmt(d.price, d.currency)} · отримано ${fmt(d.prepay, d.prepay_currency)} · маржа ${fmt(d.calc.margin_original.amount, d.calc.margin_original.currency)}\n`
      + `Замовник винен <b>${fmt(d.calc.client_left, d.calc.currency)}</b> · виконавцю ще <b>${fmt(d.calc.executor_left, d.calc.currency)}</b>`,
      { parse_mode: 'HTML', reply_markup: can.writeRefs(u) ? new InlineKeyboard().text('✅ Закрити — все оплачено', `dclose:${d.id}`) : undefined },
    );
  }
}

function summaryText(s) {
  const rows = s.months.filter((m) => s.counts[m]).map((m) => {
    const t = s.table[m];
    const parts = s.sections.filter((x) => t[x]).map((x) => `${x} ${fmt(t[x], 'UAH')}`);
    return `<b>${m}</b> — ${fmt(t['Прибуток'], 'UAH')}\n  ${parts.join(' · ')}`;
  });
  return `📊 <b>Підсумки ${s.year}</b> (маржа, грн; $ за курсом ${s.usd_rate})\n\n${rows.join('\n') || 'Поки немає проєктів'}\n\nРазом: <b>${fmt(s.totals['Прибуток'], 'UAH')}</b>`;
}

const drafts = new Map();
const DRAFT_TTL = 6 * 3600 * 1000;

function draftId() {
  return Math.random().toString(36).slice(2, 10);
}

function draftText(d) {
  const sign = d.type === 'income' ? '➕ Дохід' : '➖ Витрата';
  let money = fmt(d.amount, d.currency);
  if (d.currencyMismatch && d.account_currency) {
    try {
      money += ` (≈ ${fmt(convert(d.amount, d.currency, d.account_currency), d.account_currency)} на рахунок)`;
    } catch {
      money += ' ⚠️ немає курсу';
    }
  }
  return [
    `${sign} · <b>${money}</b>`,
    `💳 ${esc(d.account_name || 'рахунок не обрано')}`,
    d.category_name ? `🏷 ${esc(d.category_name)}` : '🏷 без категорії',
    d.client_name || d.project_name ? `👤 ${esc([d.client_name, d.project_name].filter(Boolean).join(' · '))}` : null,
    d.member_name ? `👥 ${esc(d.member_name)}` : null,
    `📅 ${d.date}`,
    d.comment ? `💬 ${esc(d.comment)}` : null,
  ].filter(Boolean).join('\n');
}

function draftKb(id, d) {
  return new InlineKeyboard()
    .text('✅ Зберегти', `d:save:${id}`).row()
    .text(d.type === 'income' ? '↔️ Це витрата' : '↔️ Це дохід', `d:type:${id}`)
    .text('💳 Інший рахунок', `d:acc:${id}`).row()
    .text('❌ Скасувати', `d:cancel:${id}`);
}

async function showDraft(ctx, user, data, extra = {}) {
  for (const [k, v] of drafts) if (Date.now() - v.at > DRAFT_TTL) drafts.delete(k);
  const id = draftId();
  drafts.set(id, { userId: user.id, data, fileId: extra.fileId || null, at: Date.now() });
  const head = extra.heard ? `🎙 «${esc(extra.heard)}»\n\n` : extra.receipt ? '🧾 З чека:\n\n' : '';
  return ctx.reply(`${head}${draftText(data)}\n\nЗберегти?`, { parse_mode: 'HTML', reply_markup: draftKb(id, data) });
}

function saveDraft(d, user) {
  const x = d.data;
  if (!x.account_id) throw new Error('Оберіть рахунок');
  let amount = x.amount;
  let comment = x.comment || '';
  if (x.currencyMismatch && x.account_currency) {
    amount = convert(x.amount, x.currency, x.account_currency);
    comment = `${comment} (${fmt(x.amount, x.currency)})`.trim();
  }
  const tx = createTx({
    type: x.type,
    amount,
    account_id: x.account_id,
    category_id: x.category_id,
    project_id: x.project_id,
    client_id: x.client_id,
    member_id: x.member_id,
    date: x.date,
    comment,
    receipt_file_id: d.fileId || null,
  }, user);
  afterTx(tx);
  if (tx.status === 'pending') {
    notifyAdmins(`⏳ Нова операція на перевірку\n${tx.type === 'income' ? '➕' : '➖'} ${fmt(tx.amount, tx.currency)}\n${esc(tx.comment || '—')}\nвід ${esc(user.name)}`, {
      reply_markup: new InlineKeyboard().text('✅ Провести', `ok:${tx.id}`).text('❌ Відхилити', `no:${tx.id}`),
    }).catch(() => {});
  }
  return tx;
}

function afterTx(tx) {
  try {
    const alert = checkLimit(tx);
    if (alert) notifyAdmins(alert.text).catch(() => {});
  } catch (e) {
    console.warn('limit', e.message || e);
  }
}

async function downloadFile(ctx) {
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  const res = await (config.forceTelegramIp ? telegramFetch(url) : fetch(url));
  if (!res.ok) throw new Error('Не вдалося завантажити файл з Telegram');
  return Buffer.from(await res.arrayBuffer());
}

async function handleReceipt(ctx, u, fileId, mime) {
  if (aiEnabled()) {
    const wait = await ctx.reply('🧾 Читаю чек…');
    try {
      const r = await readReceipt(await downloadFile(ctx), mime);
      await bot.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
      if (r) {
        const parsed = parseOperation(`${r.type === 'income' ? '+' : '-'}${r.amount / 100} ${r.currency} ${r.title || ''}`) || null;
        if (parsed) {
          if (r.date) parsed.date = r.date;
          return showDraft(ctx, u, parsed, { fileId, receipt: true });
        }
      }
      await ctx.reply('Не знайшов суму на фото. Додай підпис до фото, наприклад «-450 грн хостинг».');
    } catch (e) {
      await bot.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
      await ctx.reply(e.message || 'Не вдалося прочитати чек.');
    }
    return;
  }
  const last = get('SELECT id FROM transactions WHERE created_by = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', u.id);
  if (!last) return ctx.reply('Додай підпис до фото, наприклад «-450 грн хостинг», — і я запишу операцію з чеком.');
  run('UPDATE transactions SET receipt_file_id = ? WHERE id = ?', fileId, last.id);
  await ctx.reply(`🖼 Чек прикріплено до операції #${last.id}.\nПорада: підпис до фото («-450 грн хостинг») одразу створить нову операцію.`);
}

async function sendTemplates(ctx) {
  const list = listTemplates();
  if (!list.length) return ctx.reply('Шаблонів ще немає. Створи їх у Mini App → Ще → Шаблони (оренда, підписки, виплати…).', { reply_markup: appBtn(ctx.kk) });
  const kb = new InlineKeyboard();
  list.slice(0, 30).forEach((t, i) => {
    kb.text(`${t.emoji} ${t.title} · ${fmt(t.amount, t.currency)}`.slice(0, 60), `tpl:${t.id}`);
    if (i % 1 === 0) kb.row();
  });
  return ctx.reply('⚡ Тапни — і операція запишеться сьогоднішньою датою:', { reply_markup: kb });
}

async function sendDebts(ctx) {
  if (!can.seeAll(ctx.kk)) return ctx.reply('Борги бачить адмін або фінансист.');
  const list = debts();
  if (!list.length) return ctx.reply('🎉 Боргів клієнтів немає.');
  const base = baseCurrency();
  const total = list.reduce((s, d) => s + d.left_base, 0);
  await ctx.reply(`📌 <b>Борги клієнтів</b> — разом ≈ ${fmt(total, base)}`, { parse_mode: 'HTML' });
  for (const d of list.slice(0, 10)) {
    await ctx.reply(
      `${d.overdue_days ? '🔴' : '🟡'} <b>${esc(d.client_name || 'без клієнта')}</b> · ${esc(d.project_name)}\n`
      + `Оплачено ${fmt(d.paid, d.currency)} з ${fmt(d.budget, d.currency)}\nЗалишок: <b>${fmt(d.left, d.currency)}</b>`
      + `${d.deadline ? `\nТермін: ${d.deadline}${d.overdue_days ? ` (прострочено ${d.overdue_days} дн.)` : ''}` : ''}`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('📨 Текст нагадування', `rem:${d.project_id}`) },
    );
  }
}

async function sendCabinet(ctx) {
  const c = memberCabinet(ctx.kk);
  const lines = c.projects.map((p) => `• ${esc(p.project_name)} (${p.kind === 'pct' ? `${p.value}%` : fmt(p.value, p.currency)}): нараховано ${fmt(p.accrued, c.base)}, виплачено ${fmt(p.paid, c.base)} → <b>${fmt(p.due, c.base)}</b>`);
  await ctx.reply(
    `👤 <b>Мій кабінет</b>\n\nВиплачено цього місяця: <b>${fmt(c.paid_month, c.base)}</b>\n`
    + `Нараховано всього: ${fmt(c.accrued, c.base)}\nВиплачено всього: ${fmt(c.paid, c.base)}\n`
    + `${c.planned ? `Заплановано: ${fmt(c.planned, c.base)}\n` : ''}До виплати: <b>${fmt(c.due, c.base)}</b>`
    + `${c.pending ? `\nНа перевірці: ${c.pending}` : ''}${lines.length ? `\n\n${lines.join('\n')}` : ''}`,
    { parse_mode: 'HTML', reply_markup: appBtn(ctx.kk) },
  );
}

function taxesText(t) {
  if (!t.enabled) return 'Податки вимкнено в налаштуваннях (Ще → Податки ФОП).';
  const lines = t.items.slice(0, 8).map((i) => `${i.paid ? '✅' : i.days_left < 0 ? '🔴' : i.days_left <= 7 ? '🟡' : '•'} ${esc(i.title)} — <b>${fmt(i.amount, 'UAH')}</b> до ${i.due}${i.paid ? ' (сплачено)' : i.days_left < 0 ? ' (прострочено)' : ` (${i.days_left} дн.)`}`);
  const q = t.quarters[1];
  return `🧾 <b>Податки ФОП · ${t.settings.group} група</b>\n\nДохід ${q.quarter}: ${fmt(q.income, 'UAH')}\n`
    + `Дохід з початку року: ${fmt(t.ytd_income, 'UAH')}${t.limit ? ` (${t.limit_pct}% ліміту)` : ''}\n\n${lines.join('\n')}`;
}

function compareText(c) {
  const p = (n) => (n === null ? '—' : `${n > 0 ? '+' : ''}${n}%`);
  return `📈 <b>Порівняння · ${c.current.month}</b>\n\n`
    + `Доходи: <b>${fmt(c.current.income, c.base)}</b> · до мин. міс. ${p(c.vs_previous.income)} · до року тому ${p(c.vs_year_ago.income)}\n`
    + `Витрати: <b>${fmt(c.current.expense, c.base)}</b> · ${p(c.vs_previous.expense)} · ${p(c.vs_year_ago.expense)}\n`
    + `Прибуток: <b>${fmt(c.current.profit, c.base)}</b> · ${p(c.vs_previous.profit)} · ${p(c.vs_year_ago.profit)}\n\n`
    + `З початку року: прибуток ${fmt(c.ytd.profit, c.base)} (торік за той самий період ${fmt(c.ytd_prev.profit, c.base)})`;
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

/* ───────── задачі ───────── */
const pendingTask = new Map();
const assignWait = new Map(); // хто зараз обирає відповідального → id задачі

async function askAssignee(ctx, u, pageId) {
  const page = getPage(pageId);
  assignWait.set(u.id, pageId);
  const people = assignable().slice(0, 12);
  const kb = new InlineKeyboard();
  people.forEach((p, i) => {
    kb.text(`${p.id === page.assignee_id ? '● ' : ''}${p.id === u.id ? '🙋 Я' : p.name}${p.status === 'contact' ? ' 📇' : ''}`.slice(0, 30), `tk:set:${pageId}:${p.id}`);
    if (i % 2 === 1) kb.row();
  });
  return ctx.reply(
    `👤 Кого призначити на «${esc(page.title || 'Без назви')}»?\n\n`
    + 'Обери зі списку, або:\n• напиши <b>@нік</b> у Telegram чи імʼя,\n• або надішли контакт: 📎 → <b>Контакт</b> (можна з телефонної книги).',
    { parse_mode: 'HTML', reply_markup: kb },
  );
}
/** Призначає задачу й підказує, як повідомити людину, якщо вона ще не в боті. */
async function assignTo(ctx, u, pageId, personId, edit = false) {
  const { page } = updatePage(pageId, { assignee_id: personId }, u);
  const person = get('SELECT * FROM users WHERE id = ?', personId);
  const reachable = person.tg_id && person.notify && person.status !== 'contact';
  if (personId !== u.id && reachable) await notifyTask('assigned', page, u);
  let note = '';
  if (personId !== u.id && !reachable) {
    note = `\n\n📨 ${esc(person.name)} ще не користується ботом — перешли посилання, щоб людина отримала задачу й сповіщення:\n${taskInviteLink(pageId, personId)}`;
  }
  const text = `✅ Відповідальний: <b>${esc(person.name)}</b>\n\n${taskCard(page)}${note}`;
  const opts = { parse_mode: 'HTML', reply_markup: taskKb(page, u), link_preview_options: { is_disabled: true } };
  if (edit) return ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
  return ctx.reply(text, opts);
}
const addDay = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ddmm = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '');

function taskCard(p) {
  const lines = [`${p.icon || '📝'} <b>${esc(p.title || 'Без назви')}</b>`, ''];
  lines.push(`Статус: <b>${statusName(p.status)}</b>`);
  if (p.assignee_name) lines.push(`Відповідальний: ${esc(p.assignee_name)}`);
  if (p.due) lines.push(`Дедлайн: ${p.overdue ? '🔴 ' : ''}${ddmm(p.due)}`);
  if (p.priority) lines.push(`Пріоритет: ${priorityName(p.priority)}`);
  if (p.project_name) lines.push(`Проєкт: ${esc(p.project_name)}`);
  if (p.tags?.length) lines.push(p.tags.map((t) => `#${esc(t)}`).join(' '));
  if (p.checklist) lines.push(`Чекліст: ${p.checklist.done}/${p.checklist.total}`);
  return lines.join('\n');
}
function taskKb(p, viewer = null) {
  const kb = new InlineKeyboard();
  if (p.status !== 'done') {
    kb.text('✅ Готово', `tk:done:${p.id}`);
    if (p.status !== 'doing') kb.text('▶️ В роботу', `tk:doing:${p.id}`);
    else kb.text('👀 На перевірку', `tk:review:${p.id}`);
    kb.row().text('📅 На завтра', `tk:tmr:${p.id}`);
    if (!p.assignee_id && canBeAssignee(viewer?.id)) kb.text('🙋 Беру', `tk:me:${p.id}`);
    if (viewer?.status === 'active' && viewer.role !== 'viewer') kb.text(p.assignee_id ? '👤 Змінити' : '👤 Призначити', `tk:as:${p.id}`);
  } else {
    kb.text('↩️ Повернути в роботу', `tk:doing:${p.id}`);
  }
  const url = pageAppUrl(p.id);
  if (url) kb.row().webApp('Відкрити сторінку', url);
  return kb;
}
async function quickTask(ctx, u, text) {
  const parsed = parseTaskText(text, today());
  if (!parsed.title) return ctx.reply('Порожня задача 🤔 Напиши, що треба зробити.');
  const page = createPage({ kind: 'task', status: 'todo', ...parsed, assignee_id: parsed.assignee_id || (canBeAssignee(u.id) ? u.id : null) }, u);
  let note = '';
  if (page.assignee_id && page.assignee_id !== u.id) {
    const person = get('SELECT * FROM users WHERE id = ?', page.assignee_id);
    if (person.tg_id && person.notify && person.status !== 'contact') notifyTask('assigned', page, u);
    else note = `\n\n📨 ${esc(person.name)} ще не в боті — перешли посилання:\n${taskInviteLink(page.id, person.id)}`;
  }
  return ctx.reply(`Додано ✨\n\n${taskCard(page)}${note}`, { parse_mode: 'HTML', reply_markup: taskKb(page, u), link_preview_options: { is_disabled: true } });
}
async function sendMyTasks(ctx, u) {
  const rows = myOpenTasks(u.id, 12);
  if (!rows.length) return ctx.reply('🎉 Відкритих задач немає. Додати: «📝 Задача» або /task текст', { reply_markup: appBtn(u) });
  const kb = new InlineKeyboard();
  rows.forEach((p) => kb.text(`✅ ${(p.title || 'Без назви').slice(0, 28)}`, `tk:done:${p.id}`).text('›', `tk:view:${p.id}`).row());
  const url = appUrl(u.tg_id);
  if (url) kb.webApp('🗂 Усі задачі', `${url.replace(/\/$/, '')}/?tab=tasks`);
  return ctx.reply(`✅ <b>Мої задачі</b> · ${rows.length}\n\n${rows.map((p) => esc(taskLine(p))).join('\n')}\n\nТисни ✅, щоб закрити, або › — деталі.`, { parse_mode: 'HTML', reply_markup: kb });
}
/** Сповіщення про задачу: призначили, закрили, новий коментар. */
export async function notifyTask(kind, page, actor, extra = {}) {
  if (!bot || !page) return;
  const who = esc(actor?.name || 'Хтось');
  const targets = new Set();
  let head = '';
  if (kind === 'assigned') { targets.add(page.assignee_id); head = `📌 ${who} призначив(ла) тобі задачу`; }
  if (kind === 'done') { targets.add(extra.to); head = `✅ ${who} закрив(ла) задачу`; }
  if (kind === 'comment') {
    [page.assignee_id, page.created_by].forEach((x) => targets.add(x));
    head = `💬 ${who} прокоментував(ла):\n<i>${esc(String(extra.text || '').slice(0, 400))}</i>`;
  }
  targets.delete(actor?.id);
  for (const id of targets) {
    if (!id) continue;
    const t = get("SELECT id, tg_id FROM users WHERE id = ? AND status = 'active' AND notify = 1", id);
    if (t?.tg_id) await bot.api.sendMessage(t.tg_id, `${head}\n\n${taskCard(page)}`, { parse_mode: 'HTML', reply_markup: taskKb(page, t) }).catch(() => {});
  }
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
  await bot.init();
  const setup = async () => {
    const me = await bot.api.getMe();
    setSetting('bot_username', me.username);
    await bot.api.setMyCommands([
      { command: 'start', description: 'Відкрити бухгалтерію' },
      { command: 'app', description: 'Mini App' },
      { command: 'invite', description: 'Запросити людей / адмінів' },
      { command: 'balance', description: 'Баланси рахунків' },
      { command: 'report', description: 'Звіт за місяць' },
      { command: 'pending', description: 'Операції на перевірці' },
      { command: 'task', description: 'Нова задача: /task текст @нік завтра !' },
      { command: 'tasks', description: 'Мої задачі' },
      { command: 'deal', description: 'Новий проєкт (як у таблиці)' },
      { command: 'deals', description: 'Проєкти в роботі' },
      { command: 'summary', description: 'Підсумки маржі по місяцях' },
      { command: 'debts', description: 'Борги клієнтів' },
      { command: 'forecast', description: 'Прогноз каси на 4 тижні' },
      { command: 'taxes', description: 'Податки ФОП' },
      { command: 'payouts', description: 'Виплати команді' },
      { command: 'my', description: 'Мій кабінет' },
      { command: 'templates', description: 'Шаблони операцій' },
      { command: 'week', description: 'Звіт за тиждень' },
      { command: 'compare', description: 'Порівняння з минулим місяцем і роком' },
      { command: 'backup', description: 'Резервна копія бази' },
    ]);
    const url = appUrl();
    if (url) {
      await bot.api.setChatMenuButton({
        menu_button: { type: 'web_app', text: 'Бухгалтерія', web_app: { url } },
      });
      for (const id of config.adminIds) {
        await bot.api.setChatMenuButton({
          chat_id: id,
          menu_button: { type: 'web_app', text: 'Бухгалтерія', web_app: { url } },
        }).catch(() => {});
      }
    }
  };
  if (config.useWebhook && config.webAppUrl) {
    await bot.api.setWebhook(`${config.webAppUrl}/tg/webhook`);
    console.log('Webhook set', config.webAppUrl);
  } else if (config.runPolling) {
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
  } else {
    console.log('Bot idle locally — production webhook kept. RUN_POLLING=1 to poll.');
  }
  setup().catch((e) => console.error('bot setup', e.message || e));
}

/** Планувальник: щохвилини перевіряє, чи настав час для кожної задачі (у часовому поясі компанії). */
export function scheduleJobs() {
  const once = (key, stamp) => {
    if (getSetting(key) === stamp) return false;
    setSetting(key, stamp);
    return true;
  };
  const tick = async () => {
    const now = new Date();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: config.timezone, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    }).formatToParts(now).map((p) => [p.type, p.value]));
    const h = Number(parts.hour) % 24;
    const m = Number(parts.minute);
    const day = today();

    // курси НБУ — щодня з 10:00 (і одразу після старту, якщо сьогодні ще не оновлювали)
    if (getSetting('rates_day') !== day && (!scheduleJobs.ratesTried || m % 30 === 0)) {
      scheduleJobs.ratesTried = true;
      try { await dailyRates(); } catch (e) { console.warn('rates', e.message || e); }
    }

    // регулярні платежі — щодня з 9:00
    let created = [];
    if (h >= 9 && once('last_recurring', day)) {
      const { runRecurring } = await import('./services/finance.js');
      try { created = runRecurring(); } catch (e) { console.warn('recurring', e.message || e); }
    }

    // ранковий дайджест + борги + податки — о 9:00
    if (h === 9 && m < 15 && getSetting('daily_digest') === '1' && once('last_digest', day)) {
      const d = dashboard({ role: 'admin', id: 0 });
      if (!d.limited) {
        await notifyAdmins('🗓 <b>Ранковий дайджест</b>\n\n' + monthCard(d) + (created.length ? `\n\n🔁 Створено регулярних: ${created.length}` : ''), { silent: true });
      }
      const overdue = debts().filter((x) => x.overdue_days > 0 && [1, 3, 7, 14, 30].includes(x.overdue_days));
      for (const x of overdue) {
        await notifyAdmins(`🔴 <b>Прострочена оплата</b>\n${esc(x.client_name || '')} · ${esc(x.project_name)}\nЗалишок: <b>${fmt(x.left, x.currency)}</b> (${x.overdue_days} дн.)`, {
          reply_markup: new InlineKeyboard().text('📨 Текст нагадування', `rem:${x.project_id}`),
        });
      }
      const t = taxes();
      for (const i of t.enabled ? t.items : []) {
        if (!i.paid && [7, 3, 1].includes(i.days_left)) {
          await notifyAdmins(`🧾 Через ${i.days_left} дн. (${i.due}) сплатити: <b>${esc(i.title)}</b> — ${fmt(i.amount, 'UAH')}`);
        }
      }
    }

    // задачі, що горять, — кожному о 9:00
    if (h === 9 && m < 15 && once('last_task_digest', day) && bot) {
      for (const p of all("SELECT * FROM users WHERE status = 'active' AND notify = 1 AND tg_id IS NOT NULL")) {
        const rows = dueDigest(p.id, day);
        if (!rows.length) continue;
        const kb = new InlineKeyboard();
        rows.slice(0, 8).forEach((x) => kb.text(`✅ ${(x.title || 'Без назви').slice(0, 30)}`, `tk:done:${x.id}`).row());
        await bot.api.sendMessage(p.tg_id, `☀️ <b>Задачі на сьогодні</b>\n\n${rows.map((x) => esc(taskLine(x))).join('\n')}`, { parse_mode: 'HTML', reply_markup: kb, disable_notification: true }).catch(() => {});
      }
    }

    // тижневий звіт — пʼятниця 18:00
    if (parts.weekday === 'Fri' && h === 18 && m < 15 && once('last_weekly', day)) {
      await notifyAdmins(weeklyReport(day));
    }

    // бекап бази — щодня о 23:30 адмінам у чат
    if (h === 23 && m >= 30 && once('last_backup', day) && bot) {
      try {
        const { buffer, filename } = makeBackup();
        const admins = all("SELECT tg_id FROM users WHERE role='admin' AND status='active' AND tg_id IS NOT NULL");
        for (const a of admins) {
          await bot.api.sendDocument(a.tg_id, new InputFile(buffer, filename), { caption: '💾 Щоденна резервна копія бази', disable_notification: true }).catch(() => {});
        }
      } catch (e) {
        console.warn('backup', e.message || e);
      }
    }

    // Monobank без вебхука — підтягуємо виписку раз на 30 хв
    if (monoEnabled() && !getSetting('mono_webhook_url') && m % 30 === 0 && once('last_mono_poll', `${day}-${h}-${m}`)) {
      syncMono(1).then((r) => r.created.length && notifyAdmins(`🏦 Monobank: нових операцій — ${r.created.length}`)).catch((e) => console.warn('mono', e.message || e));
    }
  };
  let busy = false;
  const run = () => {
    if (busy) return;
    busy = true;
    tick().catch((e) => console.warn('tick', e.message || e)).finally(() => { busy = false; });
  };
  setTimeout(run, 5000);
  setInterval(run, 60_000);
}
