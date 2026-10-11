// Светофор: нормализация на слепке живого прайса + поведение HTTP-слоя.
//
// Фикстура снята как есть с kaluzhskaya-oblast (магазин 649, 552 товара) без
// пересборки формата: это МАССИВ строк, ровно как отдаёт сеть, и именно это
// проверяется здесь. Съём сделан вручную 2026-10-08 командой:
//
//   node scripts/fetch-svetofor-fixture.ts
//
// (скрипт кладёт файл как есть, ничего не преобразуя). Прежняя фикстура была
// пересобрана руками в объект-карту, и это скрыло главный баг сети: адаптер,
// отвергавший массив, не отдал бы ни одной цены.
//
// Сети и браузера здесь нет: подставной `fetch` проверяет адреса, заголовки,
// коды ответа, самолечение метки, кэш и фильтр свежести.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isProductLookupError, isStaleStoreError } from '../src/core/adapter-errors.js';
import {
  SVETOFOR_PRICE_TTL_MS,
  SVETOFOR_STALE_MS,
  SVETOFOR_STAMP_TTL_MS,
  SVETOFOR_TIMEOUT_MS,
  SvetoforAdapter,
  clearSvetoforCache,
  assertSvetoforNewestDate,
  forgetSvetoforStamp,
  nameMatches,
  normalizeSvetoforOffer,
  numbersAgree,
  resolveSvetoforStamp,
  setSvetoforStamp,
  svetoforCanonicalId,
  svetoforImageUrl,
  svetoforOfferDate,
  svetoforPrice,
  svetoforPriceUrl,
  svetoforProductUrl,
  svetoforShelf,
  svetoforShelfFromAnyDomain,
  svetoforShelfFromUrl,
  svetoforShelfUrl,
  svetoforShopUrl,
  svetoforStamp,
  svetoforUnit,
  inSvetoforShelf,
  parseSvetoforMenu,
  svetoforCategoryImageUrl,
  type SvetoforPriceList,
} from '../src/core/adapters/svetofor.js';
import { CITY_TO_SHOP, STORE_DOMAIN, svetoforDomain } from '../src/shared/svetofor-regions.js';
import { CITIES, CITY_STORES } from '../src/shared/catalog.js';

// --- Покрытие городов: справочник и каталог обязаны совпадать ---------------
// Пятнадцать городов добавлены 2026-11 по живой выгрузке сети, и расхождение
// между двумя справочниками — самая вероятная поломка при следующем расширении:
// город есть в интерфейсе, но не в БД (или наоборот), и пользователь видит
// пустой магазин без единого слова об ошибке.
{
  const svetoforInCatalog = CITIES.filter((c) =>
    (CITY_STORES[c.id] ?? []).some((s) => s.storeId === 'svetofor'),
  ).map((c) => c.id);
  assert.deepEqual(
    [...svetoforInCatalog].sort(),
    [...Object.keys(CITY_TO_SHOP)].sort(),
    'города Светофора в каталоге и в CITY_TO_SHOP совпадают',
  );
  for (const city of CITIES) {
    const stores = CITY_STORES[city.id] ?? [];
    assert.ok(stores.length > 0, `в городе ${city.id} есть хотя бы одна сеть`);
    for (const store of stores) {
      if (store.storeId !== 'svetofor') continue;
      // Код в каталоге и в справочнике обязан быть один: расхождение тихо
      // опрашивало бы несуществующий магазин, и цены молчали бы.
      assert.equal(
        store.externalStoreId,
        CITY_TO_SHOP[city.id],
        `код магазина Светофора в городе ${city.id} совпадает со справочником`,
      );
      assert.doesNotThrow(
        () => svetoforDomain(store.externalStoreId),
        `домен магазина ${store.externalStoreId} есть в STORE_DOMAIN`,
      );
    }
  }
}

/** Живая страница региона в windows-1251: для проверки декодирования, а не строк. */
const CP1251_FIXTURE = new URL('../tests/fixtures/svetofor/region-moskva-vostok.cp1251.html', import.meta.url);
const REGION_HTML = '<html><script>var shopid=712; var offersupd=1791443124;</script></html>';

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../tests/fixtures/svetofor/offers-649.json'), 'utf8'),
) as SvetoforPriceList;
const ctx = { city: 'kaluga', domain: 'kaluzhskaya-oblast' };
const rows = fixture;

// Фикстура обязана быть живым форматом: если кто-то пересоберёт её в
// объект-карту, тест перестанет ловить главный баг сети.
assert.ok(Array.isArray(fixture), 'фикстура — массив, как отдаёт сеть');
assert.ok(rows.length > 100, `в фикстуре много товаров: ${rows.length}`);

// ─── нормализация ────────────────────────────────────────────────────────
{
  const items = rows.map((r) => normalizeSvetoforOffer(r, ctx)).filter((x): x is NonNullable<typeof x> => x !== null);
  assert.equal(items.length, rows.length, 'все строки живого прайса нормализуются');

  for (const item of items) {
    assert.equal(item.storeId, 'svetofor', 'storeId константой, а не из ответа');
    assert.equal(item.city, 'kaluga', 'город из контекста');
    assert.ok(item.price > 0, `цена положительная: ${item.name}`);
    assert.equal(item.promoPrice, null, 'скидки у сети нет — null, а не undefined');
    assert.equal(item.oldPrice, null, 'старой цены у сети нет — null, а не undefined');
    assert.equal(item.inStock, true, 'товар в прайсе — есть');
    assert.ok(item.name.trim() !== '', 'название непустое');
    assert.ok(!item.barcode, 'articul магазина в barcode не идёт');
    assert.ok(Number.isFinite(Date.parse(item.collectedAt)), 'время сбора реальное, а не 1970');
    assert.ok(Date.parse(item.collectedAt) > 1_600_000_000_000, 'collectedAt не epoch');
    assert.ok(!item.canonicalId.includes(' '), 'в идентификаторе нет пробелов');
  }

  // Себестоимость в цену не попадает.
  const withCost = rows.find((r) => typeof r.c === 'number' && r.c > 0 && (r.c ?? 0) < (r.p ?? 0));
  if (withCost) {
    const item = normalizeSvetoforOffer(withCost, ctx);
    assert.equal(item?.price, svetoforPrice(withCost.p), 'цена берётся из p, а не из c');
  }
  // Строки, где c > p (в живых данных такие есть), цену не ломают.
  for (const row of rows.filter((r) => typeof r.c === 'number' && typeof r.p === 'number' && r.c > r.p)) {
    assert.equal(normalizeSvetoforOffer(row, ctx)?.price, svetoforPrice(row.p), 'при c > p цена всё равно из p');
  }
}

// ─── цена ────────────────────────────────────────────────────────────────
{
  assert.equal(svetoforPrice(6290), 62.9, 'копейки делятся на 100');
  assert.equal(svetoforPrice('70990'), 709.9, 'строка с цифрами тоже');
  assert.equal(svetoforPrice(0), null, 'ноль — не цена');
  assert.equal(svetoforPrice(-100), null, 'минус — не цена');
  assert.equal(svetoforPrice(null), null, 'нет значения');
  assert.equal(svetoforPrice('abc'), null, 'мусор');
  assert.equal(svetoforPrice(undefined), null, 'нет поля');
}

// ─── фасовка из названия ─────────────────────────────────────────────────
{
  assert.equal(svetoforUnit('Сухари с изюмом 500 гр'), '500 г', 'граммы из названия');
  assert.equal(svetoforUnit('Арахис 1 кг, ООО ПК'), '1 кг', 'килограммы из названия');
  assert.equal(svetoforUnit('Молоко Тяжин питьевое 1 л. БЗМЖ'), '1 л', 'литры из названия');
  assert.equal(svetoforUnit('Ананасы кусочки 580мл (565гр)'), '580 мл', 'миллилитры остаются миллилитрами, а не литрами');
  assert.equal(svetoforUnit('Сок 1500 мл'), '1.5 л', 'миллилитры от килолитра переходят в литры');
  assert.equal(svetoforUnit('Сахар 1000 г'), '1 кг', 'граммы от килограмма переходят в килограммы');
  assert.equal(svetoforUnit('Сосиски 0,95 кг'), '0.95 кг', 'запятая как разделитель дробной части');
  assert.equal(svetoforUnit('Гель для мытья 1,35л'), '1.35 л', 'дробные литры');
  assert.equal(svetoforUnit('Хлеб ржаной'), undefined, 'без фасовки в названии её нет');
  assert.equal(svetoforUnit(''), undefined, 'пустое название');
  assert.equal(svetoforUnit(undefined), undefined, 'нет названия');
  assert.equal(svetoforUnit('Сыр 50 БЗМЖ вес'), undefined, '«вес» — не фасовка');
  assert.equal(svetoforUnit('Пакет ПНД 390 200х640'), undefined, 'числа без единицы не фасовка');
  // Живые значения из фикстуры: сеть пишет и граммы с «гр», и крупные объёмы.
  assert.equal(svetoforUnit('Сосиски 3000 гр'), '3 кг', '«3000 гр» — это три килограмма, а не «3000 г»');
  assert.equal(svetoforUnit('Вода 5000 мл'), '5 л', 'пять литров в миллилитрах');
  assert.equal(
    svetoforUnit('Печенье сахарное Топтыжкина радость Топленое молоко, 1010 гр.'),
    '1.01 кг',
    '1010 г — это ровно 1.01 кг, округлять до «1 кг» нельзя: это другой вес',
  );
  // Живые строки: сеть пишет фасовку в названии, и у 448 из 553 она разбирается
  const withUnit = rows.filter((r) => normalizeSvetoforOffer(r, ctx)?.unit !== undefined);
  assert.ok(withUnit.length > 400, `фасовка разобралась у ${withUnit.length} строк из ${rows.length}`);
  // Взвешенный товар без фасовки в названии фасовки не получает
  const byWeight = rows.find((r) => r.ei === 'кг.' && !/кг|\d\s?л/.test(r.name ?? ''));
  if (byWeight) assert.equal(normalizeSvetoforOffer(byWeight, ctx)?.unit, undefined, '«вес» без числа — не фасовка');
  // Килограммы у штучного товара и литры дают одно и то же `w`, поэтому
  // фасовку читаем из названия, а не из поля веса.
  const litre = rows.find(
    (r) => r.ei === 'шт.' && r.w === 1000 && normalizeSvetoforOffer(r, ctx)?.unit === '1 л',
  );
  assert.ok(litre, 'в живом прайсе есть штучный товар на 1 л с тем же w=1000, что у килограммовых');
  const kilo = rows.find((r) => r.ei === 'шт.' && r.w === 1000 && /\b1\s?кг/.test(r.name ?? ''));
  if (kilo) assert.equal(normalizeSvetoforOffer(kilo, ctx)?.unit, '1 кг', 'штучный килограммовый товар даёт «1 кг»');
  // Фасовка словом («1 литр») в unit не идёт: её нечем сравнить с соседними
  // сетями, где фасовка записана цифрой с единицей.
  const litreWord = rows.find((r) => /1\s?литр/.test(r.name ?? ''));
  if (litreWord) assert.equal(normalizeSvetoforOffer(litreWord, ctx)?.unit, undefined, '«литр» словом — не фасовка');
}

