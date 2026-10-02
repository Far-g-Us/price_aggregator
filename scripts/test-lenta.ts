import assert from 'node:assert';
import fs from 'node:fs';
import { CITY_TO_SLUG, LENTA_REGIONS, lentaRegionByCity, lentaRegionBySlug } from '../src/shared/lenta-regions.js';
import { CITIES, CITY_STORES } from '../src/shared/catalog.js';
import {
  aliasFromDeliveryMode,
  assertLentaStoreId,
  isLentaInStock,
  kopecksToRub,
  lentaDomain,
  lentaItemId,
  lentaNameQueries,
  lentaPricePair,
  lentaProductUrl,
  lentaSearchBody,
  lentaWeightLabel,
  normalizeLentaItem,
  normalizeLentaSearch,
  sameLentaStore,
  LentaAdapter,
  type LentaDeliveryMode,
  type LentaItem,
} from '../src/core/adapters/lenta.js';
import { isProductLookupError } from '../src/core/adapter-errors.js';

const ctx = { city: 'moscow' as const };
const ALIAS = '3090';

const card = JSON.parse(fs.readFileSync('tests/fixtures/lenta-product.json', 'utf-8')) as LentaItem;
const mode = JSON.parse(
  fs.readFileSync('tests/fixtures/lenta-delivery-mode.json', 'utf-8'),
) as LentaDeliveryMode;

// Коды городов проекта — не slug'ы регионов Ленты: подставить свой id нельзя,
// всё кроме Москвы уедет в 401. Маппинг один на проект (lenta-regions.ts),
// и каждый slug обязан быть в живом справочнике регионов.
const known = new Map(LENTA_REGIONS.map((r) => [r.slug, r]));
for (const city of ['moscow', 'saint-petersburg', 'ulyanovsk', 'krasnodar', 'irkutsk']) {
  const slug = lentaDomain(city);
  const region = known.get(slug);
  assert.ok(region, `slug ${slug} есть в справочнике регионов Ленты`);
  assert.ok((region?.stores ?? 0) > 0, `в регионе ${slug} есть точки: ${String(region?.stores)}`);
  assert.ok((region?.pickup ?? 0) > 0, `в регионе ${slug} есть точки с самовывозом`);
  assert.ok(region?.sampleStoreId, `у региона ${slug} есть точка-кандидат для catalog.ts`);
}
assert.equal(lentaDomain('moscow'), 'moscow');
assert.equal(lentaDomain('saint-petersburg'), 'spb');
assert.equal(lentaDomain('krasnodar'), 'ksdr');
assert.equal(lentaDomain('ulyanovsk'), 'ulyanovsk');
assert.equal(lentaDomain('irkutsk'), 'irkutsk');
assert.throws(() => lentaDomain('nope'), /нет региона/);
assert.equal(lentaRegionByCity('saint-petersburg')?.slug, 'spb', 'lentaRegionByCity знает наш id');

// Каждый наш город обязан быть в справочнике регионов Ленты, иначе адаптер
// подставит slug в X-Domain, которого сеть не знает, и всё уедет в 401.
for (const city of CITIES) {
  const region = lentaRegionByCity(city.id);
  assert.ok(region, `город ${city.name} (${city.id}) есть в справочнике регионов Ленты`);
  assert.ok((region?.pickup ?? 0) > 0, `в ${city.name} есть точки с самовывозом`);
  const lenta = (CITY_STORES[city.id] ?? []).find((s) => s.storeId === 'lenta');
  assert.ok(lenta, `в ${city.name} есть магазин Ленты`);
  assert.ok(
    !lenta?.externalStoreId || /^\d+$/.test(lenta.externalStoreId),
    `код точки Ленты в ${city.name} числовой (id, а не alias)`,
  );
}
assert.equal(lentaRegionBySlug('spb')?.id, 3, 'у Петербурга regionId 3');
assert.equal(
  LENTA_REGIONS.reduce((a, r) => a + r.stores, 0),
  1020,
  'справочник покрывает все точки сети (1020 на 2026-09-30)',
);
assert.equal(lentaRegionBySlug('moscow')?.marketTypes.includes('SM'), true, 'в Москве есть супермаркеты');

