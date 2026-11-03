/**
 * «Чистий лист» з початку місяця: усе, що було до дати старту, ховається в архів (не видаляється).
 * - операції до дати старту (і операції архівних проєктів) → прибрані зі звітів, балансів і списків;
 * - проєкти, що почалися до дати старту → статус 'archived' (попередній статус зберігається);
 * - залишки рахунків стартують з нуля (старі значення зберігаються для відкату).
 * Задачі та сторінки не чіпаємо. Усе можна повернути — undoFreshStart().
 */
import { all, db, get, getSetting, run, setSetting, tx } from '../db.js';
import { HttpError, audit, today } from './finance.js';

function addColumn(table, col, ddl) {
  const cols = all(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumn('transactions', 'archived_at', 'archived_at TEXT');
addColumn('projects', 'archived_status', 'archived_status TEXT');

export const ledgerStart = () => getSetting('ledger_start') || null;

export function freshState() {
  const start = ledgerStart();
  return {
    start,
    archived_tx: get('SELECT COUNT(*) AS n FROM transactions WHERE archived_at IS NOT NULL').n,
    archived_projects: get("SELECT COUNT(*) AS n FROM projects WHERE status = 'archived'").n,
    suggest: `${today().slice(0, 7)}-01`,
  };
}

export function freshStart(date, user) {
  const start = String(date || `${today().slice(0, 7)}-01`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new HttpError(400, 'Дата має бути у форматі РРРР-ММ-ДД');
  if (start > today()) throw new HttpError(400, 'Дата старту не може бути в майбутньому');
  return tx(() => {
    // проєкти, що почалися до старту (або без дати, створені до старту)
    const projects = all(`SELECT id FROM projects WHERE status NOT IN ('cancelled','archived')
      AND COALESCE(start_date, substr(created_at, 1, 10)) < ?`, start).map((p) => p.id);
    for (const id of projects) run("UPDATE projects SET archived_status = status, status = 'archived' WHERE id = ?", id);
    // операції до старту + усі операції архівних проєктів (напр. заплановані оплати старих угод)
    const txs = run(`UPDATE transactions SET deleted_at = datetime('now'), archived_at = datetime('now')
      WHERE deleted_at IS NULL AND (date < ? OR project_id IN (SELECT id FROM projects WHERE status = 'archived'))`, start).changes;
    // залишки рахунків — з нуля; старі зберігаємо, якщо ще не зберігали
    if (!getSetting('fresh_initial_balances')) {
      setSetting('fresh_initial_balances', JSON.stringify(all('SELECT id, initial_balance FROM accounts')));
    }
    run('UPDATE accounts SET initial_balance = 0');
    setSetting('ledger_start', start);
    audit(user?.id, 'fresh_start', 'ledger', null, { start, projects: projects.length, transactions: txs });
    return { start, projects: projects.length, transactions: Number(txs) };
  });
}

export function undoFreshStart(user) {
  if (!ledgerStart()) throw new HttpError(400, 'Чистий лист ще не вмикали');
  return tx(() => {
    const txs = run('UPDATE transactions SET deleted_at = NULL, archived_at = NULL WHERE archived_at IS NOT NULL').changes;
    const projects = run("UPDATE projects SET status = COALESCE(archived_status, 'active'), archived_status = NULL WHERE status = 'archived'").changes;
    try {
      for (const a of JSON.parse(getSetting('fresh_initial_balances') || '[]')) run('UPDATE accounts SET initial_balance = ? WHERE id = ?', a.initial_balance, a.id);
    } catch {}
    run("DELETE FROM settings WHERE key IN ('ledger_start', 'fresh_initial_balances')");
    audit(user?.id, 'fresh_undo', 'ledger', null, { projects, transactions: txs });
    return { projects: Number(projects), transactions: Number(txs) };
  });
}

/** Сховати проєкт і його операції в архів (напр. старий рядок із Google-таблиці після «чистого листа»). */
export function archiveProject(projectId) {
  run("UPDATE projects SET archived_status = COALESCE(archived_status, status), status = 'archived' WHERE id = ?", projectId);
  run("UPDATE transactions SET deleted_at = datetime('now'), archived_at = datetime('now') WHERE project_id = ? AND deleted_at IS NULL", projectId);
}
export const isBeforeStart = (date) => Boolean(ledgerStart() && (date || '9999') < ledgerStart());
