// Тесты нормализации Перекрёстка на ЖИВЫХ фикстурах (снято 2026-10-10).
//
// Три ловушки, ради которых файл и написан, проверяются здесь первыми и самыми
// жёсткими:
//   - цена в копейках (`9799` = 97.99 ₽);
//   - при акции `price` — цена ПОСЛЕ скидки, `grossPrice` — до неё;
//   - наличие приходит строкой `balanceState`, и всё, кроме «many», должно
//     оставаться «неизвестно», а не «нет в наличии».

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isStrictPerekrestokSearch,
  normalizePerekrestokFeed,
  normalizePerekrestokItem,
  perekrestokSapId,
} from '../src/core/adapters/perekrestok-parse.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/perekrestok', name), 'utf8'));

const ctx = { city: 'moscow' as const, externalStoreId: '2053', sapId: '2053' };

const milk = fixture('feed-moloko.json');
const promo = fixture('feed-promo.json');
const junk = fixture('feed-empty-junk.json');
const page2 = fixture('feed-page2.json');

// --- маркеры ответа ---------------------------------------------------------
assert.equal(perekrestokSapId(milk), '2053', 'точка в ответе: sapId');
assert.equal(perekrestokSapId({}), null, 'нет content — нет и точки');
assert.equal(perekrestokSapId({ content: { sapId: 2053 } }), null, 'sapId приходит строкой, не числом');
assert.equal(isStrictPerekrestokSearch(milk), true, 'поиск строгий — так пишет сама сеть');
assert.equal(isStrictPerekrestokSearch({ content: { searchType: 'popular' } }), false, 'популярная выдача — не строгая');
assert.equal(isStrictPerekrestokSearch({}), false, 'нет метки строгости — считаем, что строгости нет');