assert.equal(assertLentaStoreId('4161'), '4161');
assert.throws(() => assertLentaStoreId('TBD_STOREID'), /не число/);
assert.equal(lentaItemId('lenta-716637'), '716637');
assert.throws(() => lentaItemId('lenta-abc'), /нечисловой/);

assert.equal(lentaProductUrl('pechene-500g', 716637), 'https://lenta.com/product/pechene-500g-716637/');
assert.equal(
  lentaProductUrl('pechene-500g-716637', 716637),
  'https://lenta.com/product/pechene-500g-716637/',
  'slug уже с id — не дублируем',
);
assert.equal(lentaProductUrl(undefined, 716637), 'https://lenta.com/product/716637/');

// Две нумерации Ленты не выводятся одна из другой: alias "0037" и 37 —
// одно и то же число, а 4161 и 3090 — разные точки.
assert.ok(sameLentaStore('0037', 37));
assert.ok(sameLentaStore(3090, '3090'));
assert.ok(!sameLentaStore(4161, 3090));
assert.ok(!sameLentaStore(undefined, 3090));

assert.equal(kopecksToRub(16499), 164.99);
assert.equal(kopecksToRub(0), null);
assert.equal(kopecksToRub(null), null);
assert.equal(kopecksToRub(-100), null);

assert.equal(aliasFromDeliveryMode(mode, '4161'), ALIAS);
assert.throws(() => aliasFromDeliveryMode({ userStores: [] }, '4161'), /alias/);
assert.equal(
  aliasFromDeliveryMode({ userStores: [{ id: 3349, alias: '0037' }] }, '3349'),
  '0037',
  'alias с ведущим нулём не обрезаем — сверка идёт числом',
);

const product = normalizeLentaItem(card, ctx, ALIAS);
assert.ok(product, 'карточка нормализовалась');
assert.equal(product?.canonicalId, 'lenta-716637');
assert.equal(product?.storeId, 'lenta');
assert.equal(product?.price, 164.99, 'цены приходят в копейках');
assert.equal(product?.promoPrice, null, 'промо не пишем в promoPrice — цена акции и есть price');
assert.equal(product?.oldPrice, 239.99, 'зачёркнутая цена = priceRegular');
assert.equal(product?.inStock, true);
assert.equal(product?.brand, 'DELISSE');
assert.equal(product?.unit, '500г', 'фасовка нужна для склейки товаров между сетями');
assert.ok(product?.description?.startsWith('Печенье сдобное'));
assert.equal(product?.imageUrl?.includes('/900x900/'), true);
assert.equal(product?.url, `https://lenta.com/product/${card.slug ?? ''}-716637/`);
assert.ok(product?.collectedAt);

// Главный инвариант домена: HTTP 200 не значит «наш магазин».
assert.throws(
  () => normalizeLentaItem({ ...card, storeId: 7681 }, ctx, ALIAS),
  /чужому магазину/,
  'ответ по чужой точке — громкая ошибка, а не silent skip',
);
assert.throws(() => normalizeLentaItem({ ...card, storeId: 7681 }, ctx, ALIAS), /чужому магазину/);
assert.equal(
  normalizeLentaItem({ ...card, storeId: 7681 }, ctx, null)?.price,
  164.99,
  'alias недоступен (GET режет WAF) — сверку пропускаем, но не молчим',
);
assert.equal(
  normalizeLentaItem({ ...card, storeId: 3090 }, ctx, ALIAS)?.price,
  164.99,
  'свой alias — сверка проходит',
);
assert.throws(
  () => normalizeLentaItem({ ...card, storeId: undefined }, ctx, ALIAS),
  /нет storeId/,
  'в карточке маркер магазина обязателен',
);
assert.equal(
  normalizeLentaItem({ ...card, storeId: undefined }, ctx, ALIAS, false)?.price,
  164.99,
  'в выдаче поиска маркера нет by design — это не ошибка',
);

