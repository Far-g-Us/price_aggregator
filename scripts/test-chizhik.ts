// Разбор ответов Чижика на ЖИВЫХ фикстурах (Москва, магазин HD87, снято
// 2026-10-08 через scripts/fetch-chizhik-fixture.ts).
//
// Фикстуры лежат как сеть их отдала: дерево категорий, товары полки и выдача
// поиска. Проверяем ровно то, что чаще всего ломается при правках адаптера: что
// служебная обёртка дерева разворачивается, цена читается из `regular`, скидка —
// из первого непустого акционного поля, а «цена от N-го в корзине» в цену не
// попадает.

import assert from 'node:assert';
import fs from 'node:fs';
import { isProductLookupError } from '../src/core/adapter-errors.js';
import {
  CATEGORY_LIMIT,
  assertChizhikSapId,
  chizhikCategoryIdFromUrl,
  chizhikCategoryUrl,
  chizhikNameQueries,
  chizhikPlu,
  chizhikProductUrl,
  flattenChizhikCategories,
  isKnownChizhikSap,
  normalizeChizhikItem,
  validOldPrice,
  type ChizhikCategoryNode,
  type ChizhikItem,
} from '../src/core/adapters/chizhik-parse.js';
import { CITY_TO_STORE, chizhikSapId } from '../src/shared/chizhik-regions.js';
import { CITIES, CITY_STORES } from '../src/shared/catalog.js';

const read = (name: string): unknown => JSON.parse(fs.readFileSync(`tests/fixtures/chizhik/${name}`, 'utf8'));
const CTX = { city: 'moscow' };

// --- 0. Два источника кода магазина сверяются. -----------------------------
// `catalog.ts` (что реально опрашивает приложение) и `chizhik-regions.ts`
// (сгенерированный справочник) — две таблицы, и `npm run chizhik:regions`
// перегенерирует вторую молча. Расхождение не ловил НИКТО: каждый запрос стал бы
// падать, а `live:check` оставался бы зелёным, потому что берёт код из справочника.
{
  const fromCatalog: string[] = [];
  for (const city of CITIES) {
    for (const store of CITY_STORES[city.id] ?? []) {
      if (store.storeId === 'chizhik') fromCatalog.push(`${city.id}:${store.externalStoreId}`);
    }
  }
  assert.ok(fromCatalog.length >= 10, `в каталоге должны быть магазины Чижика, а их ${fromCatalog.length}`);
  for (const entry of fromCatalog) {
    const [city, sapId] = entry.split(':');
    assert.equal(
      sapId,
      CITY_TO_STORE[city ?? '']?.sapId,
      `catalog.ts и chizhik-regions.ts расходятся по городу ${city}: ` +
        'после перегенерации справочника каждый запрос падал бы, а сеть была бы цела',
    );
  }
  // И наоборот: город из справочника обязан быть в каталоге городов приложения.
  for (const city of Object.keys(CITY_TO_STORE)) {
    assert.ok(
      fromCatalog.some((e) => e.startsWith(`${city}:`)),
      `город ${city} есть в справочнике, но его магазина нет в catalog.ts`,
    );
  }
}

