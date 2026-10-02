// Проверка перед упаковкой: браузер должен реально попасть в сборку.
// Фильтр extraResources в electron-builder не матчит ничего молча — если каталога
// браузера нет, упаковщик радостно соберёт exe без Firefox, и Пятёрочка в
// установленном приложении будет отвечать «браузер не найден» без единого слова
// в логе сборки. Здесь такой случай падает сразу.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browsersRoot = path.join(root, '.playwright-browsers');

const problems = [];

if (!fs.existsSync(browsersRoot)) {
  problems.push(
    `нет каталога ${browsersRoot} — Firefox в сборку не попадёт. Поставь его: ` +
      'PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers npx playwright install firefox',
  );
} else {
  // Ревизия обязана совпадать с той, что требует установленный playwright-core:
  // упакованный каталог обязан называться ровно firefox-<revision>, иначе
  // приложение не найдёт браузер (см. node-platform.ts).
  const req = createRequire(path.join(root, 'package.json'));
  let revision = null;
  try {
    const pkgJson = req.resolve('playwright-core/package.json');
    const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(pkgJson), 'browsers.json'), 'utf8'));
    revision = Array.isArray(raw.browsers) ? (raw.browsers.find((b) => b.name === 'firefox')?.revision ?? null) : null;
  } catch (err) {
    problems.push(`не читается browsers.json playwright-core: ${err.message}`);
  }
  if (!revision) {
    problems.push('в browsers.json playwright-core нет записи firefox');
  } else {
    const dir = path.join(browsersRoot, `firefox-${revision}`);
    if (!fs.existsSync(path.join(dir, 'INSTALLATION_COMPLETE'))) {
      problems.push(`нет маркера ${path.join(`firefox-${revision}`, 'INSTALLATION_COMPLETE')} — установка браузера не завершена`);
    }
    if (!fs.existsSync(path.join(dir, 'firefox', 'firefox.exe'))) {
      problems.push(`нет бинарника firefox.exe в firefox-${revision}`);
    }
  }

  // winldd нужен не для запуска Firefox, а для проверки зависимостей, которую
  // Playwright повторяет раз в 30 дней: без него на 31-й день приложение
  // падает с «Executable doesn't exist at …/winldd». Он ставится вместе с
  // firefox (installByDefault: false, но тянется как зависимость проверки).
  const winldd = fs.readdirSync(browsersRoot).filter((d) => d.startsWith('winldd-'));
  if (winldd.length === 0) {
    problems.push(
      'нет каталога winldd-* в .playwright-browsers — через 30 дней Playwright запросит его и упадёт. ' +
        'Переустанови браузер: PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers npx playwright install firefox',
    );
  }
}

if (problems.length) {
  console.error('Сборка остановлена: браузер в поставку не попал бы.');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('browser ok: firefox + winldd на месте и совпадают с playwright-core');