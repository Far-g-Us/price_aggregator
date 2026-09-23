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