// --- 1. Дерево категорий: верхний узел служебный, его дети — наши полки. ---
{
  const raw = read('categories.json') as ChizhikCategoryNode[];
  const rawForList = structuredClone(raw);
  const list = flattenChizhikCategories(raw);
  assert.equal(raw.length, 1, 'разбор не мутирует ответ сети: сеть его переиспользует');
  assert.deepEqual(raw, rawForList, 'исходное дерево категорий не тронуто');
  assert.ok(Array.isArray(raw), 'ответ категорий — массив');
  assert.ok(raw.length === 1, `верхний узел один, а узлов ${raw.length}`);
  const root = raw[0];
  assert.ok(root, 'верхний узел есть');
  assert.ok((root.categories ?? []).length > 1, 'в обёртке несколько категорий');
  assert.equal(root.image_link ?? null, null, 'у обёртки нет картинки');
  assert.ok(list.length >= 20, `полек должно быть много, а не ${list.length}`);
  assert.ok(
    !list.some((c) => c.id === String(root.id)),
    'служебный узел в каталог не попал',
  );
  assert.ok(
    !list.some((c) => (root.categories ?? []).some((k) => String(k.id) === c.id && c.name === root.name)),
    'в каталог не попала сама обёртка под своим именем',
  );
  const withImage = list.filter((c) => c.imageUrl !== undefined);
  assert.ok(withImage.length >= 20, 'у полок есть картинки');
  assert.ok(list.every((c) => /^https:\/\/app\.chizhik\.club\/catalog\/[A-Za-z0-9]+\/$/.test(c.url)), 'адрес полки со слэшем');
  assert.equal(chizhikCategoryIdFromUrl(list[0]?.url ?? ''), list[0]?.id, 'id полки читается обратно из адреса');
  assert.equal(chizhikCategoryIdFromUrl('https://app.chizhik.club/shop/HD87'), null, 'адрес магазина — не полка');
  assert.equal(chizhikCategoryIdFromUrl('https://example.com/catalog/ABC/'), null, 'чужой домен — не полка');
  assert.equal(chizhikCategoryUrl('ABC123'), 'https://app.chizhik.club/catalog/ABC123/', 'адрес полки строится коротким');
  assert.ok(CATEGORY_LIMIT >= 20, 'лимит полок не меньше числа живых категорий');

  // Дерево без обёртки (сеть отдала категории верхнего уровня) — тоже работает.
  const flat = flattenChizhikCategories([
    { id: 'A', name: 'Хлеб', image_link: 'https://img/a.png' },
    { id: 'B', name: 'Молоко' },
  ]);
  assert.deepEqual(flat.map((c) => c.id), ['A', 'B'], 'без обёртки категории берутся как есть');
  assert.equal(flat[0]?.imageUrl, 'https://img/a.png', 'картинка полки сохранена');
  assert.equal(flat[1]?.imageUrl, undefined, 'без картинки поля не выдумываются');
  // Вложенность ниже второго уровня: рекурсия до листьев, полка = лист.
  const deep = flattenChizhikCategories([
    { id: 'R', name: 'Обёртка', categories: [{ id: 'L1', name: 'Раздел', categories: [{ id: 'L2', name: 'Лист' }] }] },
  ]);
  assert.deepEqual(deep.map((c) => c.name), ['Лист'], 'показываются только листья: у раздела товары в детях');
  assert.deepEqual(flattenChizhikCategories([]), [], 'пустой ответ даёт пустой список');
  assert.deepEqual(flattenChizhikCategories(null), [], 'null вместо массива не роняет');
  // Кампании нет: разделы верхнего уровня — то же дерево, листья те же.
  assert.deepEqual(
    flattenChizhikCategories([{ id: 'S', name: 'Раздел', categories: [{ id: 'Leaf', name: 'Молоко' }] }]).map(
      (c) => c.id,
    ),
    ['Leaf'],
    'без служебной обёртки разделы тоже не становятся полками',
  );
  // Лимит полок: сеть может прислать больше, чем показываем.
  const many = Array.from({ length: CATEGORY_LIMIT + 5 }, (_, i) => ({ id: `X${i}`, name: `К${i}` }));
  assert.equal(flattenChizhikCategories(many).length, CATEGORY_LIMIT, 'полки обрезаны по лимиту');
  assert.deepEqual(flattenChizhikCategories([{ id: '', name: 'Без id' }, { id: 'C', name: '  ' }]), [], 'мусорные узлы отброшены');
  // Дырявый ответ: null в массиве и узел без полей — разбор не должен падать.
  assert.deepEqual(
    flattenChizhikCategories([null as never, undefined as never, { categories: [null as never] }] as never),
    [],
    'пустые узлы пережиты без исключения',
  );
  // Узел с id, но без категорий-дети и без имени — отброшен; без категорий — взят.
  assert.deepEqual(flattenChizhikCategories([{ id: 'Z' } as never]).length, 0, 'узел без имени не полка');
}