// ─── свежесть прайса ─────────────────────────────────────────────────────
{
  const fresh = Date.parse('2026-10-08T00:00:00Z');
  const today = Math.floor(fresh / 1000);
  assert.equal(svetoforOfferDate({ d: today }), fresh, 'секунды читаются как unixtime');
  assert.equal(svetoforOfferDate({ d: today * 1000 }), fresh, 'миллисекунды не удваиваются');
  assert.equal(svetoforOfferDate({ d: '1791447989' }), 1791447989000, 'строка читается так же');
  assert.equal(svetoforOfferDate({}), null, 'нет даты');
  assert.equal(svetoforOfferDate({ d: 0 }), null, 'ноль — не дата');
  assert.equal(svetoforOfferDate({ d: -5 }), null, 'минус — не дата');

  // Живой прайс несёт 37 разных `d` с размахом в три недели: `d` — это отметка
  // позиции, а не дата файла. Резать по построчной метке нельзя, иначе живые
  // SKU навсегда исчезли бы из поиска и из карточки.
  const spread = new Set(rows.map((r) => r.d));
  assert.ok(spread.size > 5, `в фикстуре смешанные даты: ${spread.size} разных d`);
  const weekAgo = today - 9 * 86400;
  const withOld = rows.filter((r) => (r.d ?? 0) < weekAgo);
  assert.ok(withOld.length > 0, 'в фикстуре есть позиции старше недели — они обязаны выжить');
  assert.doesNotThrow(
    () => assertSvetoforNewestDate('649', rows),
    'живой прайс со старыми позициями не отбрасывается',
  );

  // Дат нет вовсе — это дрейф формата, а не «свежий прайс»: молча пропустить
  // значило бы вписать в историю цены неизвестного возраста с сегодняшним
  // `collectedAt`.
  // Дрейф формата поля `d` бросает обычный `Error`, а не `StaleStoreError`:
  // переименование поля бьёт по всем магазинам региона, значит breaker должен
  // поставить сети паузу — иначе опрос заново качал бы файл по разу на позицию.
  assert.throws(
    () => assertSvetoforNewestDate('x', [{ id: 1, name: 'Без даты', p: 100 }]),
    (err: unknown) => err instanceof Error && !isStaleStoreError(err) && /формат изменился/.test(err.message),
    'нет ни одной даты — сетевой отказ с паузой, а не отказ одной точки',
  );
  assert.throws(
    () => assertSvetoforNewestDate('x', []),
    (err: unknown) => err instanceof Error && !isStaleStoreError(err),
    'пустой файл без дат — тоже дрейф формата',
  );

  // Заброшенный магазин 376: весь файл от 2021 года. Отказ — StaleStoreError, а
  // не сетевой: сеть жива, живой магазин того же города работает, и выключать
  // сеть из-за одной мёртвой точки нельзя.

  const ancient = [{ id: 1, name: 'Арахис', p: 1000, d: Math.floor(Date.parse('2021-12-31T10:00:00Z') / 1000) }];
  clearSvetoforCache();
  setSvetoforStamp('kaluzhskaya-oblast', '1791443124');
  const staleCalls = harness((url) =>
    url.includes('/cache/') ? { status: 200, body: JSON.stringify(ancient) } : { status: 200, body: REGION_HTML },
  );
  const staleAdapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, staleCalls.fetchImpl);
  const staleErr = await staleAdapter.search('арахис', { city: 'kaluga', externalStoreId: '649' }).catch(
    (err: unknown) => err as Error,
  );
  assert.ok(
    isStaleStoreError(staleErr),
    `протухший прайс — отказ точки, а не сетевой отказ (получено: ${(staleErr as Error)?.name} ${String((staleErr as Error)?.message).slice(0, 70)})`,
  );
  assert.ok(/2021-12-31/.test(staleErr.message), 'в отказе видна дата свежайшей позиции');
  assert.equal(staleErr.storeKey, 'svetofor:649', 'в отказе указан магазин, а не только сеть');
  const staleErr2 = await staleAdapter
    .fetchProduct('svt-1', { city: 'kaluga', externalStoreId: '649', name: 'Арахис' })
    .catch((err: unknown) => err as Error);
  assert.ok(isStaleStoreError(staleErr2), 'карточка по протухшему прайсу — тоже отказ точки');
  assert.equal(
    staleCalls.calls.filter((c) => c.url.includes('/cache/')).length,
    1,
    'протухший файл скачан один раз: второй отказ взят из кэша (иначе 40 товаров × 250 КБ за обход)',
  );
  clearSvetoforCache();
}

// ─── битые строки ────────────────────────────────────────────────────────
{
  assert.equal(normalizeSvetoforOffer({ p: 100 }, ctx), null, 'без названия — пропуск');
  assert.equal(normalizeSvetoforOffer({ name: '   ', p: 100 }, ctx), null, 'пробельное название');
  assert.equal(normalizeSvetoforOffer({ name: 'Без цены' }, ctx), null, 'без цены');
  assert.equal(normalizeSvetoforOffer({ name: 'X', p: 0 }, ctx), null, 'нулевая цена');
  assert.equal(normalizeSvetoforOffer({ name: 'Без номера', p: 100 }, ctx), null, 'без id товар не опознать');
  assert.equal(normalizeSvetoforOffer({ name: 'Пробел', p: 100, id: '  ' }, ctx), null, 'пустой id — пропуск');
}

// ─── идентификаторы и адреса ─────────────────────────────────────────────
{
  assert.equal(svetoforCanonicalId(104255), 'svt-104255', 'идентификатор сквозной по SKU сети');
  assert.equal(svetoforImageUrl(104255), 'https://svetoforonline.ru/data/share/item_104255.jpg', 'картинка по id');
  assert.equal(
    svetoforPriceUrl('moskovskaya-oblast', '649', '1791367867'),
    'https://moskovskaya-oblast.svetoforonline.ru/cache/offers-649-1791367867.json',
    'адрес прайса собран из домена точки, магазина и метки',
  );
  assert.equal(svetoforShopUrl('kaluzhskaya-oblast'), 'https://kaluzhskaya-oblast.svetoforonline.ru/');
  assert.equal(svetoforProductUrl('kaluzhskaya-oblast', 'kuku/'), 'https://kaluzhskaya-oblast.svetoforonline.ru/kuku', 'концевой слеш убирается');
  // `chpu` приходит из прайса и уходит в путь URL: сегменты кодируются, а
  // «выход за пределы магазина» через `..` не проходит.
  // Сегмент, равный `..`, выбрасывается: `encodeURIComponent('..')` возвращает
  // `..` без изменений, то есть кодирование тут не защищает.
  assert.equal(
    svetoforProductUrl('kaluzhskaya-oblast', '../../admin'),
    'https://kaluzhskaya-oblast.svetoforonline.ru/admin',
    'переходы по каталогу вырезаны, адрес не уходит за пределы магазина',
  );
  assert.equal(
    svetoforProductUrl('kaluzhskaya-oblast', 'molochnaya/../admin'),
    'https://kaluzhskaya-oblast.svetoforonline.ru/molochnaya/admin',
    'внутренние переходы тоже вырезаны',
  );
  // А вот `..` ВНУТРИ сегмента (в живом прайсе такое есть) остаётся: это часть
  // названия, а не переход.
  assert.equal(
    svetoforProductUrl('kaluzhskaya-oblast', 'galoshi-art..m-001'),
    'https://kaluzhskaya-oblast.svetoforonline.ru/galoshi-art..m-001',
    'точки внутри сегмента не трогаются',
  );
  assert.equal(
    svetoforProductUrl('kaluzhskaya-oblast', 'молоко'),
    'https://kaluzhskaya-oblast.svetoforonline.ru/%D0%BC%D0%BE%D0%BB%D0%BE%D0%BA%D0%BE',
    'кириллица кодируется, а не ломает адрес',
  );
  assert.equal(
    svetoforProductUrl('kaluzhskaya-oblast', '/molochnaya/'),
    'https://kaluzhskaya-oblast.svetoforonline.ru/molochnaya',
    'крайние слеши убираются, внутренние сохраняются',
  );
  // Живой chpu из фикстуры адресуется как есть (в нём только латиница и дефисы)
  const liveChpu = fixture.find((r) => typeof r.chpu === 'string' && r.chpu !== '')?.chpu;
  if (liveChpu) {
    assert.equal(
      svetoforProductUrl('kaluzhskaya-oblast', liveChpu),
      `https://kaluzhskaya-oblast.svetoforonline.ru/${liveChpu}`,
      'живой chpu кодированием не искажается',
    );
  }
  // Адрес товара — ОДИН сегмент, ровно как у полки: в живой выгрузке 549 из 552
  // `chpu` начинаются с буквы. Отличить их по форме нельзя, поэтому предикат
  // сверяется с прайсом, когда тот уже в кэше; до загрузки прайса отвечает по
  // форме адреса, а `fetchCategoryProducts` отвергает карточку громко.
  const offline = () => {
    throw new Error('сеть не нужна');
  };
  const noPrice = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, offline as never);
  assert.equal(
    noPrice.canHandleCategoryUrl('https://kaluzhskaya-oblast.svetoforonline.ru/molochnaya-produktsiya/'),
    true,
    'без прайса в кэше раздел принимается по форме адреса',
  );
