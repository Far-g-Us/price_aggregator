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
// Решение: собирать в отдельный промежуточный каталог и переносить готовые
// файлы в dist. Артефакты те же, но разложены по папкам:
// `dist/setup/` — установщик, его blockmap и `latest.yml` (это то, что едет на
// GitHub Releases), `dist/portable/` — портативный exe, который в
// автообновлении не участвует. Папки очищаются перед переносом, иначе рядом
// с новой версией остаётся предыдущая.
//
// Каталог промежуточной сборки — внутри проекта (`.build-staging`), НЕ в
// `%TEMP%`: там накапливались копии по 400 МБ, которые приходилось вычищать
// вручную. Переименование `win-unpacked.tmp` работает и в каталоге проекта —
// EPERM воспроизводился только на `dist/` рядом с уже распакованной прошлой
// сборкой; если вдруг вернётся, скрипт падает с понятным текстом, и тогда
// вернуть `%TEMP%` — одна правка `stagingDir`.
//
// Что НЕ делаем: не отключаем проверки безопасности, не добавляем исключения и
// не правим антивирус. Скрипт не трогает ничего, кроме своей рабочей папки.

import { spawn } from 'node:child_process';
import { existsSync, copyFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
// ELECTRON_DIST — путь к локальному zip/каталогу Electron. Нужен, когда сеть до
// github.com рвётся: @electron/get сначала качает SHASUMS256.txt для сверки,
// и его ETIMEDOUT читается как «артефакт из кэша не сошёлся», после чего
// перекачивается и сам zip — падает уже он, а сеть может не подняться до конца
// сборки. С локальным файлом сверки нет вовсе, и сборка идёт офлайн.
// Аргумент повторяет electronDist electron-builder, поэтому лишних копий zip
// и распаковки в проект не попадает.
// env — запасной путь: явный --config.electronDist в аргументах главнее.
if (process.env.ELECTRON_DIST && !args.some((a) => a.startsWith('--config.electronDist'))) {
  args.push(`--config.electronDist=${process.env.ELECTRON_DIST}`);
}
const distDir = resolve(process.cwd(), 'dist');
// Каталог промежуточной сборки по умолчанию — внутри проекта, НЕ в `%TEMP%`:
// там накапливались копии по 400 МБ, которые приходилось вычищать вручную.
// Но EPERM на переименовании `win-unpacked.tmp` периодически возвращается и в
// каталоге проекта (проверено 2026-11-11, три попытки подряд), а во временном
// каталоге он не воспроизводится — ровно то, что описано в шапке файла. Поэтому
// путь переопределяется переменной:
//   $env:BUILD_STAGING_DIR = $env:TEMP
// Каталог убирается в finally при любом исходе, так что мусор не остаётся ни там,
// ни в проекте.
// Каталог промежуточной сборки по умолчанию — внутри проекта, НЕ в `%TEMP%`:
// там накапливались копии по 400 МБ, которые приходилось вычищать вручную. Но
// EPERM на переименовании `win-unpacked.tmp` периодически возвращается и в
// каталоге проекта (проверено 2026-11-11, три попытки подряд), а во временном
// каталоге он не воспроизводится — ровно то, что описано в шапке файла. Поэтому
// путь переопределяется переменной:
//   $env:BUILD_STAGING_DIR = $env:TEMP
// Каталог убирается в finally при любом исходе, так что мусор не остаётся ни там,
// ни в проекте.
const stagingDir = process.env.BUILD_STAGING_DIR
  ? resolve(process.env.BUILD_STAGING_DIR, 'price-aggregator-staging')
  : resolve(process.cwd(), '.build-staging');
// Сначала каталог убираем целиком, иначе после упавшей сборки там остаётся
// half-unpacked Electron на 400 МБ.
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

function run(cmd, cmdArgs) {
  return new Promise((done, fail) => {
    const child = spawn(cmd, cmdArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`${cmd} → код ${code}`))));
    child.on('error', fail);
  });
}

try {
console.log(`[build-exe] промежуточная сборка: ${stagingDir}`);
  await run('npx', ['electron-builder', ...args, `--config.directories.output=${stagingDir}`]);

  mkdirSync(distDir, { recursive: true });
  const setupDir = join(distDir, 'setup');
  const portableDir = join(distDir, 'portable');
  rmSync(setupDir, { recursive: true, force: true });
  rmSync(portableDir, { recursive: true, force: true });
  mkdirSync(setupDir, { recursive: true });
  mkdirSync(portableDir, { recursive: true });

  const produced = readdirSync(stagingDir, { withFileTypes: true })
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
    copyFileSync(join(stagingDir, name), join(target, name));
    console.log(`[build-exe] ${target === distDir ? 'dist' : target.slice(distDir.length + 1)}: ${name}`);
  }
  console.log(`[build-exe] готово, файлов перенесено: ${produced.length}`);
} finally {
  // Промежуточная папка с 400 МБ распакованного Electron не остаётся в проекте.
  if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
}