// --- 2. Товары: цена, скидка, наличие, картинка, единица. -------------------
{
  const search = read('search.json') as { products: ChizhikItem[] };
  assert.ok(search.products.length >= 10, 'выдача поиска не пустая');
  const items = search.products.map((p) => normalizeChizhikItem(p, CTX)).filter((x) => x !== null);
  assert.ok(items.length === search.products.length, 'все товары живого ответа нормализованы');
  const first = items[0];
  assert.ok(first);
  assert.match(first.canonicalId, /^chizhik-\d+$/, 'идентичность товара');
  assert.equal(first.storeId, 'chizhik', 'сеть проставлена');
  assert.equal(first.city, 'moscow', 'город проставлен');
  assert.ok(first.price > 0, 'цена положительная');
  assert.equal(first.promoPrice, null, 'в живой выборке акций нет');
  assert.equal(first.oldPrice, null, 'зачёркнутой цены нет');
  assert.equal(first.inStock, true, 'наличие из is_available');
  assert.match(first.url ?? '', /^https:\/\/app\.chizhik\.club\/goods\/\d+$/, 'ссылка на товар');
  assert.match(first.imageUrl ?? '', /800x800|normal/, 'картинка: normal, не 320x320');
  assert.match(first.unit ?? '', /\S/, 'единица из названия сети');
  assert.ok(first.unitPrice === undefined || typeof first.unitPrice === 'string', 'цена за единицу — строка');

  // Единица: property_clarification, потом uom, потом «шт».
  assert.equal(normalizeChizhikItem({ plu: '1', name: 'X', prices: { regular: '10' }, property_clarification: '200 мл' }, CTX)?.unit, '200 мл', 'property_clarification');
  assert.equal(normalizeChizhikItem({ plu: '1', name: 'X', prices: { regular: '10' }, uom: 'кг' }, CTX)?.unit, 'кг', 'uom');
  assert.equal(normalizeChizhikItem({ plu: '1', name: 'X', prices: { regular: '10' } }, CTX)?.unit, 'шт', 'единица по умолчанию');

  // Скидки: первое непустое акционное поле, старая цена — из markdown.
  const withDiscount = normalizeChizhikItem({ plu: '2', name: 'Y', prices: { regular: '100', discount: '79' } }, CTX);
  assert.equal(withDiscount?.promoPrice, 79, 'discount → акционная цена');
  assert.equal(withDiscount?.oldPrice, null, 'oldPrice не выдумывается, когда его нет');
  const withCpd = normalizeChizhikItem({ plu: '2', name: 'Y', prices: { regular: '100', discount: '79', cpd_promo_price: '70' } }, CTX);
  assert.equal(withCpd?.promoPrice, 79, 'discount остаётся акционной ценой при заполненном cpd_promo_price');
  // cpd_promo_price у X5 — «цена ко 2-му»: у Чижика в живых выборках она пуста, и
  // подтверждения, что это обычная скидка, нет. Поэтому не берём её вообще, даже
  // без маркера мультибая: записать её в promoPrice = соврать о цене единичного товара.
  const cpdOnly = normalizeChizhikItem({ plu: '2', name: 'Y', prices: { regular: '100', cpd_promo_price: '70' } }, CTX);
  assert.equal(cpdOnly?.promoPrice, null, 'cpd_promo_price не попадает в promoPrice');
  const cpdSumCart = normalizeChizhikItem(
    { plu: '2', name: 'Y', prices: { regular: '100', discount: '79', cpd_promo_price_from_sum_cart: '50' } },
    CTX,
  );
  assert.equal(cpdSumCart?.promoPrice, 79, 'цена «от N-го в корзине» не влияет на промо');
  // Мультибай-маркер гасит и настоящую скидку рядом (паритет с 5ka).
  const multibuy = normalizeChizhikItem(
    { plu: '2', name: 'Y', prices: { regular: '100', discount: '79' }, promo: { rebate: { units_to_activate: 2 } } },
    CTX,
  );
  assert.equal(multibuy?.promoPrice, null, 'мультибай не попадает в promoPrice');
  assert.equal(multibuy?.price, 100, 'единичная цена при мультибае остаётся regular');
  const rebateEmpty = normalizeChizhikItem(
    { plu: '2', name: 'Y', prices: { regular: '100', discount: '79' }, promo: { rebate: { units_to_activate: null } } },
    CTX,
  );
  assert.equal(rebateEmpty?.promoPrice, 79, 'rebate без units_to_activate — не мультибай, скидка обычная');
  const multi = normalizeChizhikItem(
    { plu: '2', name: 'Y', prices: { regular: '100', discount: '79', cpd_promo_price_from_sum_cart: '50' } },
    CTX,
  );
  assert.equal(multi?.promoPrice, 79, 'цена «от N-го в корзине» в промо не попадает');
  const markdown = normalizeChizhikItem({ plu: '2', name: 'Y', prices: { regular: '100', markdown: '150' } }, CTX);
  assert.equal(markdown?.oldPrice, 150, 'markdown → зачёркнутая цена');
  const silly = normalizeChizhikItem({ plu: '2', name: 'Y', prices: { regular: '100', discount: '900', markdown: '9999' } }, CTX);
  assert.equal(silly?.promoPrice, null, 'акция выше обычной цены отброшена');
  assert.equal(silly?.oldPrice, null, 'старая цена выше в 100 раз отброшена');
  assert.equal(normalizeChizhikItem({ plu: '2', name: 'Y', prices: { regular: '100', discount: 'NaN' } }, CTX)?.promoPrice, null, 'NaN в цене не цена');
  assert.equal(normalizeChizhikItem({ plu: '2', name: 'Y', prices: { regular: '100,50' } }, CTX)?.price, 100.5, 'запятая как разделитель');
  assert.equal(normalizeChizhikItem({ plu: '2', name: 'Y', prices: { regular: 100 } }, CTX)?.price, 100, 'цена числом');
  assert.equal(normalizeChizhikItem({ plu: '2', name: 'Y', prices: { regular: '' } }, CTX), null, 'пустая цена — не цена');
  assert.equal(normalizeChizhikItem({ plu: '2', name: 'Y', prices: { regular: '   ' } }, CTX), null, 'пробелы в цене — не цена');
  assert.equal(normalizeChizhikItem({ plu: '2', name: 'Y', prices: { regular: '0' } }, CTX), null, 'нулевая цена — не товар');
  assert.equal(normalizeChizhikItem({ plu: '2', name: 'Y', prices: null }, CTX), null, 'без цен — не товар');
  assert.equal(normalizeChizhikItem({ plu: 'abc', name: 'Y', prices: { regular: '10' } }, CTX), null, 'плю не число — не товар');
  assert.equal(normalizeChizhikItem({ plu: null, name: 'Y', prices: { regular: '10' } }, CTX), null, 'plu null — не товар');
  assert.equal(normalizeChizhikItem({ plu: '2', name: null, prices: { regular: '10' } }, CTX), null, 'имя null — не товар');
  assert.equal(normalizeChizhikItem({ plu: '2', name: '  ', prices: { regular: '10' } }, CTX), null, 'без имени — не товар');
  assert.ok(validOldPrice(150, 100), 'зачёркнутая выше обычной принимается');
  assert.equal(validOldPrice(100, 100), false, 'равная цена — не акция');

  // Вторая форма цены у X5: МАССИВ `[{value, placement_type}]` (как в карточке
  // Пятёрки). Если её не разобрать, цена станет undefined, все товары молча
  // отфильтруются, полка будет пустой, а breaker промолчит.
  const arrRegular = normalizeChizhikItem(
    { plu: '5', name: 'Массив', prices: [{ value: '150', placement_type: 'regular_primary' }, { value: '99' }] },
    CTX,
  );
  assert.equal(arrRegular?.price, 150, 'массивная форма: обычная цена по метке');
  assert.equal(arrRegular?.promoPrice, 99, 'массивная форма: цена ниже обычной — акция');
  const arrOld = normalizeChizhikItem(
    { plu: '5', name: 'Массив', prices: [{ value: '100', placement_type: 'regular_primary' }, { value: '150' }] },
    CTX,
  );
  assert.equal(arrOld?.oldPrice, 150, 'массивная форма: цена выше обычной — зачёркнутая');
  assert.equal(arrOld?.promoPrice, null, 'зачёркнутая не становится акционной');
  const arrNoTag = normalizeChizhikItem({ plu: '5', name: 'Массив', prices: [{ value: '120' }, { value: '80' }] }, CTX);
  assert.equal(arrNoTag?.price, 120, 'без метки берётся первая цена');
  assert.equal(arrNoTag?.promoPrice, 80, 'вторая цена ниже — акция');
  const arrEmpty = normalizeChizhikItem({ plu: '5', name: 'Массив', prices: [] }, CTX);
  assert.equal(arrEmpty, null, 'пустой массив цен — не товар');
  assert.equal(normalizeChizhikItem({ plu: '5', name: 'Массив', prices: [{ value: null }] }, CTX), null, 'цены без числа — не товар');

  // Наличие и картинки.
  assert.equal(
    normalizeChizhikItem({ plu: '3', name: 'Z', prices: { regular: '5' } }, CTX)?.inStock,
    undefined,
    'без поля is_available наличие неизвестно, а не «нет в наличии»',
  );
  assert.equal(normalizeChizhikItem({ plu: '3', name: 'Z', prices: { regular: '5' }, is_available: false }, CTX)?.inStock, false, 'is_available=false — нет');
  const smallOnly = normalizeChizhikItem(
    { plu: '3', name: 'Z', prices: { regular: '5' }, image_links: { small: ['https://img/x/320x320.jpeg'] } },
    CTX,
  );
  assert.equal(smallOnly?.imageUrl, 'https://img/x/800x800.jpeg', 'малая картинка поднята до большой');
  const viaMedia = normalizeChizhikItem(
    { plu: '3', name: 'Z', prices: { regular: '5' }, media: { image_links: { small: ['https://img/y/320x320.jpeg'] } } },
    CTX,
  );
  assert.equal(viaMedia?.imageUrl, 'https://img/y/800x800.jpeg', 'картинка из media');
  assert.equal(normalizeChizhikItem({ plu: '3', name: 'Z', prices: { regular: '5' } }, CTX)?.imageUrl, undefined, 'без картинок поле не выдумывается');

  // Цена за единицу: строка берётся, число игнорируется (формат не проверен сетью).
  assert.equal(normalizeChizhikItem({ plu: '4', name: 'W', prices: { regular: '10' }, price_piece_unit: '250 ₽/кг' }, CTX)?.unitPrice, '250 ₽/кг', 'цена за единицу строкой');
  assert.equal(normalizeChizhikItem({ plu: '4', name: 'W', prices: { regular: '10' }, price_piece_unit: 250 }, CTX)?.unitPrice, undefined, 'числом цену за единицу не берём');
  assert.equal(normalizeChizhikItem({ plu: '4', name: 'W', prices: { regular: '10' }, price_piece_unit: '   ' }, CTX)?.unitPrice, undefined, 'пустая строка не цена');

  // Витрина: формат тот же, товаров меньше, но они нормализуются тем же кодом.
  const shelf = read('category-products.json') as { products: ChizhikItem[] };
  const shelfItems = shelf.products.map((p) => normalizeChizhikItem(p, CTX)).filter((x) => x !== null);
  assert.ok(shelfItems.length > 0, 'товары полки нормализованы');
  assert.ok(shelfItems.every((p) => p.storeId === 'chizhik'), 'сеть у товаров полки');
}