// --- цена в копейках ---------------------------------------------------------
const first = normalizePerekrestokItem((milk as { content: { items: unknown[] } }).content.items[0], ctx);
assert.ok(first !== null, 'первый товар разобран');
assert.equal(first.price, 97.99, '9799 копеек — это 97.99 ₽, а не 9799 ₽');
assert.equal(first.name, 'Молоко Домик в деревне стерилизованное 3.2% , 950г');
assert.equal(first.storeId, 'perekrestok');
assert.equal(first.city, 'moscow');
assert.equal(first.canonicalId, 'perekrestok:2059346');
assert.equal(first.unit, 'шт', 'единица из masterData.unitName');
assert.equal(first.inStock, true, 'balanceState «many» → есть в наличии');
assert.match(first.imageUrl ?? '', /^https:\/\/tsx\.x5static\.net\/i\/320x320\//, 'картинка: шаблон с %s подставлен');
assert.equal(first.url, 'https://www.perekrestok.ru/catalog/product/moloko-domik-v-derevne-sterilizovannoe-3-2-950g/');
assert.ok(first.promoPrice == null, 'без скидки promoPrice не задан (null или отсутствует)');
assert.ok(first.oldPrice == null, 'без скидки oldPrice не задан (null или отсутствует)');

// --- акция: price = после скидки, grossPrice = до --------------------------
const discounted = normalizePerekrestokFeed(milk, ctx).find((p) => p.oldPrice != null);
assert.ok(discounted !== undefined, 'в живой выгрузке есть товар со скидкой');
assert.equal(discounted.oldPrice, 139.99, 'grossPrice 13999 копеек — это 139.99 ₽');
assert.equal(discounted.promoPrice, 126.99, 'promoPrice — цена ПОСЛЕ скидки (price из ответа)');
assert.equal(discounted.price, 139.99, 'обычная цена товара — до скидки, иначе история покажет скачок на каждой акции');

// --- наличие: неизвестное ≠ «нет в наличии» ---------------------------------
assert.equal(normalizePerekrestokItem({ masterData: { plu: '1' }, title: 'X', priceTag: { price: 100 } }, ctx)?.inStock, undefined, 'нет balanceState — наличие неизвестно');
assert.equal(normalizePerekrestokItem({ masterData: { plu: '1' }, title: 'X', priceTag: { price: 100 }, balanceState: 'many' }, ctx)?.inStock, true, '«many» — есть');
assert.equal(
  normalizePerekrestokItem({ masterData: { plu: '1' }, title: 'X', priceTag: { price: 100 }, balanceState: 'few' }, ctx)?.inStock,
  undefined,
  '«few» не подтверждён живыми данными — догадка в наличие не идёт',
);
assert.equal(normalizePerekrestokItem({ masterData: { plu: '1' }, title: 'X', priceTag: { price: 100 }, balanceState: 'что-то' }, ctx)?.inStock, undefined, 'незнакомое значение не превращается в «нет в наличии»');

// --- мусорный запрос = честная пустота --------------------------------------
assert.deepEqual(normalizePerekrestokFeed(junk, ctx), [], 'мусорный запрос → пустой список, а не popular');

// --- пагинация: вторая страница — другие товары -----------------------------
const firstPage = normalizePerekrestokFeed(milk, ctx).map((p) => p.canonicalId);
const secondPage = normalizePerekrestokFeed(page2, ctx).map((p) => p.canonicalId);
assert.ok(firstPage.length > 0 && secondPage.length > 0, 'обе страницы непустые');
assert.equal(
  firstPage.some((id) => secondPage.includes(id)),
  false,
  'страницы не повторяют друг друга (пагинация работает)',
);

// --- промо-витрина ----------------------------------------------------------
const promoItems = normalizePerekrestokFeed(promo, ctx);
assert.ok(promoItems.length > 0, 'промо-витрина отдала товары');

// --- отказ вместо тихой потери ----------------------------------------------
assert.equal(normalizePerekrestokItem(null, ctx), null, 'null — не товар');
assert.equal(normalizePerekrestokItem({ masterData: { plu: '1' }, title: 'X' }, ctx), null, 'без цены товар не пишется');
assert.equal(normalizePerekrestokItem({ masterData: { plu: '1' }, title: '', priceTag: { price: 100 } }, ctx), null, 'без названия товар не пишется');
assert.equal(
  normalizePerekrestokItem({ masterData: {}, title: 'X', priceTag: { price: 100 } }, ctx),
  null,
  'без plu товар не пишется: по plu мы его и узнаём при опросе',
);
assert.equal(
  normalizePerekrestokItem({ masterData: { plu: '1' }, title: 'X', priceTag: { price: 200_000_000 } }, ctx),
  null,
  'цена в 2 млн ₽ — это дрейф формата, а не цена',
);
assert.equal(normalizePerekrestokFeed({ content: { items: 'не массив' } }, ctx).length, 0, 'items не массив — пусто, а не падение');
assert.equal(normalizePerekrestokFeed({}, ctx).length, 0, 'пустой ответ — пустой список');
assert.equal(normalizePerekrestokFeed(null, ctx).length, 0, 'ответ null — пустой список, а не падение');
assert.equal(normalizePerekrestokFeed({ content: null }, ctx).length, 0, 'content: null — пустой список');
assert.equal(perekrestokSapId(null), null, 'sapId из ответа null — нет точки');
assert.equal(perekrestokSapId({ content: null }), null, 'content: null — нет точки');
assert.equal(isStrictPerekrestokSearch(null), false, 'строгости у null нет');

// --- непустой фид без единого разобранного товара — дрейф, а не пустота ------
// Тихая пустая витрина — самый опасный отказ: сеть жива, формат поехал, breaker
// молчит, а пользователь видит «ничего не найдено».
assert.throws(
  () => normalizePerekrestokFeed({ content: { items: [{ masterData: {}, title: 'Без plu' }] } }, ctx),
  /после разбора не осталось ни одного/,
  'все товары без plu — дрейф формата, а не пустой поиск',
);
// Часть товаров без цены: остальные-то разбираются, и это НЕ дрейф.
const partial = normalizePerekrestokFeed(
  { content: { items: [{ masterData: { plu: '1' }, title: 'Без цены' }, (milk as { content: { items: unknown[] } }).content.items[0]] } },
  ctx,
);
assert.equal(partial.length, 1, 'товар без цены пропущен, нормальный разобран');

// --- цены-не-цены: отрицательная, нулевая и не-число не пишутся -------------
assert.equal(
  normalizePerekrestokItem({ masterData: { plu: '1' }, title: 'X', priceTag: { price: -100 } }, ctx),
  null,
  'отрицательная цена — дрейф, а не скидка',
);
// Ноль в `prices_history` остался бы навсегда записью «0 ₽» и тянул шкалу истории.
assert.equal(
  normalizePerekrestokItem({ masterData: { plu: '1' }, title: 'X', priceTag: { price: 0 } }, ctx),
  null,
  'нулевая цена не пишется: в истории она жила бы вечно',
);
assert.equal(
  normalizePerekrestokItem({ masterData: { plu: '1' }, title: 'X', priceTag: { price: '100' } }, ctx),
  null,
  'цена строкой — дрейф формата',
);
assert.equal(
  normalizePerekrestokItem({ masterData: { plu: 1 }, title: 'X', priceTag: { price: 100 } }, ctx),
  null,
  'plu приходит строкой: числовой — дрейф',
);
assert.equal(
  normalizePerekrestokItem({ masterData: { plu: '1' }, title: 42, priceTag: { price: 100 } }, ctx),
  null,
  'название не строкой — дрейф',
);

// --- grossPrice БЕЗ скидки: цена не ниже «старой» — акции нет ----------------
const noPromo = normalizePerekrestokItem(
  { masterData: { plu: '1' }, title: 'X', priceTag: { price: 10000, grossPrice: 9000 } },
  ctx,
);
assert.ok(noPromo !== null, 'товар без акции разобран');
assert.ok(noPromo.oldPrice == null, 'grossPrice ниже price — это не акция, промо не выдумываем');
assert.equal(noPromo.price, 100, 'цена товара — текущая');

// --- картинка-мусор: без %s подставлять нечего ------------------------------
assert.equal(
  normalizePerekrestokItem({ masterData: { plu: '1' }, title: 'X', priceTag: { price: 100 }, image: null }, ctx)?.imageUrl,
  undefined,
  'нет картинки — поле не задано',
);
assert.equal(
  normalizePerekrestokItem(
    { masterData: { plu: '1' }, title: 'X', priceTag: { price: 100 }, image: { cropUrlTemplate: 'https://x/%d' } },
    ctx,
  )?.imageUrl,
  undefined,
  'шаблон без %s — не картинка, молча не пишем мусорный адрес',
);
// --- единицы и адрес: без них товар всё равно пишется ------------------------
const bare = normalizePerekrestokItem({ masterData: { plu: '1' }, title: 'X', priceTag: { price: 100 } }, ctx);
assert.ok(bare !== null, 'товар без единицы и слага разобран');
assert.equal(bare.unit, undefined, 'единицы нет — поле не задано');
assert.equal(bare.url, undefined, 'слага нет — адрес не выдумываем');

console.log('ALL GREEN — Perekrestok: копейки, скидки, наличие-неизвестно, строгий поиск, пагинация, дрейф-охрана, отказы');