assert.equal(
      noPrice.canHandleCategoryUrl('https://kaluzhskaya-oblast.svetoforonline.ru/molochnaya-produktsiya/yogurt.htm'),
      false,
      'старая страница раздела не полка',
    );
    assert.equal(
      noPrice.canHandleCategoryUrl('https://kaluzhskaya-oblast.svetoforonline.ru/molochnaya-produktsiya.htm'),
      false,
      'раздел со старым расширением не полка',
    );
  assert.equal(
    noPrice.canHandleCategoryUrl('https://kaluzhskaya-oblast.svetoforonline.ru:8443/molochnaya-produktsiya/'),
    false,
    'адрес с портом не наша полка',
  );
}

// ─── домен по магазину ───────────────────────────────────────────────────
{
  assert.equal(svetoforDomain('820'), 'moskva-vostok', 'домен берётся у магазина, не у города');
  assert.equal(svetoforDomain('206'), 'leningradskaya-oblast', 'СПб-магазин на своём домене');
  assert.throws(() => svetoforDomain('999999'), /не найден в справочнике/, 'нет магазина — внятная ошибка');
  assert.throws(() => svetoforDomain('820', {}), /не найден в справочнике/, 'пустой справочник — внятная ошибка');

  // Порог протухания зафиксирован: он решение, а не деталь реализации, и смена
  // константы молча продлила бы опрос заброшенного магазина.
  assert.equal(SVETOFOR_STALE_MS, 14 * 24 * 60 * 60 * 1000, 'порог протухания прайса — две недели');
  assert.ok(Object.keys(STORE_DOMAIN).length > 500, 'в справочнике все магазины сети');
  // Заведённые в каталоге магазины обязаны быть в справочнике
  for (const [city, shopId] of [
    ['moscow', '820'],
    ['saint-petersburg', '206'],
  ] as const) {
    assert.ok(svetoforDomain(shopId), `магазин Светофора в ${city} есть в справочнике`);
  }
}

// ─── совпадение названий ─────────────────────────────────────────────────
{
  assert.equal(nameMatches('Гречка зелёная', 'Гречка зелёная 500 г'), true, 'сеть обрезала название');
  assert.equal(nameMatches('Гречка зелёная 500 г', 'Гречка зелёная'), true, 'длиннее в базе, чем в сети');
  assert.equal(nameMatches('  Гречка ЗЕЛЁНАЯ ', 'гречка зелёная'), true, 'регистр и пробелы не мешают');
  assert.equal(nameMatches('Гречка', 'Гречка зелёная'), false, 'короткое имя не угадываем');
  assert.equal(nameMatches(undefined, 'Гречка зелёная'), false, 'строки без названия не подходят');
  assert.equal(nameMatches('', 'Гречка зелёная'), false, 'пустое имя не подходит');
  assert.equal(nameMatches(null, '   '), false, 'пустое имя с пустым запросом');
  assert.equal(nameMatches('Гречка зелёная 500 г', 'Арахис обжаренный'), false, 'чужое название');
  assert.equal(nameMatches(null, null as unknown as string), false, 'оба пустые');

  // Числа названия обязаны совпадать, иначе чужой SKU уйдёт в историю.
  assert.equal(numbersAgree('Хлеб ржаной 400 г', 'Хлеб ржаной 400 г'), true, 'числа те же');
  assert.equal(numbersAgree('Хлеб ржаной 400 г зёрновой', 'Хлеб ржаной 400 г'), true, 'название длиннее, числа те же');
  assert.equal(numbersAgree('Хлеб ржаной 900 г', 'Хлеб ржаной 400 г'), false, 'разная фасовка — другой товар');
  assert.equal(numbersAgree('Гречка 500 г', 'Гречка 900 г'), false, 'расхождение в любую сторону — другой товар');
  assert.equal(numbersAgree('Гречка зелёная 1000 г', 'Гречка зелёная'), false, 'сеть вернула фасовку, в БД её нет — расхождение');
  assert.equal(numbersAgree('Сосиски 1 кг', 'Сосиски 1 кг'), true, 'одинаковые фасовки');
  assert.equal(numbersAgree('Сосиски 0,5 кг', 'Сосиски 0,5 кг'), true, 'дробная фасовка совпала');
  assert.equal(numbersAgree('Коктейль 4,0 260 г', 'Коктейль 4,0 260 г'), true, 'запятая не мешает');
  assert.equal(numbersAgree(undefined, 'Хлеб ржаной 400 г'), false, 'без названия чисел нет, сверять нечего');
  assert.equal(numbersAgree('Хлеб ржаной 400 г', undefined as unknown as string), false, 'нет названия из БД — тоже нечего сверять');
  assert.equal(numbersAgree('Хлеб ржаной', 'Хлеб'), true, 'нет чисел — нечего сверять');
}

// ─── полки: раздел из catchpu, разбор меню, товары полки ──────────────────
{
  // Раздел берётся из ПРАЙСА: полка `bakaleya-i-drugie-produktsiya` покрывает все
  // строки, чей `catchpu` на ней начинается.
  assert.equal(svetoforShelf('bakaleya-i-drugie-produktsiya/bakaleya/pripravi-i-spetsii/'), 'bakaleya-i-drugie-produktsiya', 'раздел — первый сегмент catchpu');
  assert.equal(svetoforShelf('  myasnaya-i-ribnaya-produktsiya/riba/ '), 'myasnaya-i-ribnaya-produktsiya', 'пробелы обрезаны');
  assert.equal(svetoforShelf(''), '', 'пустой catchpu — не раздел');
  assert.equal(svetoforShelf(undefined), '', 'нет catchpu — не раздел');
  assert.equal(svetoforShelf('   '), '', 'из одних пробелов раздела нет');
  assert.ok(inSvetoforShelf({ catchpu: 'molochnaya-produktsiya/yogurti/x.htm' }, 'molochnaya-produktsiya'), 'товар в разделе');
  assert.equal(inSvetoforShelf({ catchpu: 'molochnaya-produktsiya/yogurti/x.htm' }, 'bitovaya-himiya'), false, 'чужой раздел не подходит');
  assert.equal(inSvetoforShelf({ catchpu: '' }, ''), false, 'пустой раздел не подходит даже сам себе');

  // Меню главной: разделы с русскими названиями, служебные ссылки — мимо.
  const menu = parseSvetoforMenu(`
    <html><body>
      <a href="/novye-postypleniya/">Новые поступления</a>
      <a href="/konditerskie-izdeliya/">Кондитерские изделия</a>
      <a href='/molochnaya-produktsiya/'>Молочная продукция</a>
      <a href="molochnaya-produktsiya/">Дубль раздела без слэша</a>
      <a href="/shops">Все магазины</a>
      <a href="/content/kontakti/">Контакты</a>
      <a href="/bitovaya-himiya/">Бытовая химия</a>
      <a href="/">Главная</a>
      <a href="/molochnaya-produktsiya/tovar.htm">Товар на странице раздела</a>
      <a href="/chay,-kofe,-bezalkogolnie-napitki/">Чай, кофе, безалкогольные напитки</a>
      <a href="/pusto/"></a>
      <a href="///">Пустой путь</a>
      <a href="/dlinnoe/">
        ${'Очень длинное название раздела, которое явно не раздел, а какой-то баннер или новость, и мы его отбросим'.repeat(2)}
      </a>
    </body></html>
  `);
  const names = menu.map((m) => m.name);
  assert.ok(names.includes('Кондитерские изделия'), 'раздел с названием из меню');
  assert.ok(names.includes('Молочная продукция'), 'одинарные кавычки в href разобраны');
  assert.ok(names.includes('Чай, кофе, безалкогольные напитки'), 'название с запятыми и пробелами');
  assert.equal(names.includes('Новые поступления'), false, '«новые поступления» — служебный раздел без товаров в прайсе');
  assert.equal(names.includes('Все магазины'), false, 'служебные ссылки отброшены');
  assert.equal(names.includes('Контакты'), false, 'контакты — не полка');
  assert.equal(names.includes('Главная'), false, 'главная — не полка');
  assert.equal(names.includes(''), false, 'пустое имя — не полка');
  assert.equal(menu.filter((m) => m.shelf === 'molochnaya-produktsiya').length, 1, 'дубль раздела без ведущего слэша не задвоен');
  assert.equal(menu.filter((m) => m.shelf.includes('.')).length, 0, 'ссылки на товары (.htm) в меню не попали');
  assert.equal(names.filter((n) => n.length > 90).length, 0, 'слишком длинные подписи отброшены');
  assert.deepEqual(parseSvetoforMenu('<html></html>'), [], 'пустая разметка — пустое меню');
  // Абсолютная ссылка: разбор строки дал бы фиктивный раздел `https:`.
  const absolute = parseSvetoforMenu(
    '<a href="https://kaluzhskaya-oblast.svetoforonline.ru/bitovaya-himiya/">Бытовая химия</a>',
  );
  assert.deepEqual(absolute.map((m) => m.shelf), ['bitovaya-himiya'], 'абсолютная ссылка разобрана в раздел');
  // Вложенная ссылка — не полка верхнего уровня: товары полки берутся по разделу,
  // а подраздел товарами не наполнен.
  assert.deepEqual(
    parseSvetoforMenu('<a href="/molochnaya-produktsiya/morozhenoe/">Мороженое</a>'),
    [],
    'подраздел в полку верхнего уровня не попал',
  );
  assert.deepEqual(
    parseSvetoforMenu('<a href="не-ссылка">Текст</a>'),
    [],
    'ссылка не латиницей — не раздел',
  );
  // Абсолютный URL, который не парсится, — не повод ронять разбор всего меню.
  assert.deepEqual(
    parseSvetoforMenu('<a href="http://[плохой/раздел">Текст</a><a href="/molochnaya-produktsiya/">Молоко</a>'),
    [{ shelf: 'molochnaya-produktsiya', name: 'Молоко', menuId: '' }],
    'битый абсолютный адрес пропущен, остальное меню разобрано',
  );
  // Живой слаг с точкой и запятыми из фикстуры: запретив точку, мы бы молча
  // выкинули из витрины целый раздел, а громкий отказ есть только на НУЛЕ
  // разделов — витрина просто сжалась бы.
  assert.deepEqual(
    parseSvetoforMenu('<a href="/posuda,-hoz.tovari,-mebel/">Посуда, хозтовары, мебель</a>').map((m) => m.shelf),
    ['posuda,-hoz.tovari,-mebel'],
    'живой слаг с точкой и запятыми не отброшен',
  );
  // `?` и `#` у относительной ссылки: иначе раздел молча выпадал бы из витрины.
  assert.deepEqual(
    parseSvetoforMenu('<a href="/molochnaya-produktsiya/?utm_source=banner#top">Молоко</a>').map((m) => m.shelf),
    ['molochnaya-produktsiya'],
    'query и fragment у относительной ссылки срезаны',
  );
  // Служебная ссылка без завершающего слеша: раньше её спасал только факт, что
  // такого раздела нет в прайсе, — связь неявная и хрупкая.
  assert.deepEqual(
    parseSvetoforMenu('<a href="/novye-postypleniya">Новые поступления</a>'),
    [],
    'служебный раздел без слеша отброшен',
  );
  // Меню соседнего региона: название оттуда, а товары из нашего прайса — подпись
  // врала бы. Отсекается, когда регион известен.
  assert.deepEqual(
    parseSvetoforMenu('<a href="https://saint-petersburg.svetoforonline.ru/molochnaya-produktsiya/">Молоко</a>', 'kaluzhskaya-oblast'),
    [],
    'абсолютная ссылка чужого региона отброшена',
  );
  assert.deepEqual(
    parseSvetoforMenu('/<a href="/molochnaya-produktsiya/?utm_source=banner&amp;nbsp;">Молоко&nbsp;и&nbsp;сок</a>').map((m) => m.name),
    ['Молоко и сок'],
    'html-сущности в подписи разобраны',
  );

  // --- Иконка раздела: номер из `id` пункта меню -----------------------------
  // Номер стоит на `<li>`, а не на самой ссылке. Искать его «рядом» со ссылкой
  // нельзя: следующий пункт — уже чужой раздел, и плитка получила бы иконку
  // соседа (выглядит правдоподобно, поэтому мимо не пройти).
  assert.deepEqual(
    parseSvetoforMenu(
      '<ul><li id="menu-5947"><a href="/konditerskie-izdeliya/">Кондитерские изделия</a></li>' +
        '<li id="menu-5895"><a href="/molochnaya-produktsiya/">Молочная продукция</a></li></ul>',
    ).map((m) => ({ shelf: m.shelf, menuId: m.menuId })),
    [
      { shelf: 'konditerskie-izdeliya', menuId: '5947' },
      { shelf: 'molochnaya-produktsiya', menuId: '5895' },
    ],
    'номер пункта достаётся СВОЕМУ разделу, а не соседнему',
  );
  // Пункт без номера (правка вёрстки) — не поломка: раздел остаётся, просто без
  // иконки. Пустой адрес плитке отдавать нельзя: браузер сам спросит корень CDN.
  assert.deepEqual(
    parseSvetoforMenu('<li><a href="/bitovaya-himiya/">Бытовая химия</a></li>').map((m) => m.menuId),
    [''],
    'пункт без id даёт пустой номер, а не иконку соседнего раздела',
  );
  assert.deepEqual(
    parseSvetoforMenu('<li id="menu-new"><a href="/novye-postypleniya/">Новые</a></li><li><a href="/chay/">Чай</a></li>').map(
      (m) => m.menuId,
    ),
    [''],
    'нечисловой id (menu-new) номером не считается',
  );
  // Адрес иконки: CDN отдаёт её по номеру пункта (проверено живьём 2026-10-11:
  // menu-5895.svg и menu-5947.svg → 200, несуществующие номера → 404).
  assert.equal(
    svetoforCategoryImageUrl('menu-5895'),
    'https://cdn.binuke.info/projects/svetofor/svg/menu-5895.svg',
    'адрес иконки собирается по номеру пункта',
  );

  // Адрес полки собирается по домену РЕГИОНА: поддомен другой точки уехал бы на
  // сайт другого региона.
  assert.equal(
    svetoforShelfUrl('kaluzhskaya-oblast', 'molochnaya-produktsiya'),
    'https://kaluzhskaya-oblast.svetoforonline.ru/molochnaya-produktsiya/',
    'адрес полки на поддомене региона',
  );
  assert.equal(svetoforShelfUrl('region', '../../admin'), 'https://region.svetoforonline.ru/admin/', 'сегменты «..» выброшены');
  assert.equal(
    svetoforShelfUrl('region', 'chay,-kofe,-bezalkogolnie-napitki'),
    'https://region.svetoforonline.ru/chay%2C-kofe%2C-bezalkogolnie-napitki/',
    'запятые в разделе закодированы',
  );
}