// Крайние случаи формы ответа: цены нет — товар отбрасываем, а не пишем 0.
assert.equal(normalizeLentaItem({ ...card, prices: { price: 0 } }, ctx, ALIAS), null);
assert.equal(normalizeLentaItem({ ...card, prices: undefined }, ctx, ALIAS), null);
assert.equal(normalizeLentaItem({ ...card, name: undefined }, ctx, ALIAS), null);

// Наличие: прямой признак — isBlockedForSale, остаток — count. В живой выдаче
// count у части товаров БОЛЬШЕ saleLimit.maxSaleQuantity (22 против 5), то
// есть это не лимит заказа.
assert.equal(normalizeLentaItem({ ...card, count: 0 }, ctx, ALIAS)?.inStock, false);
assert.equal(normalizeLentaItem({ ...card, count: undefined }, ctx, ALIAS)?.inStock, true);
assert.equal(normalizeLentaItem({ ...card, count: null }, ctx, ALIAS)?.inStock, true);
assert.equal(
  normalizeLentaItem({ ...card, count: 22, isBlockedForSale: true }, ctx, ALIAS)?.inStock,
  false,
  'заблокирован к продаже даже при остатке',
);
assert.equal(isLentaInStock({ count: 6 }), true);

// Сервис цен самого сайта: акция есть, когда price !== priceRegular. Скидка
// приезжает тем же ответом, что и цена, отдельный запрос не нужен — как у
// Магнита, только у Ленты зачёркнутая цена отдаётся явно, а не вытаскивается
// из вёрстки.
assert.equal(normalizeLentaItem(card, ctx, ALIAS)?.oldPrice, 239.99);

// Обычная цена без акции: priceRegular == price -> oldPrice не выдумывается.

// Весовой товар. Числа согласованы с живой сетью (2026-10-01, 10 весовых
// товаров): price = cost × netWeight/1000. То есть price — цена ЗА ФАСОВКУ, а
// cost — цена ЗА КИЛОГРАММ. Раньше здесь стояло обратное правило («для
// весового брать cost») — на живом товаре оно давало бы 120 ₽ вместо 180 ₽ за
// тушку, и на весовом фикстуры не было вовсе.
const weighItem: LentaItem = {
  id: 1,
  name: 'Весовая фасовка',
  slug: 'ves',
  storeId: 3090,
  features: { isWeight: true },
  weight: { net: 1500 },
  saleLimit: { minSaleQuantity: 1 },
  prices: { price: 18000, priceRegular: 24000, cost: 12000, costRegular: 16000 },
};
const weighedNormalized = normalizeLentaItem(weighItem, ctx, ALIAS);
assert.equal(weighedNormalized?.price, 180, 'весовой: цена за фасовку');
assert.equal(weighedNormalized?.oldPrice, 240, 'зачёркнута цена за фасовку, а не за кг');
assert.equal(weighedNormalized?.unitPrice, '120,00 ₽/кг', 'цена за килограмм — отдельно');
assert.equal(
  normalizeLentaItem({ ...weighItem, features: { isWeight: false } }, ctx, ALIAS)?.price,
  180,
  'не весовой — price',
);
assert.equal(
  normalizeLentaItem({ ...weighItem, features: { isWeight: false } }, ctx, ALIAS)?.unitPrice,
  undefined,
  'у невесового товара цены за кг нет',
);
assert.equal(
  normalizeLentaItem(
    { ...weighItem, weight: { net: 400 }, prices: { price: 4800, cost: 12000 } },
    ctx,
    ALIAS,
  )?.unitPrice,
  '120,00 ₽/кг',
  'вес меньше килограмма — всё равно весовой, цена за кг та же',
);
const plain = normalizeLentaItem(
  { ...card, prices: { price: 23999, priceRegular: 23999, isPromoactionPrice: false } },
  ctx,
  ALIAS,
);
assert.equal(plain?.price, 239.99);
assert.equal(plain?.oldPrice, null);
assert.equal(plain?.promoPrice, null);

// Листинг витрины: цену и наличие отдаёт, а бренда и фасовки в нём нет.
assert.throws(() => normalizeLentaSearch({ result: { items: [{ ...card, storeId: 1 }] } }, ctx, ALIAS, 5), /чужому/);

