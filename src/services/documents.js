/**
 * Рахунок-фактура та акт наданих послуг у PDF (кирилиця — шрифт DejaVu з assets/fonts).
 */
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { ROOT } from '../config.js';
import { all, get, getSetting, run, setSetting } from '../db.js';
import { HttpError, today } from './finance.js';
import { fmt } from './money.js';

const FONT = path.join(ROOT, 'assets', 'fonts', 'DejaVuSans.ttf');
const FONT_B = path.join(ROOT, 'assets', 'fonts', 'DejaVuSans-Bold.ttf');

export const REQUISITE_KEYS = ['legal_name', 'legal_code', 'iban', 'bank', 'address', 'signer', 'tax_note'];

export function requisites() {
  const r = {};
  for (const k of REQUISITE_KEYS) r[k] = getSetting(`req_${k}`, '') || '';
  if (!r.tax_note) r.tax_note = 'Без ПДВ. Платник єдиного податку.';
  return r;
}
export function saveRequisites(b) {
  for (const k of REQUISITE_KEYS) if (b[k] !== undefined) setSetting(`req_${k}`, String(b[k] || '').slice(0, 300));
  return requisites();
}

function nextNumber(kind, date) {
  const y = date.slice(0, 4);
  const key = `doc_seq_${kind}_${y}`;
  const n = Number(getSetting(key, '0')) + 1;
  setSetting(key, String(n));
  return `${kind === 'invoice' ? 'РФ' : 'АКТ'}-${y}-${String(n).padStart(3, '0')}`;
}

