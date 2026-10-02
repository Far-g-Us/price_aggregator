import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Корень репозитория ищем от своего же файла, а не от process.cwd(): запуск из
// чужого каталога не должен собирать чужое и не должен падать.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Чистим выходной каталог: tsc не удаляет файлы, которых больше нет в исходниках.
// После переезда каталогов (src/main -> src/core) в electron-builder уехали бы
// оба дерева, и в exe попал бы мёртвый код.
fs.rmSync(path.join(root, 'dist-electron'), { recursive: true, force: true });

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', cwd: root, shell: true });
}

run('npx tsc -p tsconfig.electron.json');
run(
  'npx tsc electron/preload.ts --ignoreConfig --module commonjs --target es2020 --moduleResolution bundler --outDir dist-electron-cjs --rootDir . --skipLibCheck --esModuleInterop',
);
fs.copyFileSync(
  path.join(root, 'dist-electron-cjs/electron/preload.js'),
  path.join(root, 'dist-electron/electron/preload.cjs'),
);
fs.rmSync(path.join(root, 'dist-electron-cjs'), { recursive: true, force: true });
const stale = path.join(root, 'dist-electron/electron/preload.js');
if (fs.existsSync(stale)) fs.rmSync(stale);
console.log('electron built: main ESM + preload.cjs');