// Поиск: живой ответ jrpc/searchItems от 2026-09-29. В нём маркера магазина
// нет, поэтому нормализуем и с настоящим alias — регресс «падает на первом
// товаре, когда сверка работает» обязан быть виден тесту.
const searchBody = JSON.parse(fs.readFileSync('tests/fixtures/lenta-search.json', 'utf-8')) as {
  total: number;
  items: LentaItem[];
};
const searchRaw = { result: searchBody };
const found = normalizeLentaSearch(searchRaw, ctx, null, 12);
assert.equal(normalizeLentaSearch(searchRaw, ctx, ALIAS, 12).length, found.length, 'alias не роняет выдачу');
assert.equal(found.length, searchBody.items.length, 'выдача нормализовалась целиком');
assert.ok(found.every((p) => p.price > 0 && p.storeId === 'lenta' && p.city === 'moscow'));
const milk = found[0];
assert.equal(milk?.canonicalId, 'lenta-359472');
assert.equal(milk?.price, 229.99, 'копейки из живого ответа');
assert.equal(milk?.oldPrice, 264.99);
assert.equal(milk?.promoPrice, null);
assert.equal(milk?.unit, '2000мл', 'в выдаче фасовка в package, а не в weight.package');
assert.equal(milk?.brand, undefined, 'в выдаче атрибутов нет — бренд не выдумываем');
assert.equal(
  milk?.url,
  'https://lenta.com/product/moloko-past-pitevoe-32-4-bez-zmzh-rossiya-2000ml-359472/',
);
assert.equal(
  normalizeLentaSearch({ result: { items: [] } }, ctx, null, 12).length,
  0,
  'сеть иногда отвечает 200 с total: 0 — это пусто, а не товар',
);
assert.throws(() => normalizeLentaSearch({} as never, ctx, null, 12), /без result/);
assert.throws(
  () => normalizeLentaSearch({ result: { items: [{ id: 1, name: 'x' }] } }, ctx, null, 12),
  /без цен/,
  'непустой ответ без цен — смена формата, а не «не нашлось»',
);
assert.ok(searchBody.items.every((i) => i.storeId === undefined), 'в выдаче нет storeId');
assert.ok(
  searchBody.items.some((i) => (i.count ?? 0) > (i.saleLimit?.maxSaleQuantity ?? 0)),
  'в живой выдаче count больше saleLimit.maxSaleQuantity — count это остаток, а не лимит заказа',
);

// В живой выдаче есть и товар без акции (price == priceRegular) — зачёркнутую
// цену для него выдумывать нельзя.
const plainFromSearch = normalizeLentaSearch(
  { result: { items: [{ ...searchBody.items[0], prices: { price: 7499, priceRegular: 7499 } }] } },
  ctx,
  null,
  12,
);
assert.equal(plainFromSearch[0]?.price, 74.99);
assert.equal(plainFromSearch[0]?.oldPrice, null);
assert.equal(plainFromSearch[0]?.promoPrice, null);

// categoryId в поиске — ловушка: с categoryId: 0 сеть отвечает 200 и total: 0.
const body = lentaSearchBody('молоко', 12) as { params: Record<string, unknown> };
assert.deepEqual(Object.keys(body.params).sort(), ['count', 'filters', 'offset', 'query']);
assert.ok(!('categoryId' in body.params), 'categoryId в params не передаём — сеть отдаст пустую выдачу');
assert.equal(body.params.query, 'молоко');

console.log('lenta: OK — цены, промо, наличие, инвариант магазина, поиск, регионы');

// ─── Форма выдачи 2026-10-01 (15 ключей) против формы 2026-09-29 (9 ключей) ───
// Сеть поменяла форму: признак продажи уехал в features, вес приходит верхним
// уровнем в netWeight, а не в weight.net. На этом этапе price у весового товара
// читался как 0 грамм, и в историю уходила цена фасовки вместо цены за кг.
const searchNew = JSON.parse(
  fs.readFileSync('tests/fixtures/lenta-search-2026-10-01.json', 'utf-8'),
) as { result: { total: number; items: LentaItem[] } };

