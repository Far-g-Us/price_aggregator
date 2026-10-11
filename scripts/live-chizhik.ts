// Живая проверка Чижика: все его города подряд.
//
//   npx tsx scripts/live-chizhik.ts
//
// Что проверяем по каждому городу: поиск («молоко»), карточка найденного товара,
// дерево категорий и товары первой полки. Каждый город — своя сессия (страница
// магазина задаёт контекст), поэтому проверка длинная: браузер поднимается на
// город. Это осознанно: магазины приходят из справочника, и цена/название в теле
// ответа не маркированы магазином (sap_code приходит null), поэтому единственная
// проверка, что код живой и отдаёт товары, — такой прогон.
//
// Если сеть включила антибот, скрипт скажет об этом и остановится: биться об
// 403 бесполезно, паузу надо делать живьём.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CITIES } from '../src/shared/catalog.js';
import { CITY_TO_STORE } from '../src/shared/chizhik-regions.js';
import { ChizhikAdapter } from '../src/core/adapters/chizhik.js';
import { closeChizhikBrowser } from '../src/core/adapters/chizhik-browser.js';

// Браузеры Playwright по умолчанию берутся из системного профиля, а приложение
// задаёт путь само (`electron/node-platform.ts`). Скрипту это надо сделать здесь,
// иначе все города падают с «Executable doesn't exist» — и это выглядит как
// упавшая сеть. Путь тот же, что в `live-check.ts`: папка в корне проекта. Звать
// `resolveBrowsersPath` нельзя — тот файл импортирует `electron`.
const localBrowsers = resolve(process.cwd(), '.playwright-browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(localBrowsers)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsers;
}
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  console.log('  браузеры Playwright не найдены: поставь PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers npx playwright install firefox');
  process.exit(1);
}
console.log(`  браузеры Playwright: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);

const adapter = new ChizhikAdapter();
const QUERY = process.argv[2] ?? 'молоко';
const limit = Number(process.argv[3] ?? '0');

const ours = CITIES.map((c) => c.id).filter((id) => CITY_TO_STORE[id] !== undefined);
const list = limit > 0 ? ours.slice(0, limit) : ours;
console.log(`  городов у Чижика: ${ours.length} из ${CITIES.length} наших`);
console.log(`  без магазина: ${CITIES.map((c) => c.id).filter((id) => CITY_TO_STORE[id] === undefined).join(', ')}`);

let failed = 0;
/** Пауза между городами: 11 городов × 4 запроса подряд — это уже давление на сеть. */
const CITY_GAP_MS = 4000;
for (const [index, city] of list.entries()) {
  if (index > 0) await new Promise((done) => void setTimeout(done, CITY_GAP_MS));
  const externalStoreId = CITY_TO_STORE[city]?.sapId ?? '';
  const ctx = { city, externalStoreId };
  const line = [`${city.padEnd(17)} ${externalStoreId}`];
  try {
    const found = await adapter.search(QUERY, ctx);
    if (found.length === 0) {
      line.push('поиск ПУСТ');
      failed += 1;
      console.log(`  ${line.join('  ')}`);
      continue;
    }
    const first = found[0];
    if (!first) {
      failed += 1;
      console.log(`  ${line.join('  ')}  НЕТ ТОВАРОВ`);
      continue;
    }
    const withStock = found.filter((p) => p.inStock === true).length;
    line.push(`поиск ${found.length} (в наличии ${withStock})`);
    line.push(`«${first.name.slice(0, 26)}» ${first.price}₽${first.promoPrice ? ` / ${first.promoPrice}₽` : ''}`);
    try {
      const card = await adapter.fetchProduct(first.canonicalId, { ...ctx, name: first.name });
      line.push(`карточка ${card.price}₽ ${card.canonicalId === first.canonicalId ? 'id совпал' : 'ID РАЗНЫЙ!'}`);
    } catch (err) {
      line.push(`карточка ОШИБКА ${(err as Error).message.slice(0, 60)}`);
      failed += 1;
    }
    try {
      const cats = await adapter.fetchCategories(ctx);
      line.push(`категорий ${cats.length}`);
      const goods = await adapter.fetchCategoryProducts(cats[0]?.url ?? '', ctx);
      line.push(`полка «${cats[0]?.name?.slice(0, 20)}» ${goods.length}`);
    } catch (err) {
      line.push(`категории ОШИБКА ${(err as Error).message.slice(0, 60)}`);
      failed += 1;
    }
    console.log(`  ${line.join('  ')}`);
  } catch (err) {
    failed += 1;
    console.log(`  ${line.join('  ')}  ПОИСК ОШИБКА ${(err as Error).message.slice(0, 80)}`);
  } finally {
    await closeChizhikBrowser();
  }
}
console.log(`  готово: ${list.length - failed} из ${list.length} городов без ошибок`);