const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const longDate = (d) => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)} р.`;

const CUR_WORD = { UAH: 'грн', USD: 'дол. США', EUR: 'євро', USDT: 'USDT', PLN: 'злотих', GBP: 'фунтів' };
const plain = (minor) => (minor / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Створює документ у базі та повертає { doc, buffer }. */
export async function createDocument({ kind, project_id, amount, currency, description, date }, user) {
  if (!['invoice', 'act'].includes(kind)) throw new HttpError(400, 'Тип документа: invoice або act');
  const project = project_id ? get('SELECT * FROM projects WHERE id = ?', Number(project_id)) : null;
  if (project_id && !project) throw new HttpError(404, 'Проєкт не знайдено');
  const amt = Math.round(Number(amount) || 0) || project?.budget || 0;
  if (!(amt > 0)) throw new HttpError(400, 'Вкажіть суму');
  const cur = currency || project?.currency || 'UAH';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : today();
  const number = nextNumber(kind, d);
  const desc = String(description || (project ? `Послуги за проєктом «${project.name}»` : 'Послуги з розробки')).slice(0, 500);
  const r = run(
    'INSERT INTO documents(kind, number, project_id, client_id, date, amount, currency, description, created_by) VALUES(?,?,?,?,?,?,?,?,?)',
    kind, number, project?.id || null, project?.client_id || null, d, amt, cur, desc, user?.id || null,
  );
  const doc = get('SELECT * FROM documents WHERE id = ?', Number(r.lastInsertRowid));
  return { doc, buffer: await renderDocument(doc) };
}

export function listDocuments(projectId) {
  return all(
    `SELECT d.*, cl.name AS client_name, p.name AS project_name FROM documents d
     LEFT JOIN clients cl ON cl.id = d.client_id LEFT JOIN projects p ON p.id = d.project_id
     ${projectId ? 'WHERE d.project_id = ?' : ''} ORDER BY d.id DESC LIMIT 100`,
    ...(projectId ? [projectId] : []),
  );
}

export function renderDocument(doc) {
  const req = requisites();
  const company = req.legal_name || getSetting('company_name') || 'King Kong Lab';
  const client = doc.client_id ? get('SELECT * FROM clients WHERE id = ?', doc.client_id) : null;
  const isInvoice = doc.kind === 'invoice';

  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `${isInvoice ? 'Рахунок' : 'Акт'} ${doc.number}` } });
    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.registerFont('R', FONT);
    pdf.registerFont('B', FONT_B);

    const W = pdf.page.width - 100;
    pdf.font('B').fontSize(18).text(isInvoice ? `Рахунок-фактура № ${doc.number}` : `Акт наданих послуг № ${doc.number}`);
    pdf.font('R').fontSize(10).fillColor('#555').text(`від ${longDate(doc.date)}`).moveDown(1.2);
    pdf.fillColor('#000');

    const party = (title, lines) => {
      pdf.font('B').fontSize(10).text(title);
      pdf.font('R').fontSize(10);
      for (const l of lines.filter(Boolean)) pdf.text(l);
      pdf.moveDown(0.8);
    };
    party(isInvoice ? 'Постачальник:' : 'Виконавець:', [
      company,
      req.legal_code && `ІПН / ЄДРПОУ: ${req.legal_code}`,
      req.iban && `IBAN: ${req.iban}`,
      req.bank && `Банк: ${req.bank}`,
      req.address && `Адреса: ${req.address}`,
    ]);
    party(isInvoice ? 'Платник:' : 'Замовник:', [
      client?.legal_name || client?.name || '—',
      client?.legal_code && `Код: ${client.legal_code}`,
      client?.address && `Адреса: ${client.address}`,
      client?.email && `Email: ${client.email}`,
    ]);

    // таблиця
    const top = pdf.y + 4;
    const cols = [30, W - 30 - 60 - 100 - 100, 60, 100, 100];
    const xs = cols.reduce((acc, w, i) => [...acc, acc[i] + w], [50]);
    const head = ['№', 'Найменування послуги', 'К-сть', 'Ціна', 'Сума'];
    pdf.rect(50, top, W, 22).fill('#EEF1FF');
    pdf.fillColor('#000').font('B').fontSize(9);
    head.forEach((h, i) => pdf.text(h, xs[i] + 4, top + 7, { width: cols[i] - 8, align: i >= 2 ? 'right' : 'left' }));
    pdf.font('R').fontSize(10);
    const rowTop = top + 28;
    const descH = pdf.heightOfString(doc.description, { width: cols[1] - 8 });
    const cells = ['1', doc.description, '1', plain(doc.amount), plain(doc.amount)];
    cells.forEach((c, i) => pdf.text(c, xs[i] + 4, rowTop, { width: cols[i] - 8, align: i >= 2 ? 'right' : 'left' }));
    const after = rowTop + Math.max(16, descH) + 8;
    pdf.moveTo(50, after).lineTo(50 + W, after).strokeColor('#CCD').stroke();

    pdf.font('B').fontSize(11).text(`Разом: ${fmt(doc.amount, doc.currency)}`, 50, after + 10, { width: W, align: 'right' });
    pdf.font('R').fontSize(9).fillColor('#555').text(req.tax_note, 50, pdf.y + 2, { width: W, align: 'right' });
    pdf.fillColor('#000').moveDown(1.5);
    pdf.font('R').fontSize(10).text(`Всього на суму: ${plain(doc.amount)} ${CUR_WORD[doc.currency] || doc.currency}.`, 50);

    if (!isInvoice) {
      pdf.moveDown(0.8).text('Вищезазначені послуги надані повністю та в строк. Замовник претензій щодо обсягу, якості та строків надання послуг не має.', { width: W });
    } else {
      pdf.moveDown(0.8).text(`Призначення платежу: оплата за рахунком № ${doc.number} від ${doc.date}.`, { width: W });
    }

    pdf.moveDown(3);
    const y = pdf.y;
    pdf.font('B').text(isInvoice ? 'Постачальник' : 'Виконавець', 50, y);
    pdf.font('R').text(`____________________ ${req.signer || ''}`, 50, y + 18);
    if (!isInvoice) {
      pdf.font('B').text('Замовник', 50 + W / 2, y);
      pdf.font('R').text('____________________', 50 + W / 2, y + 18);
    }
    pdf.end();
  });
}
