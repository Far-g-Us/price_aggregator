// Чистка промежуточных каталогов сборки.
//
//   npm run clean
//
// Что убирается: .build-staging (промежуточная распаковка Electron, до
// 400 МБ), build-renderer и dist-electron (сборки renderer и main/preload).
// НЕ убирается: dist/ (там собранные установщик и portable — их релиз),
// .cache/electron (локальная копия zip Electron на 150 МБ: качать заново
// неприятно, а сборка без сети не идёт), node_modules.
//
// Если dist/ не нужен — удалите и его руками.
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TARGETS = ['.build-staging', 'build-renderer', 'dist-electron'];

for (const name of TARGETS) {
  const path = resolve(ROOT, name);
  rmSync(path, { recursive: true, force: true });
  process.stdout.write(`clean: удалён ${name}\n`);
}
process.stdout.write('clean: dist/ и .cache/ оставлены (артефакты релиза и локальный zip Electron)\n');
