/**
 * King Kong Lab · синхронізація Google-таблиці з ботом бухгалтерії.
 *
 * Як підключити (один раз):
 *  1. У таблиці: Розширення → Apps Script. Видаліть усе з Code.gs і вставте цей файл. Збережіть.
 *  2. Оновіть сторінку таблиці. Зʼявиться меню «🦍 KK Бот» → «Налаштувати».
 *  3. Вкажіть адресу бота (наприклад https://kk-buh.up.railway.app) і токен SHEET_SYNC_TOKEN з сервера.
 *  4. Дозвольте доступ, коли Google попросить.
 *
 * Що відбувається:
 *  • Аркуші «Операції (бот)» і «Проєкти (бот)» заповнюються даними з бота й оновлюються кожні 10 хв.
 *  • Змінюєте рядок у таблиці — він одразу зберігається в боті (і назад підставляються ID та суми в базі).
 *  • Новий рядок без ID — нова операція/проєкт. Видалити операцію: меню «🦍 KK Бот» → «Видалити виділені операції».
 *  • Сірі колонки рахуються ботом автоматично — їх не редагуйте.
 */

const SHEETS = { operations: 'Операції (бот)', projects: 'Проєкти (бот)' };

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🦍 KK Бот')
    .addItem('Оновити з бота', 'pullAll')
    .addItem('Видалити виділені операції', 'deleteSelected')
    .addSeparator()
    .addItem('Налаштувати', 'setup')
    .addToUi();
}

function props_() { return PropertiesService.getDocumentProperties(); }

function setup() {
  const ui = SpreadsheetApp.getUi();
  const url = ui.prompt('Адреса бота', 'Наприклад: https://kk-buh.up.railway.app', ui.ButtonSet.OK_CANCEL);
  if (url.getSelectedButton() !== ui.Button.OK) return;
  const token = ui.prompt('Токен синхронізації', 'Значення SHEET_SYNC_TOKEN з налаштувань сервера', ui.ButtonSet.OK_CANCEL);
  if (token.getSelectedButton() !== ui.Button.OK) return;
  props_().setProperties({ url: url.getResponseText().trim().replace(/\/$/, ''), token: token.getResponseText().trim() });
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onEditSync').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
  ScriptApp.newTrigger('pullAll').timeBased().everyMinutes(10).create();
  pullAll();
  ui.alert('Готово! Дані з бота завантажено, зміни в таблиці тепер зберігаються в боті.');
}

function call_(method, path, body) {
  const p = props_();
  const url = p.getProperty('url');
  if (!url) throw new Error('Спочатку: меню «🦍 KK Бот» → «Налаштувати»');
  const res = UrlFetchApp.fetch(url + path, {
    method: method,
    contentType: 'application/json',
    headers: { 'X-Sync-Token': p.getProperty('token') },
    payload: body ? JSON.stringify(body) : undefined,
    muteHttpExceptions: true,
  });
  const json = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() >= 300) throw new Error(json.error || ('HTTP ' + res.getResponseCode()));
  return json;
}

function pullAll() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(20000)) return;
  try {
    const data = call_('get', '/sync/export');
    writeSheet_(SHEETS.operations, data.operations, data.lists);
    writeSheet_(SHEETS.projects, data.projects, data.lists);
    props_().setProperty('last_pull', data.updated_at);
  } finally {
    lock.releaseLock();
  }
}

function writeSheet_(name, block, lists) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  const cols = block.columns;
  sh.clearContents();
  sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#1E3BFF').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  if (block.rows.length) sh.getRange(2, 1, block.rows.length, cols.length).setValues(block.rows);
  const n = Math.max(sh.getMaxRows() - 1, 1);
  // сірі — рахує бот; ID не чіпаємо
  cols.forEach((c, i) => {
    const r = sh.getRange(2, i + 1, n, 1);
    if (c === 'ID' || block.readonly.indexOf(c) >= 0) r.setBackground('#F1F3F8').setFontColor('#6B6E80');
    else r.setBackground(null).setFontColor(null);
  });
  const rule = (list) => SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(false).build();
  const set = (col, list) => { const i = cols.indexOf(col); if (i >= 0 && list && list.length) sh.getRange(2, i + 1, n, 1).setDataValidation(rule(list)); };
  if (name === SHEETS.operations) {
    set('Тип', lists.types); set('Статус', lists.statuses); set('Рахунок', lists.accounts); set('На рахунок', lists.accounts);
    set('Категорія', lists.categories); set('Виконавець', lists.members);
  } else {
    set('Статус', lists.project_statuses);
  }
}

function onEditSync(e) {
  const sh = e.range.getSheet();
  const key = Object.keys(SHEETS).find((k) => SHEETS[k] === sh.getName());
  if (!key || e.range.getRow() < 2) return;
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(20000)) return;
  try {
    const cols = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    for (let r = e.range.getRow(); r < e.range.getRow() + e.range.getNumRows(); r++) {
      const values = sh.getRange(r, 1, 1, cols.length).getValues()[0].map((v) => (v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : v));
      if (values.every((v) => v === '' || v === null)) continue;
      try {
        const res = call_('post', '/sync/row', { sheet: key, columns: cols, values: values });
        if (res.row) sh.getRange(r, 1, 1, res.row.length).setValues([res.row]);
        sh.getRange(r, 1).setNote(null);
      } catch (err) {
        sh.getRange(r, 1).setNote('⚠️ ' + err.message);
        SpreadsheetApp.getActive().toast(err.message, 'KK Бот: рядок ' + r + ' не збережено', 8);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function deleteSelected() {
  const sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== SHEETS.operations) return SpreadsheetApp.getUi().alert('Відкрийте аркуш «' + SHEETS.operations + '» і виділіть рядки.');
  const range = sh.getActiveRange();
  const ids = sh.getRange(range.getRow(), 1, range.getNumRows(), 1).getValues().map((r) => Number(r[0])).filter(Boolean);
  if (!ids.length) return;
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('Видалити операції: ' + ids.join(', ') + '?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  ids.forEach((id) => call_('post', '/sync/remove', { sheet: 'operations', id: id }));
  pullAll();
}
