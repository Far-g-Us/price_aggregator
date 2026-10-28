// Фильтры выдачи: цена «от/до» и «есть в N сетях».
//
// Функция живёт в src/shared, а не в renderer, иначе её не покрыл бы гейт:
// src/renderer из проверки покрытия исключён.

import assert from 'node:assert';
import type { ScrapedProduct, Store } from '../src/shared/types.js';
import type { PriceGroup } from '../src/shared/matching.js';
import {
  filterPriceGroups,
  groupPrice,
  groupPriceRange,
  groupStoreCount,
  parsePriceFilter,
  priceRangeInverted,
  type ResultFilters,
} from '../src/shared/result-filters.js';

const item = (storeId: Store['id'], price: number, promo: number | null = null): ScrapedProduct => ({
  canonicalId: `${storeId}-${price}`,
  storeId,
  city: 'moscow',
  storeCode: 'TEST',
  name: 'Молоко',
  unit: '1 шт',
  price,
  promoPrice: promo,
  oldPrice: null,
  inStock: true,
  url: 'https://example.com/p',
  collectedAt: '2026-11-11T10:00:00.000Z',
});

const group = (key: string, ...offers: Array<{ storeId: Store['id']; price: number; promo?: number }>): PriceGroup => ({
  key,
  name: `Товар ${key}`,
  offers: offers.map((o) => ({ storeId: o.storeId, storeCode: 'TEST', product: item(o.storeId, o.price, o.promo ?? null) })),
});

const gCheap = group('cheap', { storeId: 'magnit', price: 90 });
const gMid = group('mid', { storeId: 'magnit', price: 150 }, { storeId: 'lenta', price: 140 });
const gWide = group('wide', { storeId: 'magnit', price: 90 }, { storeId: 'lenta', price: 400 });
const gPromo = group('promo', { storeId: 'svetofor', price: 200, promo: 75 });
const gOne = group('one', { storeId: 'chizhik', price: 300 });
const all = [gCheap, gMid, gWide, gPromo, gOne];

// Цена карточки — минимальная действующая, и промо там считается.
assert.equal(groupPrice(gPromo), 75, 'промо-цена и есть цена карточки');
assert.equal(groupPrice(gWide), 90, 'берётся минимум по сетям, а не цена первой сети');

// Число сетей — по разным storeId, а не по числу предложений: два товара одной
// сети в одной группе (200 мл и 900 мл) — это одна сеть.
assert.equal(groupStoreCount(gMid), 2, 'две сети посчитаны двумя');
const gSameStoreTwice: PriceGroup = {
  key: 'same',
  name: 'Товар same',
  offers: [
    { storeId: 'magnit', storeCode: 'TEST', product: item('magnit', 100) },
    { storeId: 'magnit', storeCode: 'TEST', product: item('magnit', 200) },
  ],
};
assert.equal(groupStoreCount(gSameStoreTwice), 1, 'две цены одной сети — одна сеть');

// Диапазон цен и число точек: шапка карточки обязана говорить «от … до …»,
// потому что у двух точек одной сети цены разные, а одна цифра была бы враньём.
{
  const twoPoints: PriceGroup = {
    key: 'magnit:MK1:milk',
    name: 'Молоко',
    offers: [
      { storeId: 'magnit', storeCode: 'MK1', product: item('magnit', 119) },
      { storeId: 'magnit', storeCode: 'MK2', product: item('magnit', 105) },
    ],
  };
  const range = groupPriceRange(twoPoints);
  assert.equal(range.min, 105, 'минимум — по всем точкам');
  assert.equal(range.max, 119, 'и максимум тоже, а не «цена первой строки»');
  assert.equal(range.points, 2, 'две точки одной сети — две точки, а не одна сеть');
  assert.equal(groupStoreCount(twoPoints), 1, 'но для счётчика сетей это по-прежнему одна сеть');

  const samePrice = groupPriceRange({
    ...twoPoints,
    offers: [
      { storeId: 'magnit', storeCode: 'MK1', product: item('magnit', 100) },
      { storeId: 'magnit', storeCode: 'MK2', product: item('magnit', 100) },
    ],
  });
  assert.equal(samePrice.min, samePrice.max, 'одинаковые цены — диапазон вырожденный');
  assert.equal(samePrice.points, 2, 'но точки всё равно две');

  // Промо-цена точки идёт в диапазон, а не обычная: у карточки с акцией одна
  // точка дешевле, и диапазон обязан считать по действующей цене.
  const withPromo = groupPriceRange({
    ...twoPoints,
    offers: [
      { storeId: 'magnit', storeCode: 'MK1', product: item('magnit', 200, 150) },
      { storeId: 'magnit', storeCode: 'MK2', product: item('magnit', 120) },
    ],
  });
  assert.equal(withPromo.min, 120, 'промо-цена первой точки учтена как действующая');
  assert.equal(withPromo.max, 150, 'и не как старая 200 ₽');
}