const weighed = searchNew.result.items.find((i) => i.id === 626150);
assert.ok(weighed, 'в фикстуре есть весовой товар 626150');
assert.equal(weighed.features?.isWeight, true);
assert.equal(weighed.weight, undefined, 'в выдаче нет weight.net — вес только в netWeight');
// Арифметика сети, проверена на 10 весовых товарах: price = cost × netWeight/1000.
assert.equal(weighed.prices?.price, 53198);
assert.equal(weighed.prices?.cost, 27999);
assert.equal(weighed.netWeight, 1900);
assert.equal(
  Math.round(((weighed.prices?.cost ?? 0) * (weighed.netWeight ?? 0)) / 1000 / 100),
  Math.round((weighed.prices?.price ?? 0) / 100),
  'цена за фасовку = цена за кг × вес',
);

const pairWeighed = lentaPricePair(weighed);
assert.equal(pairWeighed.price, 53198, 'ценой товара у весового остаётся цена за фасовку');
assert.equal(pairWeighed.perKg, 27999, 'цена за кг уходит отдельно');
assert.equal(lentaWeightLabel(weighed), '1,9 кг', 'фасовка собирается из веса и unitName');

const wProduct = normalizeLentaItem(weighed, ctx, ALIAS, false);
assert.ok(wProduct, 'весовой товар нормализовался');
assert.equal(wProduct.price, 531.98, 'цена за 1,9 кг — 531,98 ₽, а не 279,99 ₽/кг');
assert.equal(wProduct.unitPrice, '279,99 ₽/кг', 'цена за килограмм видна отдельно и с копейками');
assert.equal(wProduct.unit, '1,9 кг', 'фасовка «1,9 кг» нужна для склейки с другими сетями');
assert.equal(wProduct.oldPrice, null, 'акции нет');
assert.equal(wProduct.promoPrice, null, 'promoPrice у Ленты всегда null');

// Весовой товар с акцией: priceRegular — цена за фасовку, costRegular сеть не
// обновила (249,99 против фактических 284,99 за кг), поэтому зачёркнутую цену
// берём из priceRegular, а не из costRegular.
const weighedPromo = searchNew.result.items.find((i) => i.id === 692573);
assert.ok(weighedPromo, 'в фикстуре есть весовой товар с акцией');
const promoProduct = normalizeLentaItem(weighedPromo, ctx, ALIAS, false);
assert.equal(promoProduct?.price, 199.99);
assert.equal(promoProduct?.oldPrice, 227.99, 'зачёркнута цена за фасовку');
assert.equal(promoProduct?.unitPrice, '249,99 ₽/кг');
assert.equal(promoProduct?.unit, '0,8 кг');

// Обычный (невесовой) товар: цена за кг не выдумывается.
const plainItem = searchNew.result.items.find((i) => i.id === 766317);
assert.ok(plainItem, 'в фикстуре есть невесовой товар 766317');
const plainProduct = normalizeLentaItem(plainItem as LentaItem, ctx, ALIAS, false);
assert.equal(plainProduct?.price, 219.99);
assert.equal(plainProduct?.unitPrice, undefined, 'у невесового товара цены за кг нет');
assert.equal(plainProduct?.unit, '450г');

// Наличие приходит в двух местах: верхним уровнем (карточка, фикстура
// 2026-09-29) и в features (выдача, фикстура 2026-10-01). Проверяем оба и
// отсутствие обоих.
assert.equal(isLentaInStock({ isBlockedForSale: true, count: 5 }), false, 'флаг сверху');
assert.equal(isLentaInStock({ features: { isBlockedForSale: true }, count: 5 }), false, 'флаг в features');
assert.equal(isLentaInStock({ count: 0 }), false, 'нулевой остаток');
assert.equal(isLentaInStock({ count: 5 }), true);
assert.equal(isLentaInStock({}), true, 'без признаков наличия не выдумываем блокировку');
assert.equal(searchNew.result.items[0]?.isBlockedForSale, undefined, 'в выдаче флага сверху нет');
assert.equal(searchNew.result.items[0]?.features?.isBlockedForSale, false);