// Адрес полки обратно в раздел — и по точному домену магазина, и по правилу сети.
{
  const url = 'https://kaluzhskaya-oblast.svetoforonline.ru/molochnaya-produktsiya/';
  assert.equal(svetoforShelfFromUrl(url, 'kaluzhskaya-oblast'), 'molochnaya-produktsiya', 'раздел восстановлен из адреса');
  assert.equal(
    svetoforShelfFromUrl(
      'https://kaluzhskaya-oblast.svetoforonline.ru/chay%2C-kofe%2C-bezalkogolnie-napitki/',
      'kaluzhskaya-oblast',
    ),
    'chay,-kofe,-bezalkogolnie-napitki',
    'закодированные запятые разбираются',
  );
  assert.equal(svetoforShelfFromUrl('https://moskva-vostok.svetoforonline.ru/molochnaya-produktsiya/', 'kaluzhskaya-oblast'), null, 'полка чужого региона — не наша');
  assert.equal(svetoforShelfFromUrl('https://5ka.ru/catalog/123/', 'kaluzhskaya-oblast'), null, 'адрес чужой сети — не наша полка');
  assert.equal(svetoforShelfFromUrl('http://kaluzhskaya-oblast.svetoforonline.ru/molochnaya-produktsiya/', 'kaluzhskaya-oblast'), null, 'http не принимаем');
  assert.equal(svetoforShelfFromUrl('не адрес', 'kaluzhskaya-oblast'), null, 'мусор не адрес');
  assert.equal(svetoforShelfFromUrl('https://kaluzhskaya-oblast.svetoforonline.ru/', 'kaluzhskaya-oblast'), null, 'корень сайта — не полка (иначе прошёл бы проверку полки)');

  assert.equal(
    svetoforShelfFromAnyDomain('https://moskva-vostok.svetoforonline.ru/molochnaya-produktsiya/'),
    'molochnaya-produktsiya',
    'любой регион сети — наша полка',
  );
  assert.equal(svetoforShelfFromAnyDomain('https://5ka.ru/catalog/1/'), null, 'чужая сеть не проходит по правилу сети');
  assert.equal(svetoforShelfFromAnyDomain('https://evil-svetoforonline.ru/molochnaya-produktsiya/'), null, 'домен с хвостом названия не прошёл');
  assert.equal(svetoforShelfFromAnyDomain('https://svetoforonline.ru/molochnaya-produktsiya/'), null, 'голый домен без региона — не полка');
  assert.equal(svetoforShelfFromAnyDomain('https://moskva-vostok.svetoforonline.ru/'), null, 'корень сайта — не полка');
  assert.equal(svetoforShelfFromAnyDomain('не адрес'), null, 'мусор не адрес');
  assert.equal(svetoforShelfFromAnyDomain('http://moskva-vostok.svetoforonline.ru/molochnaya-produktsiya/'), null, 'http не принимаем');
  // Битый процент в пути бросает URIError, а canHandleCategoryUrl зовут из services
  // ВНЕ try — reject ушёл бы в IPC вместо «не наша полка».
  assert.equal(svetoforShelfFromAnyDomain('https://moskva-vostok.svetoforonline.ru/%zz/'), null, 'битый процент — не полка');
  assert.equal(
    svetoforShelfFromUrl('https://kaluzhskaya-oblast.svetoforonline.ru/%zz/', 'kaluzhskaya-oblast'),
    null,
    'битый процент — не полка этого магазина',
  );
}

// ─── HTTP-слой на подставном fetch ───────────────────────────────────────
type Call = { url: string; signal: AbortSignal | null; headers: Record<string, string> };
function harness(
      handler: (url: string) => {
        status: number;
        body: string;
        contentType?: string;
        bytes?: number[];
        bytesFail?: boolean;
      },
    ): { fetchImpl: never; calls: Call[] } {
      const calls: Call[] = [];
      const fetchImpl = (async (
        url: string,
        init?: { signal?: AbortSignal; headers?: Record<string, string> },
      ) => {
        calls.push({ url, signal: init?.signal ?? null, headers: init?.headers ?? {} });
        const r = handler(url);
        const text = async () => r.body;
        // Байты нужны кейсу с windows-1251: `text()` там дал бы UTF-8.
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          text,
          headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? r.contentType ?? null : null) },
          arrayBuffer:
            r.bytes === undefined
              ? undefined
              : r.bytesFail === true
                ? async () => {
                    throw new Error('тело недоступно');
                  }
                : async () => new Uint8Array(r.bytes ?? []).buffer,
        };
      }) as never;
      return { fetchImpl, calls };
    }

// Меню главной в тестовом виде: те же разделы, что в живой разметке, плюс
// служебные ссылки, которые обязаны отсеяться.
// Меню и метка прайса лежат на ОДНОЙ странице региона, поэтому в тесте это одна и
// та же разметка: и `offersupd`, и ссылки разделов.
const MENU_HTML = `<html><script>var shopid=712; var offersupd=1791443124;</script><body>
  <a href="/novye-postypleniya/">Новые поступления</a>
  <a href="/shops">Все магазины</a>
  <a href="/molochnaya-produktsiya/">Молочная продукция</a>
  <a href="/bitovaya-himiya/">Бытовая химия</a>
  <a href="/molochnaya-produktsiya/yogurti/x.htm">Товар</a>
</body></html>`;
const shopCtx = { city: 'kaluga', externalStoreId: '649' };
const priceHarness = () =>
  harness((url) => {
    // Страница региона и меню приходят на один и тот же адрес `/`, различается
    // только заголовок ответа, который fetchImpl не отдаёт: для тестов важно
    // лишь, что адрес ОДИН, а разметка подходит обеим задачам.
    if (url.includes('/cache/')) return { status: 200, body: JSON.stringify(fixture) };
    return { status: 200, body: MENU_HTML };
  });

