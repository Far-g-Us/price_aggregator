// Сборка exe с обходом EPERM на переименовании win-unpacked.tmp.
//
// Что происходит: electron-builder распаковывает Electron в `dist/win-unpacked.tmp`
// и сразу переименовывает каталог в `win-unpacked`. На этой машине переименование
// падает с EPERM (операция не разрешена), хотя файлы внутри удаляются, `Move-Item`
// на том же каталоге проходит, а `node:fs.rename` на только что созданных
// каталогах работает. Держатель дескрипторов не найден: процессов 7za/7z,
// Explorer или антивируса, открывших этот путь, нет; Malwarebytes в списке
// установленных, но RTCore64/WinDivert — сетевые драйверы, а не файловый
// фильтр этого каталога (проверено переименованием 410 МБ exe рядом — мгновенно).
// Воспроизводится 4 попытки подряд, во временный каталог сборка проходит с
// первого раза.
//
// Решение: собирать во временный каталог (его система фильтрует иначе) и
// переносить готовые файлы в dist. Артефакты те же, но разложены по папкам:
// `dist/setup/` — установщик, его blockmap и `latest.yml` (это то, что едет на
// GitHub Releases), `dist/portable/` — портативный exe, который в
// автообновлении не участвует. Папки очищаются перед переносом, иначе рядом
// с новой версией остаётся предыдущая.
//
// Что НЕ делаем: не отключаем проверки безопасности, не добавляем исключения и
// не правим антивирус. Скрипт не трогает ничего, кроме своей рабочей папки.

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, copyFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const distDir = resolve(process.cwd(), 'dist');
// Каталог сборки внутри %TEMP%: и electron-builder, и система не держат его
// дольше одной операции, поэтому переименование win-unpacked проходит.
const staging = mkdtempSync(join(tmpdir(), 'pa-build-'));

function run(cmd, cmdArgs) {
  return new Promise((done, fail) => {
    const child = spawn(cmd, cmdArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`${cmd} → код ${code}`))));
    child.on('error', fail);
  });
}

try {
  console.log(`[build-exe] промежуточная сборка: ${staging}`);
  await run('npx', ['electron-builder', ...args, `--config.directories.output=${staging}`]);

  mkdirSync(distDir, { recursive: true });
  const setupDir = join(distDir, 'setup');
  const portableDir = join(distDir, 'portable');
  rmSync(setupDir, { recursive: true, force: true });
  rmSync(portableDir, { recursive: true, force: true });
  mkdirSync(setupDir, { recursive: true });
  mkdirSync(portableDir, { recursive: true });

  const produced = readdirSync(staging, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  if (produced.length === 0) throw new Error('electron-builder не создал ни одного файла');
  for (const name of produced) {
    // builder-debug.yml — внутренний дамп electron-builder (раскрытые пути и
    // шаблоны NSIS). В dist ему не место: там лежат артефакты, которые
    // выкладывают в релиз. Нужен он только при разборе сборки, и то через
    // DEBUG=electron-builder, который пишет в консоль.
    if (name === 'builder-debug.yml') continue;
    const target = name.includes('-portable.') ? portableDir : setupDir;
    copyFileSync(join(staging, name), join(target, name));
    console.log(`[build-exe] ${target === distDir ? 'dist' : target.slice(distDir.length + 1)}: ${name}`);
  }
  console.log(`[build-exe] готово, файлов перенесено: ${produced.length}`);
} finally {
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
}