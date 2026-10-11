// Живая проверка полок Светофора: реальные разделы меню и товары под ними.
//
//   npx tsx scripts/live-svetofor-shelves.ts            # Москва
//   npx tsx scripts/live-svetofor-shelves.ts 206 saint-petersburg
//
// Проверяем то, чего не видит тест на фикстуре: что меню живой страницы действительно
// разбирается, что разделы совпадают с прайсом и что товары полки приходят с
// ценами конкретной точки.

import { CITIES, CITY_STORES } from '../src/shared/catalog.js';
import { svetoforDomain } from '../src/shared/svetofor-regions.js';
import { SvetoforAdapter } from '../src/core/adapters/svetofor.js';

const shopId = process.argv[2] ?? '820';
const city = process.argv[3] ?? 'moscow';

const inCatalog = CITY_STORES[city]?.some((s) => s.storeId === 'svetofor');
if (!inCatalog) {
  console.log(`  в каталоге нет Светофора для города ${city} (из ${CITIES.length})`);
  process.exit(1);
}

const domain = svetoforDomain(shopId);
const adapter = new SvetoforAdapter({ domain: (id) => svetoforDomain(id) });
const ctx = { city, externalStoreId: shopId };
console.log(`  магазин ${shopId}, город ${city}, домен ${domain}`);

const shelves = await adapter.fetchCategories(ctx);
console.log(`  полок: ${shelves.length}`);
for (const s of shelves) console.log(`    ${s.name} → ${s.url}`);

let bad = 0;
for (const shelf of shelves) {
  try {
    const goods = await adapter.fetchCategoryProducts(shelf.url, ctx);
    const withPrice = goods.filter((g) => g.price > 0).length;
    const first = goods[0];
    console.log(`    ${shelf.name}: ${goods.length} товаров, с ценой ${withPrice}`);
    if (first) {
      console.log(`      первый: «${first.name.slice(0, 44)}» ${first.price}₽ ${first.unit ?? ''} ${first.url ?? ''}`);
    }
    if (goods.length === 0) {
      console.log('      (!) полка пуста');
      bad += 1;
    }
    if (withPrice !== goods.length) {
      console.log('      (!) часть товаров без цены');
      bad += 1;
    }
  } catch (err) {
    console.log(`    ${shelf.name}: ОШИБКА ${(err as Error).message.slice(0, 70)}`);
    bad += 1;
  }
}
console.log(`  готово: ${shelves.length - bad} из ${shelves.length} полок без замечаний`);