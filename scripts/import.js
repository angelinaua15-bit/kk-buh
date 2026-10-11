/**
 * Імпорт старої таблиці (xlsx / csv) у KK-Buh.
 *
 *   npm run import -- /path/to/KKLab.xlsx
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/db.js';
import { importBuffer } from '../src/services/importSheet.js';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('Вкажи файл: npm run import -- ./KKLab.xlsx');
  process.exit(1);
}

const buf = fs.readFileSync(file);
const result = await importBuffer(buf, path.basename(file), { id: null, role: 'admin' });
for (const s of result.sheets) {
  if (s.skipped) console.log(`аркуш «${s.name}»: пропущено (${s.reason})`);
  else console.log(`аркуш «${s.name}»: ${s.rows} рядків, імпорт ${s.imported}, пропуск ${s.skipped}`);
}
console.log(`Готово: імпортовано ${result.imported}, пропущено ${result.skipped}. База: ${path.resolve(process.env.DB_PATH || 'data/kkbuh.sqlite')}`);
db.close();