// Живая страница региона приходит в windows-1251, а `text()` читает UTF-8:
// кириллица в названиях разделов становилась U+FFFD и в UI выглядела ромбиками.
// Фикстура — НАСТОЯЩИЕ байты живой страницы (`charset=windows-1251`, снято
// 2026-10-10), а не строка: строковый литерал проверил бы UTF-8 и баг бы скрыл.
{
  clearSvetoforCache();
  const raw = Array.from(new Uint8Array(readFileSync(CP1251_FIXTURE)));
  const { fetchImpl } = harness((url) =>
    url.includes('/cache/')
      ? { status: 200, body: JSON.stringify(fixture) }
      : { status: 200, body: '', contentType: 'text/html; charset=windows-1251', bytes: raw },
  );
  const shelves = await new SvetoforAdapter({ domain: () => 'moskva-vostok' }, fetchImpl).fetchCategories({
    city: 'moscow',
    externalStoreId: '820',
  });
  const names = shelves.map((s) => s.name);
  assert.ok(
    names.includes('Молочная продукция'),
    `кириллица из windows-1251 разобралась: ${names.slice(0, 4).join(', ')}`,
  );
  assert.equal(
    names.some((n) => n.includes('\uFFFD')),
    false,
    'в названиях разделов нет символов замены',
  );
  assert.ok(shelves.length >= 5, `живое меню разобралось целиком: ${shelves.length} разделов`);
  // Заголовок без метки и без `arrayBuffer` — откат на `text()`: тестовый harness
  // и любой ответ без тела-буфера не должны ломаться.
  clearSvetoforCache();
  const plain = harness((url) =>
    url.includes('/cache/') ? { status: 200, body: JSON.stringify(fixture) } : { status: 200, body: MENU_HTML },
  );
  const plainShelves = await new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblist' }, plain.fetchImpl).fetchCategories({
    city: 'kaluga',
    externalStoreId: '649',
  });
  assert.ok(plainShelves.length > 0, 'без заголовка и буфера разбор не сломался');
  // Тело недоступно (чтение оборвалось) — громкий отказ, а не тихий откат на
  // `text()`: у настоящего Response тело в этот момент уже disturbed, и повторное
  // чтение упало бы с «Body is unusable», потеряв исходную причину.
  clearSvetoforCache();
  const brokenBody = harness((url) =>
    url.includes('/cache/')
      ? { status: 200, body: JSON.stringify(fixture) }
      : { status: 200, body: MENU_HTML, contentType: 'text/html; charset=windows-1251', bytes: [1], bytesFail: true },
  );
  await assert.rejects(
    () =>
      new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblist' }, brokenBody.fetchImpl).fetchCategories({
        city: 'kaluga',
        externalStoreId: '649',
      }),
    /тело недоступно/,
    'непрочитанное тело — исходная ошибка, а не подмена на text()',
  );
  // Без заголовка кодировки остаётся честный `text()` (UTF-8): угадывать
  // windows-1251 наугад значило бы превратить нормальный ответ в «мохибаке».
  clearSvetoforCache();
  const noCharset = harness((url) =>
    url.includes('/cache/') ? { status: 200, body: JSON.stringify(fixture) } : { status: 200, body: MENU_HTML },
  );
  const noCharsetShelves = await new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblist' }, noCharset.fetchImpl).fetchCategories({
    city: 'kaluga',
    externalStoreId: '649',
  });
  assert.ok(
    noCharsetShelves.some((s) => s.name === 'Молочная продукция'),
    `без charset разбор остаётся UTF-8: ${noCharsetShelves.map((s) => s.name).slice(0, 3).join(', ')}`,
  );
  // Метки из известного списка идёт в дело как есть (koi8), а незнакомая — в
  // живую кодировку сайта: «угадать utf-8» значило бы заменить всю кириллицу.
  clearSvetoforCache();
  const utf8Bytes = Array.from(Buffer.from(MENU_HTML, 'utf8'));
  const exotic = async (contentType: string): Promise<number> => {
    clearSvetoforCache();
    const impl = harness((url) =>
      url.includes('/cache/')
        ? { status: 200, body: JSON.stringify(fixture) }
        : { status: 200, body: MENU_HTML, contentType, bytes: utf8Bytes },
    );
    const shelves = await new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblist' }, impl.fetchImpl).fetchCategories({
      city: 'kaluga',
      externalStoreId: '649',
    });
    return shelves.length;
  };
  assert.ok((await exotic('text/html; charset=koi8-r')) > 0, 'koi8-r декодируется по своей метке');
  assert.ok((await exotic('text/html; charset=iso-8859-1')) > 0, 'незнакомая метка не ломает разбор');
  // `charset=utf-8` приходит с буфером: `text()` честен, лишнего декодирования нет.
  clearSvetoforCache();
  const utf8 = Array.from(Buffer.from(MENU_HTML, 'utf8'));
  const utf8Impl = harness((url) =>
    url.includes('/cache/')
      ? { status: 200, body: JSON.stringify(fixture) }
      : { status: 200, body: MENU_HTML, contentType: 'text/html; charset=utf-8', bytes: utf8 },
  );
  const utf8Shelves = await new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblist' }, utf8Impl.fetchImpl).fetchCategories({
    city: 'kaluga',
    externalStoreId: '649',
  });
  assert.ok(
    utf8Shelves.some((s) => s.name === 'Молочная продукция'),
    `при charset=utf-8 разбор не испорчен: ${utf8Shelves.map((s) => s.name).slice(0, 3).join(', ')}`,
  );
}

// ─── полки через адаптер ──────────────────────────────────────────────────
// После загрузки прайса предикат сверяется с ним: адрес карточки по форме такой
// же, как адрес полки, и без сверки клик по ссылке на товар считался бы полкой.
{
  clearSvetoforCache();
  setSvetoforStamp('kaluzhskaya-oblast', '1791443124');
  const { fetchImpl } = priceHarness();
  const adapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, fetchImpl);
  await adapter.fetchCategories({ city: 'kaluga', externalStoreId: '649' });
  let cards = 0;
  for (const offer of fixture) {
    const chpu = String(offer.chpu ?? '');
    if (chpu === '') continue;
    if (adapter.canHandleCategoryUrl(svetoforProductUrl('kaluzhskaya-oblast', chpu))) cards += 1;
  }
  assert.equal(cards, 0, 'после загрузки прайса ни одна карточка не считается полкой');