// Лестница запросов для поиска товара по названию. Проверяем длины обрезков, а
// не сами строки: считать символы в тесте вручную — источник ложных падений.
const longName = 'Молоко Домик в деревне пастеризованное 2.5% 930мл';
const ladder = lentaNameQueries(longName);
assert.equal(ladder.length, 3, 'полное имя, потом 40 и 25 символов');
assert.equal(ladder[0], longName, 'первая попытка — полное название');
assert.equal(ladder[1], longName.slice(0, 40));
assert.equal(ladder[2], longName.slice(0, 25));
assert.ok(longName.length > 40, 'имя длиннее 40 символов, иначе лестница не проверяется');
assert.deepEqual(lentaNameQueries('Короткое'), ['Короткое'], 'короткое имя не режем');
assert.deepEqual(lentaNameQueries('   '), [], 'пустого имени нет');

// ─── fetchProduct: карточка по id закрыта WAF, ищем по названию ───
// Подменяем fetch: сессия и привязка магазина отвечают как обычно, поиск отдаёт
// выдачу из фикстуры. Проверяем, что товар берётся по id, а не по совпадению
// названия, и что «не нашли» — это ProductLookupError, а не сетевой отказ.
type FetchCall = { url: string; method: string; body: string };
function stubFetch(items: LentaItem[], log: FetchCall[]): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    log.push({ url, method, body: String(init?.body ?? '') });
    const json = (payload: unknown): Response =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/api/rest/sessionGet')) {
      return json({ Head: { Status: 'success' }, Body: { SessionToken: 'T' } });
    }
    if (url.includes('/delivery/mode/set')) return json({ storeId: 4161, type: 'pickup' });
    if (url.includes('/delivery/mode')) return new Response('<!DOCTYPE html>', { status: 401 });
    if (url.includes('/jrpc/searchItems')) {
      // Живая выдача фильтрует по релевантности: на несовпадении запроса
      // товара в ответе нет. Стаб повторяет это, иначе «нашлось бы» всегда.
      const query = String((JSON.parse(String(init?.body ?? '{}')) as { params?: { query?: string } }).params?.query ?? '')
        .toLowerCase();
      const matched = items.filter((it) => String(it.name ?? '').toLowerCase().includes(query));
      return json({ result: { total: matched.length, items: matched } });
    }
    throw new Error(`незапланированный запрос: ${method} ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

const adapterCtx = { city: 'moscow', externalStoreId: '4161' };
{
  const log: FetchCall[] = [];
  const restore = stubFetch([weighed as LentaItem, plainItem as LentaItem], log);
  try {
    const adapter = new LentaAdapter();
    const p = await adapter.fetchProduct('lenta-626150', {
      ...adapterCtx,
      name: 'Тушка цыпленка-бройлера ПЕТЕЛИНКА 1 сорт, потрошеная, весовая',
    });
    assert.equal(p.canonicalId, 'lenta-626150');
    assert.equal(p.price, 531.98);
    assert.equal(p.unitPrice, '279,99 ₽/кг');
    const searches = log.filter((c) => c.url.includes('jrpc/searchItems'));
    assert.equal(searches.length, 1, 'полное имя нашло товар одним запросом');
    assert.ok(
      !log.some((c) => c.url.includes('/catalog/items/')),
      'заблокированный карточный GET не используется',
    );

    // Название в базе устарело (товар переименовали) — полное имя не находит,
    // находит обрезанное.
    const before = log.filter((c) => c.url.includes('jrpc/searchItems')).length;
    const renamed = await adapter.fetchProduct('lenta-766317', {
      ...adapterCtx,
      name: 'Печень куриная ПЕТЕЛИНКА, 450г (старое название)',
    });
    assert.equal(renamed.canonicalId, 'lenta-766317', 'нашлось по обрезанному имени');
    assert.equal(
      log.filter((c) => c.url.includes('jrpc/searchItems')).length - before,
      3,
      'полное имя и 40 символов не нашли, 25 символов нашли',
    );

    // Выдача есть, но НАШЕГО товара в ней нет — это ProductLookupError: сеть
    // ответила, товар переименован или снят. Паузу сети ставить нельзя.
    await assert.rejects(
      () => adapter.fetchProduct('lenta-626150', { ...adapterCtx, name: 'Печень куриная ПЕТЕЛИНКА, 450г (другое)' }),
      (err: unknown) => {
        assert.ok(isProductLookupError(err), 'выдача была, нашего id нет — отдельный класс, не отказ сети');
        assert.match(String((err as Error).message), /не найден/);
        return true;
      },
    );

    // Выдачи НЕТ вовсе (200 + total: 0 — та же ловушка, что categoryId: 0) —
    // это отказ сети, а не «переименование». Иначе breaker не сработает и
    // история цены молча замрёт.
    await assert.rejects(
      () => adapter.fetchProduct('lenta-626150', { ...adapterCtx, name: 'Абсолютно посторонний товар' }),
      (err: unknown) => {
        assert.ok(!isProductLookupError(err), 'пустая выдача — обычная сетевая ошибка, breaker должен сработать');
        assert.match(String((err as Error).message), /пустую выдачу/);
        return true;
      },
    );

    // Без названия в базе искать нечем — тоже ProductLookupError, а не пустой
    // товар: молчаливый skip here означал бы, что товар просто выпал из опроса.
    await assert.rejects(
      () => adapter.fetchProduct('lenta-626150', adapterCtx),
      (err: unknown) => isProductLookupError(err) && /нет названия/.test(String((err as Error).message)),
    );
  } finally {
    restore();
  }
}

console.log('lenta: OK — форма 2026-10-01, весовой товар, наличие в двух видах, fetchProduct по названию');

// ─── Сессия: протухание токена не должно убивать сеть навсегда ───
// Процесс живёт днями (опрос каждые 6 ч), а SessionToken у сети не бессрочный.
// Без пересоздания сессии Лента замирала бы до перезапуска приложения. Стаб
// отдаёт 401 на первый searchItems и 200 на второй — то есть ведёт себя как
// сеть, у которой протух токен.
{
  const log: FetchCall[] = [];
  let searches = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    log.push({ url, method, body: String(init?.body ?? '') });
    const json = (payload: unknown): Response =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/api/rest/sessionGet')) {
      return json({ Head: { Status: 'success' }, Body: { SessionToken: `T${log.filter((c) => c.url.includes('sessionGet')).length}` } });
    }
    if (url.includes('/delivery/mode/set')) return json({ storeId: 4161, type: 'pickup' });
    if (url.includes('/delivery/mode')) return new Response('<!DOCTYPE html>', { status: 401 });
    if (url.includes('/jrpc/searchItems')) {
      searches += 1;
      if (searches === 1) return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
      return json({ result: { total: 1, items: [weighed] } });
    }
    throw new Error(`незапланированный запрос: ${method} ${url}`);
  }) as typeof fetch;
  try {
    const adapter = new LentaAdapter();
    const p = await adapter.fetchProduct('lenta-626150', {
      city: 'moscow',
      externalStoreId: '4161',
      name: 'Тушка цыпленка-бройлера ПЕТЕЛИНКА 1 сорт, потрошеная, весовая',
    });
    assert.equal(p.price, 531.98, 'после 401 сессия пересоздана и запрос повторён');
    const sessionGets = log.filter((c) => c.url.includes('sessionGet')).length;
    assert.equal(sessionGets, 2, 'сессия запрошена повторно после 401');
    // Второй вызов в пределах TTL сессию не пересоздаёт.
    await adapter.fetchProduct('lenta-626150', {
      city: 'moscow',
      externalStoreId: '4161',
      name: 'Тушка цыпленка-бройлера ПЕТЕЛИНКА 1 сорт, потрошеная, весовая',
    });
    assert.equal(
      log.filter((c) => c.url.includes('sessionGet')).length,
      sessionGets,
      'в пределах TTL сессия переиспользуется',
    );
    // Привязка магазина подтверждается раз в TTL, а не на каждый товар. После
    // пересоздания сессии привязка обязана подтвердиться заново (новая сессия
    // ничего не знает), поэтому здесь считаем «не выросло», а не «равно 1».
    const setCalls = log.filter((c) => c.url.includes('/delivery/mode/set')).length;
    assert.ok(setCalls >= 1, 'после 401 привязка магазина подтверждена заново');
    await adapter.fetchProduct('lenta-626150', {
      city: 'moscow',
      externalStoreId: '4161',
      name: 'Тушка цыпленка-бройлера ПЕТЕЛИНКА 1 сорт, потрошеная, весовая',
    });
    assert.equal(
      log.filter((c) => c.url.includes('/delivery/mode/set')).length,
      setCalls,
      'mode/set не повторяется на каждый товар',
    );
  } finally {
    globalThis.fetch = real;
  }
}

console.log('lenta: OK — сессия пересоздаётся после 401, привязка магазина не переспрашивается');

// ─── Ретрай ограничен одной попыткой ───
// Если сеть режет даже свежевыданную сессию, повторять sessionGet бесконечно
// нельзя: это и сетевой шум, и зацикливание. Ровно одна попытка, потом throw.
{
  const log: FetchCall[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    log.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const adapter = new LentaAdapter();
    await assert.rejects(() =>
      adapter.fetchProduct('lenta-626150', {
        city: 'moscow',
        externalStoreId: '4161',
        name: 'Тушка цыпленка-бройлера ПЕТЕЛИНКА',
      }),
    );
    assert.equal(
      log.filter((c) => c.url.includes('sessionGet')).length,
      1,
      'sessionGet запрошен ровно один раз — ретрай не зацикливается',
    );
  } finally {
    globalThis.fetch = real;
  }
}

console.log('lenta: OK — ретрай ограничен одной попыткой');

// ─── Товары каталога Ленты: та же нормализация, другая форма (HAR 2026-10-01) ───
// В `catalog/items` вес лежит в `weight.net`, а в выдаче `searchItems` — в
// `netWeight` верхним уровнем. Проверяем, что весовой товар из КАТАЛОГА не
// теряет цену за килограмм: цена = за фасовку, cost = за кг.
const catItems = JSON.parse(
  fs.readFileSync('tests/fixtures/lenta-catalog-items.json', 'utf-8'),
) as { _request: { categoryId: number; limit: number; offset: number }; total: number; items: LentaItem[] };

assert.equal(catItems._request.limit, 40, 'витрина просит limit — значит пагинация на стороне сети есть');
assert.equal(catItems._request.offset, 0);
assert.equal(catItems.total, 10, 'total нужен для «показано 10 из N»');

const weighedCat = catItems.items.find((i) => i.id === 301593);
assert.ok(weighedCat, 'в фикстуре есть весовой товар 301593');
assert.equal(weighedCat.features?.isWeight, true);
assert.equal(weighedCat.weight?.net, 500, 'у карточки каталога вес в weight.net');
assert.ok(!weighedCat.netWeight, 'верхний netWeight в карточке каталога пуст — вес только в weight.net');
const catProduct = normalizeLentaItem(weighedCat, ctx, ALIAS, false);
assert.equal(catProduct?.price, 90, 'цена за 0,5 кг — 90 ₽, а не 179,99 ₽/кг');
assert.equal(catProduct?.unitPrice, '179,99 ₽/кг');
assert.equal(catProduct?.unit, '0,5 кг');
assert.equal(
  Math.round(179.99 * 0.5),
  catProduct?.price,
  'цена за фасовку = цена за кг × вес (с точностью до копейки)',
);

// Невесовой товар в том же ответе: цены за кг быть не должно.
const plainCat = catItems.items.find((i) => i.features?.isWeight !== true);
assert.ok(plainCat, 'в фикстуре есть и невесовой товар');
const plainCatProduct = normalizeLentaItem(plainCat, ctx, ALIAS, false);
assert.equal(plainCatProduct?.unitPrice, undefined, 'у невесового цены за кг нет');
assert.ok((plainCatProduct?.price ?? 0) > 0, 'невесовой товар получил цену');

// Ни один товар каталога не должен нормализоваться в ноль молча: пустая
// полка из-за смены формы страшнее громкой ошибки.
const catNormalized = catItems.items.map((i) => normalizeLentaItem(i, ctx, ALIAS, false));
assert.equal(
  catNormalized.filter(Boolean).length,
  catItems.items.length,
  'все товары каталога нормализовались',
);

console.log('lenta: OK — товары каталога: вес в weight.net, цена за фасовку и за кг');
