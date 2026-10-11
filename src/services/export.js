import ExcelJS from 'exceljs';
import { config } from '../config.js';
import { balances, listTx, pnl, projects, team } from './finance.js';
import { fromMinor } from './money.js';

const TYPE = { income: 'Дохід', expense: 'Витрата', transfer: 'Переказ' };
const STATUS = { done: 'Проведено', planned: 'Заплановано', pending: 'На перевірці', rejected: 'Відхилено' };
const PROJECT_STATUS = { lead: 'Лід', active: 'В роботі', paused: 'Пауза', done: 'Завершено', cancelled: 'Скасовано' };

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2A1F6E' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };
const MONEY = '#,##0.00';

function styleSheet(ws) {
  const h = ws.getRow(1);
  h.font = HEADER_FONT;
  h.fill = HEADER_FILL;
  h.alignment = { vertical: 'middle' };
  h.height = 22;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

export async function buildWorkbook({ from, to, user }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = config.companyName;
  wb.created = new Date();

  const { rows } = listTx({ from, to, limit: 100000 }, user);
  const ws = wb.addWorksheet('Операції');
  ws.columns = [
    { header: 'ID', key: 'id', width: 7 },
    { header: 'Дата', key: 'date', width: 12 },
    { header: 'Тип', key: 'type', width: 10 },
    { header: 'Статус', key: 'status', width: 13 },
    { header: 'Сума', key: 'amount', width: 14, style: { numFmt: MONEY } },
    { header: 'Валюта', key: 'currency', width: 8 },
    { header: 'Сума (база)', key: 'base', width: 14, style: { numFmt: MONEY } },
    { header: 'Рахунок', key: 'account', width: 20 },
    { header: 'На рахунок', key: 'to_account', width: 20 },
    { header: 'Категорія', key: 'category', width: 24 },
    { header: 'Проєкт', key: 'project', width: 22 },
    { header: 'Клієнт', key: 'client', width: 20 },
    { header: 'Член команди', key: 'member', width: 18 },
    { header: 'Коментар', key: 'comment', width: 40 },
    { header: 'Додав', key: 'created_by', width: 16 },
  ];
  for (const t of rows) {
    const row = ws.addRow({
      id: t.id,
      date: t.date,
      type: TYPE[t.type],
      status: STATUS[t.status],
      amount: fromMinor(t.type === 'expense' ? -t.amount : t.amount),
      currency: t.currency,
      base: fromMinor(t.type === 'expense' ? -t.amount_base : t.type === 'transfer' ? 0 : t.amount_base),
      account: t.account_name,
      to_account: t.to_account_name || '',
      category: t.category_name || '',
      project: t.project_name || '',
      client: t.client_name || '',
      member: t.member_name || '',
      comment: t.comment || '',
      created_by: t.created_by_name || '',
    });
    const color = t.type === 'income' ? 'FF15803D' : t.type === 'expense' ? 'FFB91C1C' : 'FF475569';
    row.getCell('amount').font = { color: { argb: color }, bold: true };
  }
  styleSheet(ws);

  const bal = balances();
  const wb2 = wb.addWorksheet('Рахунки');
  wb2.columns = [
    { header: 'Рахунок', key: 'name', width: 26 },
    { header: 'Валюта', key: 'currency', width: 9 },
    { header: 'Баланс', key: 'balance', width: 16, style: { numFmt: MONEY } },
    { header: `Баланс (${bal.base})`, key: 'base', width: 16, style: { numFmt: MONEY } },
  ];
  for (const a of bal.accounts) wb2.addRow({ name: `${a.emoji} ${a.name}`, currency: a.currency, balance: fromMinor(a.balance), base: fromMinor(a.balance_base) });
  const totalRow = wb2.addRow({ name: 'РАЗОМ', base: fromMinor(bal.total) });
  totalRow.font = { bold: true };
  styleSheet(wb2);

  const year = Number((to || from || new Date().toISOString()).slice(0, 4));
  const p = pnl(year);
  const ws3 = wb.addWorksheet(`P&L ${year}`);
  ws3.columns = [{ header: 'Стаття', key: 'name', width: 30 }, ...p.months.map((m) => ({ header: m.slice(5), key: m, width: 12, style: { numFmt: MONEY } })), { header: 'Рік', key: 'total', width: 14, style: { numFmt: MONEY } }];
  const section = (title, data, argb) => {
    const r = ws3.addRow({ name: title, ...Object.fromEntries(p.months.map((m) => [m, fromMinor(data.totals[m])])), total: fromMinor(data.total) });
    r.font = { bold: true, color: { argb } };
    for (const c of data.categories) ws3.addRow({ name: `   ${c.emoji} ${c.name}`, ...Object.fromEntries(p.months.map((m) => [m, fromMinor(c.months[m])])), total: fromMinor(c.total) });
  };
  section('ДОХОДИ', p.income, 'FF15803D');
  section('ВИТРАТИ', p.expense, 'FFB91C1C');
  const pr = ws3.addRow({ name: 'ПРИБУТОК', ...Object.fromEntries(p.months.map((m) => [m, fromMinor(p.profit[m])])), total: fromMinor(p.total) });
  pr.font = { bold: true };
  pr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE9FE' } };
  styleSheet(ws3);

  const ws4 = wb.addWorksheet('Проєкти');
  ws4.columns = [
    { header: 'Проєкт', key: 'name', width: 26 },
    { header: 'Клієнт', key: 'client', width: 20 },
    { header: 'Статус', key: 'status', width: 12 },
    { header: 'Бюджет', key: 'budget', width: 12, style: { numFmt: MONEY } },
    { header: 'Валюта', key: 'currency', width: 8 },
    { header: `Отримано (${p.base})`, key: 'income', width: 15, style: { numFmt: MONEY } },
    { header: `Витрати (${p.base})`, key: 'expense', width: 15, style: { numFmt: MONEY } },
    { header: `Прибуток (${p.base})`, key: 'profit', width: 15, style: { numFmt: MONEY } },
    { header: `Борг клієнта (${p.base})`, key: 'debt', width: 17, style: { numFmt: MONEY } },
    { header: 'Дедлайн', key: 'deadline', width: 12 },
  ];
  for (const x of projects()) {
    ws4.addRow({
      name: x.name, client: x.client_name || '', status: PROJECT_STATUS[x.status] || x.status, budget: fromMinor(x.budget), currency: x.currency,
      income: fromMinor(x.income_base), expense: fromMinor(x.expense_base), profit: fromMinor(x.profit_base), debt: fromMinor(Math.max(0, x.debt_base)), deadline: x.deadline || '',
    });
  }
  styleSheet(ws4);

  const ws5 = wb.addWorksheet('Команда');
  ws5.columns = [
    { header: "Ім'я", key: 'name', width: 22 },
    { header: 'Посада', key: 'position', width: 20 },
    { header: `Виплачено за період (${p.base})`, key: 'paid', width: 24, style: { numFmt: MONEY } },
    { header: 'Остання виплата', key: 'last', width: 16 },
  ];
  for (const m of team(from || '0000-01-01', to || '9999-12-31')) ws5.addRow({ name: m.name, position: m.position || '', paid: fromMinor(m.paid_base), last: m.last_payout || '' });
  styleSheet(ws5);

  return wb.xlsx.writeBuffer();
}