assert.equal(
    adapter.canHandleCategoryUrl('https://kaluzhskaya-oblast.svetoforonline.ru/molochnaya-produktsiya/'),
    true,
    'настоящий раздел по-прежнему полка',
  );
  // Сверка идёт по своему региону: у сети два города, и полка СПб, которой нет в
    // московском прайсе, не должна отвергаться там, где прайс просто не качали
  // (каталог отдан из кэша БД, прайс не открывали).
    assert.equal(
      adapter.canHandleCategoryUrl('https://moskva-vostok.svetoforonline.ru/razdel-toliko-spb/'),
      true,
      'полка чужого региона не отвергается по неполному кэшу',
    );
  }
{
  clearSvetoforCache();
  const { fetchImpl, calls } = priceHarness();
  const adapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblist' }, fetchImpl);
  const ctxK = { city: 'kaluga', externalStoreId: '649' };

  const shelves = await adapter.fetchCategories(ctxK);
  assert.ok(shelves.length >= 2, `разделы из меню: ${shelves.length}`);
  // Главный заявленный инвариант: открытие витрины — ровно ОДИН HTTP страницы
  // региона (в нём и метка прайса, и меню) плюс ОДИН HTTP прайса. Второй запрос
  // страницы означал бы, что кэш разметки не работает.
  assert.equal(
    calls.filter((c) => !c.url.includes('/cache/')).length,
    1,
    'витрина стоила одного запроса страницы региона, а не двух',
  );
  assert.deepEqual(
    shelves.map((s) => s.name).sort(),
    ['Бытовая химия', 'Молочная продукция'],
    'служебные разделы и ссылки на товары в полки не попали',
  );
  const milk = shelves.find((s) => s.name === 'Молочная продукция');
  assert.ok(milk, 'полка молочки найдена по названию');
  assert.equal(milk.url, 'https://kaluzhskaya-oblist.svetoforonline.ru/molochnaya-produktsiya/', 'адрес полки на домене региона');
  assert.equal(milk.id, 'molochnaya-produktsiya', 'id полки — раздел из прайса');
  assert.ok(adapter.canHandleCategoryUrl(milk.url), 'своя полка распознаётся');
  assert.equal(adapter.canHandleCategoryUrl('https://5ka.ru/catalog/1/'), false, 'полка чужой сети не наша');

  // Товары полки — из того же прайса, без запроса в сеть: тот же кэш.
  const callsBefore = calls.length;
  const goods = await adapter.fetchCategoryProducts(milk.url, ctxK);
  assert.ok(goods.length > 0, 'полка отдала товары');
  assert.equal(calls.length, callsBefore, 'товары полки взяты из кэша прайса, без новых запросов');
  const shelfOfProduct = new Map<string, string>(
  fixture
    .map((r) => [r.id === undefined ? '' : svetoforCanonicalId(r.id), svetoforShelf(r.catchpu)] as [string, string])
    .filter(([id]) => id !== ''),
);
  assert.ok(
    goods.every((g) => shelfOfProduct.get(g.canonicalId) === 'molochnaya-produktsiya'),
    'в полке только товары своего раздела',
  );
  assert.ok(goods.every((g) => g.price > 0 && g.storeId === 'svetofor' && g.city === 'kaluga'), 'товары полки — нормализованные цены нашего магазина');

  // Покрытие: разделы из прайса без меню в полки не попадают, но их товары не теряются.
  const fromPrice = new Set(fixture.map((r) => svetoforShelf(r.catchpu)));
  const inShelves = new Set(shelves.map((s) => s.id));
  assert.ok(fromPrice.size > inShelves.size, 'в прайсе разделов больше, чем в меню');
  assert.ok(
    [...inShelves].every((id) => fromPrice.has(id as string)),
    'каждая полка из меню есть в прайсе',
  );

  // Чужая/битая полка.
  await assert.rejects(
    () => adapter.fetchCategoryProducts('https://5ka.ru/catalog/1/', ctxK),
    /это не раздел/,
    'адрес чужой сети не опрашивается',
  );
await assert.rejects(
      () => adapter.fetchCategoryProducts(`https://kaluzhskaya-oblist.svetoforonline.ru/nesushchestvuyushchiy-razdel/`, ctxK),
      /в прайсе пуста/,
      'несуществующий раздел — громкий отказ, а не пустая полка',
    );

  // Полка крупнее заявленной границы: молча отдав первые 300, мы бы выглядели
  // как «в разделе 300 товаров», поэтому граница объявлена и товары дальше не
  // идут. Берём раздел, который в живой фикстуре больше всего набит товарами.
  {
    const counts = new Map<string, number>();
    for (const offer of fixture) {
      const shelf = String(offer.catchpu ?? '').split('/')[0] ?? '';
      if (shelf !== '') counts.set(shelf, (counts.get(shelf) ?? 0) + 1);
    }
    const biggest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    assert.ok(biggest !== undefined, 'в фикстуре есть хотя бы один раздел');
    // Умножаем выгрузку, чтобы раздел гарантированно перевалил за границу.
    const fat = Array.from({ length: 400 }, (_, i) => ({
      ...fixture[i % fixture.length],
      id: i,
      catchpu: `${biggest[0]}/tolko/${i}`,
    }));
    clearSvetoforCache();
    const { fetchImpl } = harness((url) =>
      url.includes('/cache/')
        ? { status: 200, body: JSON.stringify(fat) }
        : { status: 200, body: url.endsWith('/') ? MENU_HTML : REGION_HTML },
    );
    const fatAdapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblist' }, fetchImpl);
    const products = await fatAdapter.fetchCategoryProducts(
      `https://kaluzhskaya-oblist.svetoforonline.ru/${biggest[0]}/`,
      ctxK,
    );
    assert.equal(products.length, 300, `полка обрезана на границе, а не отдана целиком: ${products.length}`);
  }

  // Меню не отдалось: полки молча пропадать не должны.
  clearSvetoforCache();
  const broken = harness((url) => {
    if (url.includes('/cache/')) return { status: 200, body: JSON.stringify(fixture) };
    if (url.endsWith('/')) return { status: 500, body: 'ошибка' };
    return { status: 200, body: REGION_HTML };
  });
  const brokenAdapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblist' }, broken.fetchImpl);
  await assert.rejects(
    () => brokenAdapter.fetchCategories(ctxK),
    /страница региона .* HTTP 500/,
    'отказ меню виден наружу, а не молчаливый пустой список',
  );

  // Разделов больше лимита: показываем первые SHELF_LIMIT, а не упираемся в цикл.
{
  clearSvetoforCache();
  // Прайс собираем в тесте: 45 разделов в живой фикстуре нет, а лимит обязан
  // срабатывать на настоящем коде, а не на заглушке.
  const manyShelves = fixture.slice(0, 120).map((r, i) => ({
    ...r,
    catchpu: `razdel-${String(i).padStart(3, '0')}/podrazdel/${r.chpu ?? 'tovar'}.htm`,
  }));
  const manyMenu = [
    '<html><script>var shopid=712; var offersupd=1791443124;</script><body>',
    ...Array.from({ length: 45 }, (_, i) => `<a href="/razdel-${String(i).padStart(3, '0')}/">Раздел ${i}</a>`),
    '</body></html>',
  ].join('');
  const many = harness((url) =>
    url.includes('/cache/') ? { status: 200, body: JSON.stringify(manyShelves) } : { status: 200, body: manyMenu },
  );
  const shelves = await new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblist' }, many.fetchImpl).fetchCategories({
    city: 'kaluga',
    externalStoreId: '649',
  });
  assert.equal(shelves.length, 40, 'лимит полок соблюдён');
  assert.equal(shelves[39]?.name, 'Раздел 39', 'оборвано на лимите, а не позже');
  // Раздел в меню, но без товаров в прайсе, в полки не попадает.
  clearSvetoforCache();
  const ghost = harness((url) =>
    url.includes('/cache/')
      ? { status: 200, body: JSON.stringify(fixture) }
      : {
          status: 200,
          body: '<html><script>var shopid=712; var offersupd=1791443124;</script><body><a href="/molochnaya-produktsiya/">Молоко</a><a href="/tolko-na-saite/">Только на сайте</a></body></html>',
        },
  );
  const ghostShelves = await new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblist' }, ghost.fetchImpl).fetchCategories({
    city: 'kaluga',
    externalStoreId: '649',
  });
  assert.deepEqual(ghostShelves.map((s) => s.id), ['molochnaya-produktsiya'], 'раздел без товаров в прайсе не показан');
  clearSvetoforCache();
}

// Метка задана вручную (зонд так делает), а разметки в кэше нет: витрина обязана
// перечитать страницу, а не упасть на `undefined.matchAll`.
{
  clearSvetoforCache();
  setSvetoforStamp('kaluzhskaya-oblist', '1791443124');
  const { fetchImpl } = priceHarness();
  const shelves = await new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblist' }, fetchImpl).fetchCategories({
    city: 'kaluga',
    externalStoreId: '649',
  });
  assert.ok(shelves.length >= 2, `метка вручную, разделы из разметки: ${shelves.length}`);
  clearSvetoforCache();
}

// Страница региона без метки прайса — отказ с понятным текстом.
  clearSvetoforCache();
  const noStamp = harness((url) =>
    url.includes('/cache/') ? { status: 200, body: JSON.stringify(fixture) } : { status: 200, body: '<html><body></body></html>' },
  );
  await assert.rejects(
    () => new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblist' }, noStamp.fetchImpl).fetchCategories(ctxK),
    /нет метки прайса offersupd/,
    'страница без метки прайса — отказ, а не пустой каталог',
  );

  // Метка есть, но разделов в меню нет — дрейф вёрстки при живом прайсе.
  clearSvetoforCache();
  const emptyMenu = harness((url) =>
    url.includes('/cache/')
      ? { status: 200, body: JSON.stringify(fixture) }
      : { status: 200, body: '<html><script>var shopid=712; var offersupd=1791443124;</script><body><a href="/shops">Все магазины</a></body></html>' },
  );
  await assert.rejects(
    () => new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblist' }, emptyMenu.fetchImpl).fetchCategories(ctxK),
    /ни один раздел меню не найден/,
    'пустое меню при непустом прайсе — дрейф вёрстки',
  );
  clearSvetoforCache();
}

{
  clearSvetoforCache();
  const { fetchImpl, calls } = priceHarness();
  const adapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, fetchImpl);

  const found = await adapter.search('кукуруза', shopCtx);
  assert.ok(found.length > 0, 'поиск по прайсу находит товар');
  assert.equal(calls.length, 2, 'сначала страница региона, потом прайс');
  assert.ok((calls[1]?.url ?? '').includes('/cache/offers-649-1791443124.json'), 'адрес прайса собран верно');
  assert.ok(calls[0]?.signal != null && calls[1]?.signal != null, 'оба запроса с таймаутом');
  assert.ok(SVETOFOR_TIMEOUT_MS >= 5000, 'таймаут не вырожденный');
  assert.ok(
    /Firefox/.test(calls[1]?.headers['User-Agent'] ?? ''),
    'браузерная заголовка есть, CDN иначе отдаёт пустое тело',
  );
  assert.ok((calls[1]?.headers.Referer ?? '').includes('svetoforonline.ru'), 'есть Referer');

  const empty = await adapter.search('такого точно нет', shopCtx);
  assert.equal(empty.length, 0, 'пустое слово не выдумывает товары');
  assert.equal(calls.length, 2, 'второй поиск не пошёл в сеть — всё из кэша');

  const target = fixture.find((r) => r.id !== undefined);
  if (target) {
    const product = await adapter.fetchProduct(svetoforCanonicalId(target.id!), {
      city: 'kaluga',
      externalStoreId: '649',
    });
    assert.equal(product.canonicalId, svetoforCanonicalId(target.id!), 'карточка найдена по сквозному id');
  }

  await assert.rejects(
    () =>
      adapter.fetchProduct('svt-999999999', {
        city: 'kaluga',
        externalStoreId: '649',
        name: 'Нет такого товара в сети',
      }),
    (err: unknown) => isProductLookupError(err),
    'переименованный товар — ProductLookupError, сеть на паузу не уходит',
  );
}

{
  // Метки в памяти нет — адаптер читает `var offersupd` со страницы региона
  clearSvetoforCache();
  const { fetchImpl, calls } = priceHarness();
  const adapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, fetchImpl);
  const found = await adapter.search('кукуруза', shopCtx);
  assert.ok(found.length > 0, 'без ручной метки поиск всё равно работает');
  assert.equal(svetoforStamp('kaluzhskaya-oblast'), '1791443124', 'метка прочитана и запомнена');
  assert.ok((calls[0]?.url ?? '').includes('kaluzhskaya-oblast.svetoforonline.ru/'), 'запрос на страницу региона');
  await adapter.search('молоко', shopCtx);
  assert.equal(calls.filter((c) => !c.url.includes('/cache/')).length, 1, 'метка прочитана один раз');

  // Метка протухает через час
  let clock = 10_000;
  clearSvetoforCache();
  const clocked = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, fetchImpl, () => clock);
  await clocked.search('кукуруза', shopCtx);
  clock += SVETOFOR_STAMP_TTL_MS + 1;
  await clocked.search('кукуруза', shopCtx);
  assert.equal(calls.filter((c) => !c.url.includes('/cache/')).length, 3, 'протухшая метка перечитана');
  forgetSvetoforStamp('kaluzhskaya-oblast');
  assert.equal(svetoforStamp('kaluzhskaya-oblast'), undefined, 'метку можно сбросить вручную');
}