// Разбор поля: пусто, мусор и запятая.
assert.equal(parsePriceFilter(''), null, 'пустое поле — границы нет');
assert.equal(parsePriceFilter('   '), null, 'пробелы — то же пустое поле');
assert.equal(parsePriceFilter('abc'), null, 'мусор не должен превращаться в NaN');
assert.equal(parsePriceFilter('1e5'), 100000, 'экспоненная запись — честное число, а не мусор');
assert.equal(parsePriceFilter('-'), null, 'один минус — не граница');
assert.equal(parsePriceFilter(' 120 '), 120, 'пробелы по краям не мешают');
assert.equal(parsePriceFilter('120,50'), 120.5, 'запятая — десятичный разделитель');
assert.equal(parsePriceFilter('0'), 0, 'ноль — честная граница, а не «пусто»');

// Ничего не задано — выдача идёт вся и в том же порядке. Пустые условия
// задаются здесь, а не константой из модуля: такая константа была бы единственным
// потребителем и висела бы в модуле без применения.
const NO_FILTERS: ResultFilters = { priceFrom: null, priceTo: null, minStores: 1 };
assert.deepEqual(filterPriceGroups(all, NO_FILTERS), all, 'без условий отбор прозрачен');

// Диапазон цены: обе границы включительные, применяются к минимуму по сетям.
assert.deepEqual(
  filterPriceGroups(all, { priceFrom: 90, priceTo: 150, minStores: 1 }).map((g) => g.key),
  ['cheap', 'mid', 'wide'],
  'сравнивается минимум по сетям (карточка с ценами 90 и 400 проходит «до 150»);' +
    ' промо-карточка за 75 отсекается нижней границей 90',
);
assert.deepEqual(
  filterPriceGroups(all, { priceFrom: 91, priceTo: null, minStores: 1 }).map((g) => g.key),
  ['mid', 'one'],
  'нижняя граница включительная: ровно 90 проходит, 91 — нет; промо-карточка за 75 тоже ниже',
);
assert.deepEqual(
  filterPriceGroups(all, { priceFrom: null, priceTo: 90, minStores: 1 }).map((g) => g.key),
  ['cheap', 'wide', 'promo'],
  'верхняя граница включительная, промо-цена считается',
);

// Перепутанные границы: выдача пустеет и это НЕ чинится молча.
const inverted = { priceFrom: 200, priceTo: 100, minStores: 1 };
assert.deepEqual(filterPriceGroups(all, inverted), [], 'от 200 до 100 несовместимы');
assert.equal(priceRangeInverted(inverted), true, 'и интерфейс должен сказать об этом у полей');
assert.equal(priceRangeInverted({ priceFrom: 100, priceTo: 100, minStores: 1 }), false, 'равные границы законны');
assert.equal(priceRangeInverted({ priceFrom: null, priceTo: 100, minStores: 1 }), false, 'одна граница — не путаница');
assert.equal(priceRangeInverted({ priceFrom: 100, priceTo: null, minStores: 2 }), false, 'перепутанность — только про цену');

// «В N сетях»: считается по предложениям, пережившим отбор, поэтому пара с
// minStores = 3 оставляет карточки ровно с тремя разными сетками.
assert.deepEqual(
  filterPriceGroups(all, { priceFrom: null, priceTo: null, minStores: 2 }).map((g) => g.key),
  ['mid', 'wide'],
  'в двух сетях — обе двухсетевые карточки',
);
assert.deepEqual(
  filterPriceGroups(all, { priceFrom: null, priceTo: null, minStores: 3 }),
  [],
  'в трёх сетях никого: ни одна карточка столько не набрала',
);

// Совмещение условий: и цена, и число сетей.
assert.deepEqual(
  filterPriceGroups(all, { priceFrom: 100, priceTo: null, minStores: 2 }).map((g) => g.key),
  ['mid'],
  'границы считаются по минимуму: у «mid» цены 150 и 140, до нижней границы 100 он дотягивает',
);
assert.deepEqual(
  filterPriceGroups(all, { priceFrom: 100, priceTo: 145, minStores: 2 }).map((g) => g.key),
  ['mid'],
  'а «wide» с ценами 90 и 400 отсекается нижней границей 100 — минимум решает',
);

// Неизвестная цена фильтр НЕ прячет: данные с NaN — повод разбираться, а не
// повод тихо убрать товар из выдачи.
const gBroken: PriceGroup = {
  key: 'broken',
  name: 'Товар broken',
  offers: [{ storeId: 'magnit', storeCode: 'TEST', product: { ...item('magnit', 0), price: Number.NaN } }],
};
assert.deepEqual(
  filterPriceGroups([gBroken], { priceFrom: 100, priceTo: 1000, minStores: 1 }).map((g) => g.key),
  ['broken'],
  'неизвестная цена проходит мимо границ',
);
assert.ok(Number.isNaN(groupPrice(gBroken)), 'но сама цена действительно NaN — это данные, а не фильтр');

console.log('result filters: ALL GREEN — цена от/до, число сетей, границы, пустой ввод, NaN');
