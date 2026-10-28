/**
 * Тесты нормализации webgate-ответа Магнита (`magnit-webgate`).
 *
 * Форма снята с живых ответов магазина 303857 (Москва) 2026-10-18, цены в
 * копейках целыми. Здесь важны четыре вещи, которые легко упустить:
 *
 *  1. КОПЕЙКИ, а не рубли. `13099` = 130,99 ₽. Ошибка в 100 раз — самая
 *     дорогая из возможных, потому что она тихо уезжает в `prices_history`.
 *  2. ЗАЧЁРКНУТАЯ ЦЕНА берётся не из флага `isPromotion`, а из `oldPrice`
 *     строго больше текущей: в живой выдаче встречалось `isPromotion: true`
 *     при `oldPrice: null` (молоко 146,00 ₽).
 *  3. СВЕРКА ТОЧКИ по `storeCode` у каждого товара. Чужой код = громкий
 *     отказ, а не молчаливый пропуск: это инвариант «успешный HTTP-ответ ≠
 *     наш магазин».
 *  4. ПУСТОЙ `items: []` — честный «ничего не нашлось», а отсутствие поля
 *     `items` — дрейф сети и тоже громкий отказ (но ДРУГОЙ).
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  buildSearchBody,
  canonicalShopCode,
  parseWebgateCategories,
  parseWebgateSearch,
  readSearchItems,
  shopCodeKey,
  WebgateDriftError,
} from '../src/core/adapters/magnit-webgate.js';

const SHOP = '303857';

const item = (over: Record<string, unknown> = {}) => ({
  id: 3422154710,
  productId: 3422154710,
  name: 'Хлеб Тостовый нарезанный Хлебный дом 500г',
  price: 13099,
  promotion: { isPromotion: false, oldPrice: null, discountPercent: null },
  quantity: 5,
  isLowStock: null,
  storeCode: SHOP,
  seoCode: 'hleb-toastovyy',
  gallery: [{ type: 'IMAGE', url: 'https://images-foodtech.magnit.ru/abc/rs:fit:416:416/plain/x.jpeg@webp' }],
  ...over,
});

// ── 1. Копейки → рубли ──────────────────────────────────────────────────────
{
  const [p] = parseWebgateSearch({ items: [item()] }, SHOP);
  assert.ok(p);
  assert.strictEqual(p.price, 130.99, 'копейки делятся на 100');
  assert.strictEqual(p.id, '3422154710');
  assert.strictEqual(p.inStock, true);
  assert.strictEqual(p.observedShopCode, SHOP);
  assert.ok(p.imageUrl?.startsWith('https://images-foodtech.magnit.ru/'));
  // Короткий адрес — единственный проверенный живьём; вариант со слагом
  // `/product/<id>/<seoCode>` отдаёт 404 (живая проверка 2026-10-18).
  assert.strictEqual(p.url, 'https://magnit.ru/product/3422154710');
}

// ── 2. Зачёркнутая цена: только строго выше текущей ─────────────────────────
{
  const [promo] = parseWebgateSearch(
    { items: [item({ price: 3299, promotion: { isPromotion: true, oldPrice: 4099 } })] },
    SHOP,
  );
  assert.strictEqual(promo!.oldPrice, 40.99, 'oldPrice выше цены — зачёркнутая');

  // Живой случай: акция есть, старой цены нет. Флагу верить нельзя.
  const [flagOnly] = parseWebgateSearch(
    { items: [item({ price: 14600, promotion: { isPromotion: true, oldPrice: null } })] },
    SHOP,
  );
  assert.strictEqual(flagOnly!.oldPrice, null, 'isPromotion без oldPrice — не зачёркнутая');

  // Старая ниже текущей — тоже мусор сети, в зачёркнутую не идёт.
  const [backwards] = parseWebgateSearch(
    { items: [item({ price: 5000, promotion: { isPromotion: true, oldPrice: 3000 } })] },
    SHOP,
  );
  assert.strictEqual(backwards!.oldPrice, null, 'oldPrice ниже цены отбрасывается');
}

// ── 3. Наличие: quantity, а его отсутствие — «неизвестно», не «нет» ────────
{
  const [zero] = parseWebgateSearch({ items: [item({ quantity: 0 })] }, SHOP);
  assert.strictEqual(zero!.inStock, false, 'quantity 0 — нет в наличии');
  const [none] = parseWebgateSearch({ items: [item({ quantity: null })] }, SHOP);
  assert.strictEqual(none!.inStock, undefined, 'нет поля quantity — «неизвестно», а не «распродано» и не «есть»');
}

// ── 3a. Единицы: цена обязана быть ЦЕЛЫМИ копейками. -----------------------
// Тихий делитель на 100 — худшая поломка в ценах: 130,99 ₽ превратились бы в
// 1,31 ₽ и уехали бы в `prices_history` без единого звука.
//
// ЧТО СТРАЖ НЕ ЛОВИТ (и это осознанно): «целая цена в РУБЛЯХ» (130 вместо
// 13000) одним товаром не отличить от честной цены в 1,30 ₽ — разбирать
// пришлось бы по статистике всей выдачи, а цена ошибки (ложный отказ на
// нормальной сети) выше выгоды. Ловится только грубое: цена дешевле рубля.
{
  assert.throws(
    () => parseWebgateSearch({ items: [item({ price: 130.99 })] }, SHOP),
    WebgateDriftError,
    'дробная цена = сменились единицы, а не «цена с копейками»',
  );
  assert.throws(
    () => parseWebgateSearch({ items: [item({ price: 50 })] }, SHOP),
    WebgateDriftError,
    '50 копеек = 50 ₽/100 — цена дешевле рубля неправдоподобна',
  );
  assert.strictEqual(
    parseWebgateSearch({ items: [item({ price: 100 })] }, SHOP)[0]!.price,
    1,
    'ровно 1,00 ₽ проходит: это граница правдоподобия',
  );
}

// ── 3b. Старая цена выше ×5 — мусор сети, а не скидка. ----------------------
{
  const [absurd] = parseWebgateSearch(
    { items: [item({ price: 1000, promotion: { isPromotion: true, oldPrice: 9000 } })] },
    SHOP,
  );
  assert.strictEqual(absurd!.oldPrice, null, 'старая в 9 раз дороже текущей отбрасывается');

  // РОВНО ×5 тоже не подчёркиваем: порог строгий (`<`), как в HTML-пути.
  const [exact] = parseWebgateSearch(
    { items: [item({ price: 1000, promotion: { isPromotion: true, oldPrice: 5000 } })] },
    SHOP,
  );
  assert.strictEqual(exact!.oldPrice, null, 'ровно 5× — граница, тоже мусор');

  // Дробная СТАРАЯ цена не должна ронять весь разбор: это поле рисует только
  // зачёркнутую подпись, одна грязная скидка не должна обнулять 35 товаров.
  const [dirtyPromo] = parseWebgateSearch(
    { items: [item({ promotion: { isPromotion: true, oldPrice: 4099.5 } })] },
    SHOP,
  );
  assert.strictEqual(dirtyPromo!.oldPrice, null, 'грязная скидка гасит только подчёркивание');
  assert.strictEqual(dirtyPromo!.price, 130.99, 'цена товара от грязной скидки не пострадала');
}

// ── 4. Товары без цены/имени/id пропускаются, а не пишутся нулём ────────────
{
  const goods = parseWebgateSearch(
    {
      items: [
        item({ price: 0 }),
        item({ price: null }),
        item({ name: '   ' }),
        item({ id: null, productId: null }),
        item(),
      ],
    },
    SHOP,
  );
  assert.strictEqual(goods.length, 1, 'остался только товар с полной ценой');
}

// ── 4a-1. Непустая выдача, из которой не узнан НИ ОДИН товар, — дрейф. -----
// Иначе UI показал бы «ничего не нашлось», а breaker не поставил бы сети
// паузу: сеть выглядела бы живой, просто молча перестав отдавать товары.
{
  assert.throws(
    () => parseWebgateSearch({ items: [item({ price: null }), item({ name: null })] }, SHOP),
    WebgateDriftError,
    'сеть отдала товары, но ни один не распознан — дрейф',
  );
}

// ── 4a. Картинка: берём ПЕРВУЮ https-картинку, мусор и пустоту не ставим ─────
{
  const [ok] = parseWebgateSearch(
    {
      items: [
        item({
          gallery: [
            { type: 'IMAGE', url: 'data:image/gif;base64,R0lGOD' },
            { type: 'VIDEO', url: 'https://cdn/v.mp4' },
            { type: 'IMAGE', url: 'https://images-foodtech.magnit.ru/ok.jpeg@webp' },
          ],
        }),
      ],
    },
    SHOP,
  );
  assert.strictEqual(ok!.imageUrl, 'https://images-foodtech.magnit.ru/ok.jpeg@webp', 'data: пропущен');

  const [none] = parseWebgateSearch({ items: [item({ gallery: null })] }, SHOP);
  assert.strictEqual(none!.imageUrl, null, 'нет галереи — картинка не выдумывается');

  const [junk] = parseWebgateSearch({ items: [item({ gallery: [{ type: 'IMAGE', url: '/local.png' }] })] }, SHOP);
  assert.strictEqual(junk!.imageUrl, null, 'относительный путь не годится на картинку');

  const [empty] = parseWebgateSearch({ items: [item({ gallery: [] })] }, SHOP);
  assert.strictEqual(empty!.imageUrl, null, 'пустая галерея — тоже null');

  // Видео без картинок: https-ссылка всё же лучше, чем ничего.
  const [videoOnly] = parseWebgateSearch(
    { items: [item({ gallery: [{ type: 'VIDEO', url: 'https://cdn/v.mp4' }] })] },
    SHOP,
  );
  assert.strictEqual(videoOnly!.imageUrl, 'https://cdn/v.mp4', 'видео — крайний случай, но не пустота');
}

// ── 4b. Мусор в типах: сеть может прислать что угодно, и это не наша поломка.
// Хороший товар в списке обязателен: одиночный мусор уходит в дрейф-ошибку
// (см. 4a-1), и проверять тут надо именно «пропускаем плохое, не роняя всё».
{
  const goods = parseWebgateSearch(
    {
      items: [
        item({ name: 42 as unknown as string, quantity: 'много' as unknown as number }),
        item({ price: Number.NaN }),
        item(),
      ],
    },
    SHOP,
  );
  assert.strictEqual(goods.length, 1, 'мусорные элементы пропущены, хороший уцелел');
  const [nullItem] = parseWebgateSearch(
    { items: [null as unknown as Record<string, unknown>, item()] },
    SHOP,
  );
  assert.ok(nullItem, 'null в items пропускается, а не роняет разбор');
}

// ── 5. Сверка точки: чужой shopCode — громкий отказ, не silent skip ─────────
{
  assert.throws(
    () => parseWebgateSearch({ items: [item({ storeCode: '277027' })] }, SHOP),
    /чужого магазина/,
    'чужой магазин в ответе',
  );
  assert.throws(
    () => parseWebgateSearch({ items: [item({ storeCode: null })] }, SHOP),
    /чужого магазина/,
    'отсутствие кода — тоже отказ: сверять нечем',
  );
  // ЧИСЛОВОЙ код — не гипотетика: соседние поля (`id`, `productId`, `price`)
  // сеть отдаёт числами. `typeof`-проверка превратила бы 303857 в пустую
  // строку и вызвала «чужого магазина» на ВСЮ выдачу сразу.
  const [numeric] = parseWebgateSearch(
    { items: [item({ storeCode: Number(SHOP) })] },
    SHOP,
  );
  assert.strictEqual(numeric!.observedShopCode, SHOP, 'числовой shopCode нормализуется строкой');

  // Число ведущий ноль теряет: `010033` (Краснодар) числом станет `10033`.
  // Без дописывания нуля живой код города честно поехал бы в «чужого
  // магазина» — fail-safe, но весь опрос Краснодара встал бы.
  const [padded] = parseWebgateSearch({ items: [item({ storeCode: 10033 })] }, '010033');
  assert.strictEqual(padded!.observedShopCode, '010033', 'числовой код дописывается до 6 цифр');

  // Тот же код СТРОКОЙ — сеть может отдать и строкой без ведущего нуля.
  // Сверка идёт по ключу без нулей, иначе живой код города считался бы чужим.
  const [stringNoZero] = parseWebgateSearch({ items: [item({ storeCode: '10033' })] }, '010033');
  assert.strictEqual(
    stringNoZero!.observedShopCode,
    '010033',
    'код приводится к каноническим шести цифрам',
  );

  // Ключи сверки: нули не значат, а мусор вместо кода — значат.
  assert.strictEqual(shopCodeKey('010033'), shopCodeKey(10033), 'ключ не зависит от ведущих нулей');
  assert.strictEqual(shopCodeKey(null), '', 'нет кода — пустой ключ');
  assert.strictEqual(canonicalShopCode('10033'), '010033', 'канонический код — шесть цифр');
  assert.strictEqual(canonicalShopCode(null), '', 'нет кода — пустой канонический вид');
  assert.strictEqual(canonicalShopCode('не код'), '', 'мусор вместо кода — пусто, а не «000000»');
  assert.strictEqual(canonicalShopCode('abc303857'), '', 'мусор с цифрами — пусто: код не выковывается');
  assert.strictEqual(canonicalShopCode(''), '', 'пустая строка — пусто');
  assert.strictEqual(canonicalShopCode('0'), '', 'ноль — не код точки');
  assert.strictEqual(canonicalShopCode('00'), '', 'одни нули — тоже не код точки');
  assert.strictEqual(canonicalShopCode('000000'), '', 'шесть нулей — не код точки');
}

// ── 6. Пусто ≠ дрейф ───────────────────────────────────────────────────────
{
  assert.deepStrictEqual(parseWebgateSearch({ items: [] }, SHOP), [], 'пустая выдача — честная пустота');
  assert.throws(
    () => parseWebgateSearch({}, SHOP),
    WebgateDriftError,
    'нет поля items — дрейф сети',
  );
  assert.throws(() => parseWebgateSearch('привет', SHOP), WebgateDriftError, 'не JSON-объект — дрейф');

  // `readSearchItems` — то же правило для зонда `magnit:store`, который не
  // разбирает выдачу, а только читает коды: сверка «items обязана быть
  // массивом» обязана жить в одном месте, а не в двух копиях.
  assert.deepStrictEqual(readSearchItems({ items: [{ storeCode: '303857' }] }), [{ storeCode: '303857' }]);
  assert.throws(() => readSearchItems({}), WebgateDriftError, 'и зонд отловит дрейж формы тем же классом');
}

// ── 8. Живая фикстура: форма ответа webgate/v2/goods/search ────────────────
// Снята с живого ответа магазина 473996 (2026-10-19). Это ОПОРНЫЙ контракт:
// `pagination.totalCount` различает «товар переименован» (0) и «сеть
// деградировала» (>0) в `fetchProduct`, и без подтверждения живым ответом
// классификация держалась бы на догадке.
{
  const raw = JSON.parse(
    readFileSync('tests/fixtures/magnit-webgate-search.json', 'utf8'),
  ) as { items?: unknown[]; pagination?: { totalCount?: number } };
  assert.strictEqual(typeof raw.pagination?.totalCount, 'number', 'в живом ответе есть totalCount');
  assert.ok((raw.pagination?.totalCount ?? 0) > 0, 'totalCount положителен — выдача непустая');

  const products = parseWebgateSearch(raw, '473996');
  assert.strictEqual(products.length, 3, 'все три товара фикстуры разобрались');
  const first = products[0]!;
  assert.strictEqual(first.observedShopCode, '473996', 'код точки из живого ответа');
  assert.strictEqual(first.price, 139.99, 'цена из живого ответа — копейки, делённые на 100');
  assert.strictEqual(first.inStock, true, 'quantity 6 → в наличии');
  assert.ok(first.imageUrl === null || first.imageUrl.startsWith('https://'), 'картинка — https или её нет');
  assert.match(first.url, /^https:\/\/magnit\.ru\/product\//, 'адрес товара — /product/<id>');
  assert.ok(first.id.length > 0, 'id товара непустой');
}

// ── 9. Категории: полка = лист, обход в ширину ─────────────────────────────
{
  const tree = {
    items: [
      {
        id: 1,
        name: 'Молоко',
        images: [],
        children: [
          { id: 11, name: 'Кефир', images: [], children: [{ id: 111, name: 'Кефир 3,2%', images: ['https://img/1.png'] }] },
        ],
      },
      { id: 2, name: 'Хлеб', images: null, children: [] },
    ],
  };
  const leaves = parseWebgateCategories(tree);
  // Порядок — именно breadth-first: «Хлеб» (второй корень, лист) попадает в
  // выдачу раньше «Кефира 3,2%» (третий уровень в глубину). Обход в глубину
  // ушёл бы в одну ветку «Молоко» и съел бы лимит — это и было причиной
  // делать полкой ЛИСТ дерева, а не верхний уровень.
  assert.deepStrictEqual(
    leaves.map((l) => l.id),
    ['2', '111'],
    'обход в ширину: листья уровнями, не вглубь',
  );
  assert.strictEqual(leaves[1]!.imageUrl, 'https://img/1.png');
  assert.strictEqual(leaves[0]!.imageUrl, null);

  assert.throws(() => parseWebgateCategories({ items: [] }), WebgateDriftError, 'пустое дерево — дрейф');
  assert.throws(() => parseWebgateCategories({}), WebgateDriftError, 'нет items — дрейф');
}

// ── 7a. Мусор в дереве: узлы без id/имени и повторы пропускаются молча. -----
{
  const leaves = parseWebgateCategories({
    items: [
      { id: null, name: 'Без id', children: [] },
      { id: 5, name: null, children: [] },
      { id: 6, name: '   ', children: [] },
      { id: 7, name: 'Хлеб', children: null },
      { id: 7, name: 'Хлеб (повтор)', children: [] },
      { id: 8, name: 'Молоко', children: [] },
    ],
  });
  assert.deepStrictEqual(
    leaves.map((l) => l.id),
    ['7', '8'],
    'без id/имения и дубликаты выкинуты, остальное — листья',
  );
}

// ── 8. Тело запроса совпадает со снятым у сайта ─────────────────────────────
{
  const body = JSON.parse(buildSearchBody('хлеб', SHOP)) as Record<string, unknown>;
  assert.strictEqual(body.storeCode, SHOP);
  assert.strictEqual(body.term, 'хлеб');
  assert.strictEqual(body.storeType, 'express');
  assert.strictEqual(body.catalogType, '3');
  assert.deepStrictEqual(body.pagination, { offset: 0, limit: 36 });
  assert.deepStrictEqual(body.sort, { order: 'desc', type: 'popularity' });
}

console.log('magnit-webgate: OK — цены, промо, наличие, сверка точки, дрейф, категории, тело запроса');