{
  // Метка протухла: 404 на файле → один перезаход за меткой → повтор
  clearSvetoforCache();
  setSvetoforStamp('kaluzhskaya-oblast', '1111111111');
  const { fetchImpl, calls } = harness((url) => {
    if (url.includes('/cache/')) {
      return url.includes('offers-649-1791443124.json')
        ? { status: 200, body: JSON.stringify(fixture) }
        : { status: 404, body: '' };
    }
    return { status: 200, body: REGION_HTML };
  });
  const adapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, fetchImpl);
  const found = await adapter.search('кукуруза', shopCtx);
  assert.ok(found.length > 0, 'после 404 адаптер сам перечитал метку и нашёл товар');
  assert.equal(svetoforStamp('kaluzhskaya-oblast'), '1791443124', 'метка обновилась');
  assert.equal(calls.filter((c) => c.url.includes('1111111111')).length, 1, 'старый файл попробован один раз');

  // Метка в памяти протухшая, регион отдал новую, а файла по новой нет: второй
  // отказ с внятным текстом, а не бесконечный перезаход за меткой.
  clearSvetoforCache();
  setSvetoforStamp('kaluzhskaya-oblast', '1111111111');
  const goneToo = harness((url) =>
    url.includes('/cache/') ? { status: 404, body: '' } : { status: 200, body: REGION_HTML },
  );
  const goneTooAdapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, goneToo.fetchImpl);
  await assert.rejects(
    () => goneTooAdapter.search('молоко', shopCtx),
    /недоступен по свежей метке 1791443124/,
    'новая метка, но файла нет — второй отказ, в тексте видна свежая метка',
  );

  // Метка свежая, а файл всё равно 404 — второй попытки нет, внятная ошибка
  clearSvetoforCache();
  setSvetoforStamp('kaluzhskaya-oblast', '1791443124');
  // Страница региона при этом живая: метка свежая, а файла нет. Второй попытки
  // нет, отказ сети внятный — breaker поставит сети паузу.
  const dead = harness((url) =>
    url.includes('/cache/') ? { status: 404, body: '' } : { status: 200, body: REGION_HTML },
  );
  const deadAdapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, dead.fetchImpl);
  await assert.rejects(
    () => deadAdapter.search('молоко', shopCtx),
    /недоступен по свежей метке/,
    'уехавший магазин — один повтор и отказ',
  );
  assert.equal(
    dead.calls.filter((c) => c.url.includes('/cache/')).length,
    1,
    'файл запросили один раз: метка и так свежая, второй раз за тем же URL не идём',
  );
  assert.equal(
    dead.calls.filter((c) => !c.url.includes('/cache/')).length,
    1,
    'страницу региона перечитали один раз',
  );

  // Метка свежая, но файл уехал совсем: страница региона тоже 404 — отказ сети
  const gone = harness(() => ({ status: 404, body: '' }));
  const goneAdapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, gone.fetchImpl);
  await assert.rejects(
    () => goneAdapter.search('молоко', shopCtx),
    /HTTP 404/,
    'уехавший регион — отказ сети, а не бесконечный перезаход за меткой',
  );
}

{
  // 500 и прочие коды — отказ сети без повторов
  clearSvetoforCache();
  setSvetoforStamp('kaluzhskaya-oblast', '1791443124');
  const { fetchImpl, calls } = harness((url) =>
    url.includes('/cache/') ? { status: 503, body: '' } : { status: 200, body: REGION_HTML },
  );
  const adapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, fetchImpl);
  await assert.rejects(() => adapter.search('молоко', shopCtx), /HTTP 503/, 'ошибка сети видна в тексте');
  assert.equal(calls.filter((c) => c.url.includes('/cache/')).length, 1, 'на 503 не лезем за новой меткой');
}

{
  // Не-JSON, не-массив и прочий мусор — отказ сети, а не «пустые категории»
  clearSvetoforCache();
  setSvetoforStamp('kaluzhskaya-oblast', '1791443124');
  const bad = ['<html>капча</html>', '{"2235":{}}', '"строка"', 'null'] as const;
  for (const body of bad) {
    const { fetchImpl } = harness(() => ({ status: 200, body }));
    const adapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, fetchImpl);
    await assert.rejects(
      () => adapter.search('молоко', shopCtx),
      /svetofor/,
      `мусор в прайсе падает: ${body.slice(0, 14)}`,
    );
  }
  // Массив без дат — тоже мусор: сеть переименовала поле, и молча пропустить
  // значило бы вписать в историю цены неизвестного возраста.
  const noDates = harness(() => ({
    status: 200,
    body: JSON.stringify([{ id: 1, name: 'Арахис', p: 1000 }]),
  }));
  const noDatesAdapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, noDates.fetchImpl);
  await assert.rejects(
    () => noDatesAdapter.search('арахис', shopCtx),
    (err: unknown) => err instanceof Error && !isStaleStoreError(err) && /формат изменился/.test(err.message),
    'массив без дат — сетевой отказ, а не пустые результаты и не отказ точки',
  );
}

{
  // Кап выдачи и мусорные строки внутри живого прайса
  clearSvetoforCache();
  setSvetoforStamp('kaluzhskaya-oblast', '1791443124');
  const nowSec = Math.floor(Date.now() / 1000);
  const noisy = [
    { id: 999901, p: 1000, d: nowSec },
    ...Array.from({ length: 60 }, (_, i) => ({ id: 900000 + i, name: `Хлеб ржаной ${i}`, p: 5000, d: nowSec })),
  ];
  const { fetchImpl } = harness((url) =>
    url.includes('/cache/') ? { status: 200, body: JSON.stringify(noisy) } : { status: 200, body: REGION_HTML },
  );
  const adapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, fetchImpl);
  const capped = await adapter.search('хлеб', shopCtx);
  assert.equal(capped.length, 40, 'выдача обрезается капом в 40 товаров');
  const all = await adapter.search('', shopCtx);
  assert.ok(all.length > 0 && all.length <= 40, 'и пустой запрос обрезан');
  const brokenRow = await adapter.search('ржаной', shopCtx);
  assert.equal(brokenRow.length, 40, 'строка без названия не роняет поиск');
}

{
  // Протухший прайс магазина — это отказ сети, а не «переименование»: иначе
  // breaker не поставит сети паузу, а в UI будет тихое «товар не найден».
  clearSvetoforCache();
  setSvetoforStamp('kaluzhskaya-oblast', '1791443124');
  const old = Math.floor((Date.now() - 2 * 365 * 24 * 3600 * 1000) / 1000);
  const stale = [{ id: 1, name: 'Арахис обжаренный', p: 1000, d: old }];
  const { fetchImpl } = harness((url) =>
    url.includes('/cache/') ? { status: 200, body: JSON.stringify(stale) } : { status: 200, body: REGION_HTML },
  );
  const adapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, fetchImpl);
  await assert.rejects(
    () => adapter.search('арахис', shopCtx),
    /протух/,
    'поиск по протухшему прайсу — отказ сети, а не пустая выдача',
  );
  await assert.rejects(
    () => adapter.fetchProduct('svt-1', { city: 'kaluga', externalStoreId: '649', name: 'Арахис обжаренный' }),
    /протух/,
    'карточка по протухшему прайсу — тоже отказ сети, а не ProductLookupError',
  );
}

