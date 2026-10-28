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
import { existsSync, copyFileSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
// ELECTRON_DIST — путь к локальному zip/каталогу Electron. Нужен, когда сеть
// на github.com рвётся: @electron/get сначала качает SHASUMS256.txt для сверки,
// и его ETIMEDOUT читается как «артефакт из кэша не сошёлся», после чего
// перекачивается и сам zip — падает уже он, а сеть может не подняться до конца
// сборки. С локальным файлом сверки нет вовсе, и сборка идёт офлайн.
// Аргумент повторяет electronDist electron-builder, поэтому лишних копий zip
// и распаковки в проект не попадает.
// env — запасной путь: явный --config.electronDist в аргументах главнее.
//
// СВОЯ КОПИЯ ZIP (2026-10-19). electron-builder после распаковки удаляет zip
// из своего кэша, и каждая следующая сборка снова тянет ~150 МБ из сети.
// Поэтому копия хранится в `.cache/electron/` (каталог в .gitignore): сборка
// берёт её оттуда, и сеть нужна только при смене версии Electron.
const ELECTRON_CACHE = resolve(process.cwd(), '.cache', 'electron');
function electronVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'node_modules', 'electron', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}
function localElectronZip() {
  const version = electronVersion();
  if (!version) return null;
  const own = join(ELECTRON_CACHE, `electron-v${version}-win32-x64.zip`);
  if (existsSync(own)) return own;
  // Копия в системном кэше electron-builder: забираем и сохраняем у себя, чтобы
  // дальше не качать.
  const systemCache = join(process.env.LOCALAPPDATA ?? '', 'electron', 'Cache');
  if (!existsSync(systemCache)) return null;
  for (const dir of readdirSync(systemCache)) {
    const candidate = join(systemCache, dir, `electron-v${version}-win32-x64.zip`);
    if (!existsSync(candidate)) continue;
    mkdirSync(ELECTRON_CACHE, { recursive: true });
    copyFileSync(candidate, own);
    console.log(`[build-exe] electron zip сохранён локально: ${own}`);
    return own;
  }
  return null;
}
if (!args.some((a) => a.startsWith('--config.electronDist'))) {
  const local = process.env.ELECTRON_DIST || localElectronZip();
  if (local) args.push(`--config.electronDist=${local}`);
  else console.warn('[build-exe] локального zip Electron нет — сборка скачает его из сети');
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
// Исходный package.json хранится рядом: сборка дважды меняет его (в portable
// добавляется Firefox), и после ЛЮБОГО исхода — включая упавшую сборка —
// файл обязан вернуться в исходный вид.
const pkgPath = resolve(process.cwd(), 'package.json');
const pkgOriginal = readFileSync(pkgPath, 'utf8');
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
  mkdirSync(distDir, { recursive: true });
  const setupDir = join(distDir, 'setup');
  const portableDir = join(distDir, 'portable');
  rmSync(setupDir, { recursive: true, force: true });
  rmSync(portableDir, { recursive: true, force: true });
  mkdirSync(setupDir, { recursive: true });
  mkdirSync(portableDir, { recursive: true });

  // Два прохода, а не один:
  //
  //  * ПОРТАТИВНЫЙ exe — «всё в себе»: Firefox (около 340 МБ) внутри, чтобы
  //    Пятёрка, Чижик и Перекрёсток работали сразу, без скачивания. Так
  //    переносимая версия и ведёт себя: положили рядом и запустили.
  //  * УСТАНОВЩИК — без браузера: 117 МБ вместо 210. Браузер ставится кнопкой
  //    в интерфейсе, и те, кому он не нужен, его не качают.
  //
  // extraResources у electron-builder общий для всех target'ов, поэтому браузер
  // добавляется временной правкой package.json — с обязательным восстановлением
  // в finally: упавшая сборка не должна оставить изменённый package.json.
  const browsersDir = resolve(process.cwd(), '.playwright-browsers');
  const withBrowser = {
    from: '.playwright-browsers',
    to: 'browsers',
    filter: ['firefox-*/**', 'winldd-*/**'],
  };

  const buildTarget = async (target, withFirefox) => {
    const pkg = JSON.parse(pkgOriginal);
    if (withFirefox) {
      pkg.build.extraResources = [withBrowser, ...(pkg.build.extraResources ?? [])];
    }
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    // Свой каталог на каждый проход: два прохода подряд в одном каталоге
    // ломались — NSIS не мог перезаписать свой uninstaller («Can't open output
    // file»), потому что файл держал антивирус. Разные каталоги этой
    // коллизии не создают.
    const out = `${stagingDir}-${target}`;
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    await run('npx', [
      'electron-builder',
      ...args.filter((a) => !a.startsWith('--win')),
      '--win',
      target,
      `--config.directories.output=${out}`,
    ]);
    const produced = readdirSync(out, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
    if (produced.length === 0) throw new Error(`electron-builder не создал ни одного файла (${target})`);
    for (const name of produced) {
      // builder-debug.yml — внутренний дамп electron-builder (раскрытые пути и
      // шаблоны NSIS). В dist ему не место: там лежат артефакты, которые
      // выкладывают в релиз. Нужен он только при разборе сборки, и то через
      // DEBUG=electron-builder, который пишет в консоль.
      if (name === 'builder-debug.yml') continue;
      const target_ = name.includes('-portable.') ? portableDir : setupDir;
      copyFileSync(join(out, name), join(target_, name));
      console.log(`[build-exe] ${target_ === distDir ? 'dist' : target_.slice(distDir.length + 1)}: ${name}`);
    }
    return produced;
  };

  const hasFirefox = existsSync(join(browsersDir, 'firefox-1543')) || readdirSync(browsersDir).some((d) => d.startsWith('firefox-'));
  if (hasFirefox) {
    console.log('[build-exe] портативный exe: Firefox вшит внутрь');
    await buildTarget('portable', true);
  } else {
    console.warn('[build-exe] Firefox в .playwright-browsers нет — портативный exe соберётся без него');
    await buildTarget('portable', false);
  }
  console.log('[build-exe] установщик: без Firefox (ставится кнопкой в приложении)');
  await buildTarget('nsis', false);
  console.log('[build-exe] готово');
} finally {
  // package.json возвращается в исходный вид при ЛЮБОМ исходе, включая
  // упавшую сборку.
  try {
    writeFileSync(pkgPath, pkgOriginal, 'utf8');
  } catch (err) {
    console.error('[build-exe] НЕ УДАЛОСЬ вернуть package.json:', err);
    process.exitCode = 1;
  }
  // Промежуточная папка с 400 МБ распакованного Electron не остаётся в проекте.
  for (const dir of [stagingDir, `${stagingDir}-portable`, `${stagingDir}-nsis`]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}