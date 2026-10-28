// VERSION — единственный источник версии.
// Синхронизирует package.json перед dev/build, чтобы electron-builder
// и app.getVersion() подхватывали её автоматически.
// Запуск: npm run version:sync (вызывается из predev/prebuild).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function toSemver(raw) {
  const parts = raw.trim().split('.').map(Number);
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`Bad VERSION: ${raw}`);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3).join('.');
}

const version = toSemver(fs.readFileSync(path.join(root, 'VERSION'), 'utf-8'));
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
if (pkg.version !== version) {
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`version: ${version}`);
} else {
  console.log(`version up to date: ${version}`);
}

// Android-мост показывает версию из своего файла: `Capacitor.getVersion()`
// отдавал бы жёстко зашитый в build.gradle «1.0», а правило проекта — версия
// одна и берётся из файла VERSION. Поэтому обновляем и его: иначе следующий
// бамп версии навсегда оставил бы в Android старый номер.
const androidVersionPath = path.join(root, 'src', 'renderer', 'android', 'version.ts');
if (fs.existsSync(androidVersionPath)) {
  const source = fs.readFileSync(androidVersionPath, 'utf-8');
    const updated = source.replace(/(export const APP_VERSION = ')[^']+(';)/, `$1${version}$2`);
    if (updated !== source) {
      fs.writeFileSync(androidVersionPath, updated);
      console.log(`android version: ${version}`);
    } else if (!/APP_VERSION = '[^']+'/.test(source)) {
      // Регулярка перестала совпадать: версия в Android замрёт на старой, и
      // приложение покажет не тот номер. Молчать об этом нельзя.
      console.warn(`ВНИМАНИЕ: в ${androidVersionPath} не найдено APP_VERSION — версия Android не обновлена`);
    }
}

// package-lock: у него своя копия версии, и `npm ci` её не сверяет с
// package.json — рассинхрон копится незаметно (в локе оставалась 1.3.0 при
// package.json 1.4.0). Правило проекта — версия одна, из VERSION.
const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
  let touched = false;
  if (typeof lock.version === 'string' && lock.version !== version) {
    lock.version = version;
    touched = true;
  }
  if (lock.packages && lock.packages[''] && lock.packages[''].version !== version) {
    lock.packages[''].version = version;
    touched = true;
  }
  if (touched) {
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    console.log(`package-lock: ${version}`);
  }
}