{  // Однозначное совпадение по названию — переименование, принимаем;
  // неоднозначное («Арахис» есть и обжаренный, и необжаренный) — не угадываем;
  // разная фасовка — тоже не наш товар.
  clearSvetoforCache();
  setSvetoforStamp('kaluzhskaya-oblast', '1791443124');
  const nowSec = Math.floor(Date.now() / 1000);
  const rows2 = [
    { id: 880, name: 'Арахис обжаренный 500 г', p: 14370, d: nowSec },
    { id: 881, name: 'Арахис обжаренный солёный 500 г', p: 14370, d: nowSec },
    { id: 884, name: 'Арахис обжаренный 500 г с кунжутом', p: 15370, d: nowSec },
    { id: 882, name: 'Гречка зелёная 500 г', p: 9900, d: nowSec },
    { id: 883, name: 'Гречка зелёная 900 г', p: 17900, d: nowSec },
    { id: 777, name: 'Гречка зелёная', p: 9900, d: nowSec },
    { name: 'Гречка зелёная без номера', p: 9900, d: nowSec },
  ];
  const { fetchImpl } = harness((url) =>
    url.includes('/cache/') ? { status: 200, body: JSON.stringify(rows2) } : { status: 200, body: REGION_HTML },
  );
  const adapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, fetchImpl);
  const renamed = await adapter.fetchProduct('svt-88888888', {
    city: 'kaluga',
    externalStoreId: '649',
    name: 'Гречка зелёная',
  });
  assert.equal(renamed.name, 'Гречка зелёная', 'единственное совпадение принято как переименование');
  // Одинаковая фасовка у двух SKU: «Арахис обжаренный 500 г» и «Арахис обжаренный
  // 500 г с кунжутом» подходят под одно имя из БД оба — угадывать нельзя.
  await assert.rejects(
    () =>
      adapter.fetchProduct('svt-88888888', {
        city: 'kaluga',
        externalStoreId: '649',
        name: 'Арахис обжаренный 500 г',
      }),
    (err: unknown) => isProductLookupError(err),
    'два SKU с одинаковой фасовкой — ProductLookupError, а не чужой товар',
  );
  // Фасовка из БД совпала ровно с одной строкой прайса — это переименование,
  // принимаем, даже если id в сети другой.
  const samePack = await adapter.fetchProduct('svt-999', {
    city: 'kaluga',
    externalStoreId: '649',
    name: 'Гречка зелёная 500 г',
  });
  assert.equal(samePack.name, 'Гречка зелёная 500 г', 'совпавшая фасовка — переименование, не чужой товар');
  // Точное совпадение названия (без фасовки) находит строку «без фасовки», а
  // варианты с фасовкой отбрасываются проверкой чисел — иначе под «Гречка
  // зелёная» подошли бы сразу три SKU и угадывать пришлось бы вслепую.
  const exactName = await adapter.fetchProduct('svt-998', {
    city: 'kaluga',
    externalStoreId: '649',
    name: 'Гречка зелёная',
  });
  assert.equal(exactName.name, 'Гречка зелёная', 'точное совпадение названия нашло строку без фасовки');
  // Строки нашлись по названию, но у всех нет цены: это формат поехал, и сказать
  // об этом должен текст ошибки, а не «в прайсе 0 товаров».
  clearSvetoforCache();
  setSvetoforStamp('kaluzhskaya-oblast', '1791443124');
  const noPrice = harness((url) =>
    url.includes('/cache/')
      ? {
          status: 200,
          body: JSON.stringify([
            { id: 5, name: 'Гречка зелёная 500 г', d: Math.floor(Date.now() / 1000) },
            { id: 6, name: 'Гречка зелёная 500 г с кунжутом', d: Math.floor(Date.now() / 1000) },
          ]),
        }
      : { status: 200, body: REGION_HTML },
  );
  const noPriceAdapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, noPrice.fetchImpl);
  await assert.rejects(
    () =>
      noPriceAdapter.fetchProduct('svt-404', {
        city: 'kaluga',
        externalStoreId: '649',
        name: 'Гречка зелёная 500 г',
      }),
    /цены в прайсе нет/,
    'строки нашлись, цен нет — в тексте это сказано прямо',
  );
  // Тот же `id`, но без цены: возвращать под нашим ключом чужой товар нельзя,
  // поэтому это ProductLookupError, а не подбор по названию.
  const ownIdNoPrice = harness((url) =>
    url.includes('/cache/')
      ? {
          status: 200,
          body: JSON.stringify([
            { id: 5, name: 'Гречка зелёная 500 г', d: Math.floor(Date.now() / 1000) },
            { id: 6, name: 'Гречка зелёная 500 г с кунжутом', p: 5000, d: Math.floor(Date.now() / 1000) },
          ]),
        }
      : { status: 200, body: REGION_HTML },
  );
  const ownIdAdapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, ownIdNoPrice.fetchImpl);
  await assert.rejects(
    () =>
      ownIdAdapter.fetchProduct('svt-5', {
        city: 'kaluga',
        externalStoreId: '649',
        name: 'Гречка зелёная 500 г',
      }),
    (err: unknown) => isProductLookupError(err) && /без цены или без названия/.test((err as Error).message),
    'наш id без цены — ProductLookupError, а не чужой товар из подбора по названию',
  );

  // Прайс этой точки остался в общем кэше — сбрасываем, иначе следующие кейсы
  // получили бы не тот список.
  clearSvetoforCache();

  // Обрезанное сетью название в БД находит строку без фасовки: варианты с
  // фасовкой отпадают по числам, а строка без фасовки совпадает. Это ровно тот
  // случай, ради которого сверка и нужна — иначе ребрендинг убил бы отслеживание.
  const truncated = await adapter.fetchProduct('svt-997', {
    city: 'kaluga',
    externalStoreId: '649',
    name: 'Гречка зелёна',
  });
  assert.equal(truncated.name, 'Гречка зелёная', 'обрезанное сетью имя нашло строку без фасовки');
  await assert.rejects(
    () => adapter.fetchProduct('svt-Гречка зелёная', { city: 'kaluga', externalStoreId: '649' }),
    (err: unknown) => isProductLookupError(err),
    'без названия и без id товар не найти — ProductLookupError',
  );
}

{
  // Страница региона недоступна или без метки — внятная ошибка
  clearSvetoforCache();
  const bad = [
    [{ status: 503, body: '' }, /HTTP 503/],
    [{ status: 200, body: '<html>капча, метки нет</html>' }, /нет метки прайса offersupd/],
  ] as const;
  for (const [reply, expected] of bad) {
    const { fetchImpl } = harness(() => reply);
    const adapter = new SvetoforAdapter({ domain: () => 'moskovskaya-oblast' }, fetchImpl);
    await assert.rejects(
      () => adapter.search('молоко', { city: 'moscow', externalStoreId: '820' }),
      expected,
      'проблема с меткой прайса видна в тексте ошибки',
    );
  }
  const direct = await resolveSvetoforStamp(harness(() => bad[0][0]).fetchImpl, 'moskovskaya-oblast').catch(
    (err: unknown) => err as Error,
  );
  assert.ok(direct instanceof Error && /HTTP 503/.test(direct.message), 'resolveSvetoforStamp тоже падает внятно');
}

{
  // Кэш прайса: свежий файл не перечитывается, протухший — перечитывается
  clearSvetoforCache();
  setSvetoforStamp('kaluzhskaya-oblast', '1791443124');
  const { fetchImpl, calls } = priceHarness();
  let clock = 1_000;
  const adapter = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, fetchImpl, () => clock);
  await adapter.search('кукуруза', shopCtx);
  await adapter.search('кукуруза', shopCtx);
  assert.equal(calls.filter((c) => c.url.includes('/cache/')).length, 1, 'в пределах TTL прайс читается один раз');
  clock += SVETOFOR_PRICE_TTL_MS + 1;
  const stale = await adapter.search('кукуруза', shopCtx);
  assert.ok(stale.length > 0, 'после TTL прайс перечитывается и товары находятся');
  assert.equal(calls.filter((c) => c.url.includes('/cache/')).length, 2, 'на самом деле ушёл второй запрос');
}

{
  // Две точки одного региона не выбивают кэш друг друга: домен — это регион, и
  // в нём около 16 точек, так что вытеснение по домену целиком заставляло бы
  // перечитывать прайс каждой точки по разу на товар.
  clearSvetoforCache();
  setSvetoforStamp('moskovskaya-oblast', '1786617803');
  const region = harness((url) =>
    url.includes('/cache/') ? { status: 200, body: JSON.stringify(fixture) } : { status: 200, body: REGION_HTML },
  );
  const shopA = new SvetoforAdapter({ domain: () => 'moskovskaya-oblast' }, region.fetchImpl);
  for (const id of ['1', '2', '3', '4']) {
    await shopA.search('кукуруза', { city: 'moscow', externalStoreId: id });
  }
  assert.equal(
    region.calls.filter((c) => c.url.includes('/cache/')).length,
    4,
    'каждая точка региона читает свой прайс один раз, четыре товара — четыре загрузки',
  );


  // Смена метки вытесняет старые ключи домена: память не растёт весь процесс.
  setSvetoforStamp('moskovskaya-oblast', '1786699999');
  await shopA.search('кукуруза', { city: 'moscow', externalStoreId: '1' });
  assert.equal(
    region.calls.filter((c) => c.url.includes('1786699999')).length,
    1,
    'по новой метке прайс прочитан заново',
  );
  clearSvetoforCache();
}

{
  // Кэш не растёт: при смене метки старый ключ домена вытесняется, а ключи
  // другого домена не трогаются. Иначе старые метки копились бы весь процесс —
  // прайс это ~0,5 МБ на точку.
  clearSvetoforCache();
  setSvetoforStamp('kaluzhskaya-oblast', '1791443124');
  setSvetoforStamp('moskovskaya-oblast', '1786617803');
  const { fetchImpl } = harness((url) =>
    url.includes('/cache/')
      ? { status: 200, body: JSON.stringify(fixture) }
      : { status: 200, body: '<script>var offersupd=1786617803;</script>' },
  );
  const kaluga = new SvetoforAdapter({ domain: () => 'kaluzhskaya-oblast' }, fetchImpl);
  const moscow = new SvetoforAdapter({ domain: () => 'moskovskaya-oblast' }, fetchImpl);
  await moscow.search('кукуруза', { city: 'moscow', externalStoreId: '376' });
  await kaluga.search('кукуруза', shopCtx);
  setSvetoforStamp('kaluzhskaya-oblast', '1791444999');
  forgetSvetoforStamp('moskovskaya-oblast');
  await kaluga.search('кукуруза', shopCtx);
  const stillThere = await moscow.search('кукуруза', { city: 'moscow', externalStoreId: '376' });
  assert.ok(stillThere.length > 0, 'вытеснение ключа одного домена не тронуло другой');
}

{
  // Смена метки вытесняет и записи протухших ключей: иначе они висели бы до конца
  // процесса (точки × метки). Проверяем на настоящем протухшем файле.
  clearSvetoforCache();
  const oldStamp = '1700000000';
  setSvetoforStamp('moskovskaya-oblast', oldStamp);
  const ancientFile = [
    { id: 1, name: 'Арахис', p: 1000, d: Math.floor(Date.parse('2021-12-31T10:00:00Z') / 1000) },
  ];
  const marks = harness((url) =>
    url.includes('/cache/')
      ? { status: 200, body: JSON.stringify(ancientFile) }
      : { status: 200, body: REGION_HTML },
  );
  const markAdapter = new SvetoforAdapter({ domain: () => 'moskovskaya-oblast' }, marks.fetchImpl);
  await assert.rejects(
    () => markAdapter.search('арахис', { city: 'moscow', externalStoreId: '9' }),
    (err: unknown) => isStaleStoreError(err),
    'старая метка даёт протухший прайс и его запись попадает в негативный кэш',
  );
  setSvetoforStamp('moskovskaya-oblast', '1786999999');
  const freshMarks = harness((url) =>
    url.includes('/cache/') ? { status: 200, body: JSON.stringify(fixture) } : { status: 200, body: REGION_HTML },
  );
  const freshAdapter = new SvetoforAdapter({ domain: () => 'moskovskaya-oblast' }, freshMarks.fetchImpl);
  const revived = await freshAdapter.search('кукуруза', { city: 'moscow', externalStoreId: '9' });
  assert.ok(revived.length > 0, 'по новой метке точка ожила и товары нашлись');
  assert.equal(
    marks.calls.filter((c) => c.url.includes('/cache/')).length,
    1,
    'протухшая точка второй раз не скачивалась: её запись вытеснена сменой метки',
  );
  clearSvetoforCache();
}

console.log(
  `svetofor: ALL GREEN — ${rows.length} товаров живого прайса (массив), цена из p, c игнорируется, SKU сквозной, цены per-store, unit из названия, свежесть по файлу, самолечение метки, кэш с TTL и вытеснение`,
);