// --- 3. Идентичность, ссылки и справочник магазинов. ------------------------
{
  assert.equal(chizhikPlu('chizhik-4309774'), '4309774', 'plu из canonical id');
  assert.equal(chizhikPlu('4309774'), '4309774', 'plu и без префикса');
  assert.throws(() => chizhikPlu('chizhik-abc'), /не plu/, 'мусор в canonical id пойман');
  assert.throws(() => assertChizhikSapId('HD-87'), /bad sap_id/, 'тире в коде магазина');
  assert.throws(() => assertChizhikSapId(''), /bad sap_id/, 'пустой код магазина');
  assert.equal(assertChizhikSapId('HD87'), 'HD87', 'живой код принят');
  assert.ok(isKnownChizhikSap('HD87'), 'московский код из справочника');
  assert.equal(isKnownChizhikSap('ZZZZ'), false, 'чужой код не из справочника');
  assert.equal(chizhikProductUrl('4309774'), 'https://app.chizhik.club/goods/4309774', 'ссылка на товар');

assert.equal(chizhikSapId('moscow'), CITY_TO_STORE.moscow?.sapId, 'код Москвы из справочника');
  assert.throws(() => chizhikSapId('irkutsk'), /нет магазина/, 'город без сети отвечает внятно');
  // Покрытие осознанное (11 городов: СПб, Красноярска, Омска и Иркутска у сети
  // нет), но сам состав проверяем по каталогу городов, а не числом: перегенерация
  // справочника не должна ронять тест адаптера.
  for (const [city, store] of Object.entries(CITY_TO_STORE)) {
    assert.ok(CITIES.some((c) => c.id === city), `город ${city} есть в каталоге городов приложения`);
    assert.match(store.sapId, /^[A-Za-z0-9]{2,8}$/, `код магазина ${city} проходит ту же проверку, что и адаптер`);
    assert.ok(store.name.length > 3, `у магазина ${city} есть название`);
  }
}

// --- 4. Поиск товара по названию: лестница длин. ---------------------------
{
  assert.deepEqual(chizhikNameQueries('Молоко АМА МАМА'), ['Молоко АМА МАМА'], 'короткое имя — один запрос');
  const long = 'Молоко АМА МАМА фруктовое пастеризованное 3.2% 930мл';
  assert.deepEqual(chizhikNameQueries(long), [long, long.slice(0, 40), long.slice(0, 25)], 'длинное имя обрезается дважды');
  assert.deepEqual(chizhikNameQueries('   '), [], 'пустое имя не ищем');
  assert.equal(isProductLookupError(new Error('x')), false, 'обычная ошибка — не поисковая');
}

console.log(
  `chizhik: ALL GREEN — ${flattenChizhikCategories(read('categories.json') as ChizhikCategoryNode[]).length} полок живого дерева, служебная обёртка развёрнута, цена из regular, скидка из первого непустого поля, «цена от N-го в корзине» отброшена, наличие из is_available, справочник на ${Object.keys(CITY_TO_STORE).length} городов`,
);