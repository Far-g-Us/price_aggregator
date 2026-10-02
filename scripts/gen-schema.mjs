// Схема БД — единственный источник правды, и она обязана попадать в сборку.
// tsc не копирует .sql, а build.files перечисляет только dist/ и dist-electron/,
// поэтому раньше схема читалась с диска рядом с бандлом и в собранном
// приложении её просто не было: openDb падал, вызовы глотал catch, и
// приложение работало без БД. Теперь схема — обычный TS-модуль.
//
//   node scripts/gen-schema.mjs          # перегенерировать src/core/db/schema.ts
//   node scripts/gen-schema.mjs --check  # ничего не писать, упасть если разошлись
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Пути от своего файла, а не от process.cwd(): запуск из любого каталога
// должен работать одинаково.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src/core/db/schema.sql');
const out = path.join(root, 'src/core/db/schema.ts');
const check = process.argv.includes('--check');

const sql = fs.readFileSync(src, 'utf-8');
const header = '// СГЕНЕРИРОВАНО из schema.sql — правь schema.sql, потом `npm run gen:schema`.\n';
const next = `${header}export const SCHEMA = ${JSON.stringify(sql)};\n`;

if (check) {
  if (!fs.existsSync(out)) {
    console.error('schema.ts отсутствует — запусти npm run gen:schema');
    process.exit(1);
  }
  if (fs.readFileSync(out, 'utf-8') !== next) {
    console.error('schema.ts разошёлся с schema.sql — запусти npm run gen:schema');
    process.exit(1);
  }
  console.log('schema.ts актуален');
} else {
  fs.writeFileSync(out, next, 'utf-8');
  console.log(`schema.ts сгенерирован (${sql.length} байт SQL)`);
}
