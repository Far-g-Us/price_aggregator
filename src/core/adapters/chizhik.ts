import { ProductLookupError, StaleStoreError } from '../adapter-errors.js';
import { chizhikSapId } from '../../shared/chizhik-regions.js';
import type { ScrapedProduct, StoreCategory } from '../../shared/types.js';
import { getWithRebuild } from './chizhik-browser.js';
import {
  assertChizhikSapId,
  chizhikCategoryIdFromUrl,
  chizhikNameQueries,
  chizhikPlu,
  flattenChizhikCategories,
  isKnownChizhikSap,
  normalizeChizhikItem,
  type ChizhikCategoryNode,
  type ChizhikItem,
} from './chizhik-parse.js';

// Адаптер Чижика. Каталог и цены читаются ТОЛЬКО из контекста страницы
// (см. chizhik-browser.ts: обычный fetch отдаёт 403, из страницы — 200), поэтому
// здесь нет ни fetch-ветки, ни параметра транспорта: один путь, один браузер.
//
// Транспорт принимает ПУТЬ, а не полный URL, и пересобирает сессию на 401/403 сам.
// Склейка вида `${ORIGIN}${полный URL}` даёт `https://app.chizhik.clubhttps://…`
// и NetworkError в браузере — это стоило одного прогона, поэтому здесь пути.
//
// Что важно помнить про формат (проверено живьём 2026-10-08):
//   - `mode` обязателен: без него сеть отвечает 422 с «missing query parameter»;
//   - поиск принимает `q`, а не `query`;
//   - отдельной карточки товара нет (`/products/<plu>` → 404), поэтому
//     fetchProduct ищет товар по названию, как Лента;
//   - цены сети ОБЩИЕ по городам: маркера магазина в теле нет, и единственная
//     защита от чужого магазина — код из нашего справочника СВЕРКА С ГОРОДОМ.
const API = (sapId: string): string => `/delivery/api/catalog/v3/stores/${sapId}`;

/** Сколько товаров забираем за один запрос: 48 — как у 5ka и Ленты. */
const PAGE = 48;
/** Сколько товаров забираем с полки: полка нужна целиком, а не постранично. */
const CATEGORY_PAGE = 200;

interface ProductsResponse {
  products?: ChizhikItem[] | null;
  /**
   * `strict` — сеть ищет ровно по строке. Другие значения означают размытую выдачу
   * (популярное вместо нашего товара), и она молча ушла бы в каталог и историю —
   * ровно та ловушка, что словили с параметром у Магнита. Поэтому проверяем.
   */
  query_type?: string | null;
}

/**
 * Товары из ответа. Отсутствующее или не-«список» поле — это дрейф формата, а не
 * «товаров нет»: раньше здесь возвращался пустой список, и полка молчала, а breaker
 * не срабатывал (сеть жива, витрина пуста — это другой класс отказа). Пустой
 * МАССИВ — честный ответ «ничего не нашлось», его пропускаем.
 */
function productsOf(data: ProductsResponse, where: string): ChizhikItem[] {
  if (data.products === undefined || data.products === null) {
    throw new Error(`chizhik: в ответе ${where} нет поля products (смена ответа сети?)`);
  }
  if (!Array.isArray(data.products)) {
    throw new Error(`chizhik: products в ответе ${where} — не список (смена ответа сети?)`);
  }
  return data.products;
}

/**
 * Режим поиска. Не strict — выдача размыта: сеть вернула популярное вместо
 * нашего товара, и молча уйти в каталог этому нельзя (ровно та ловушка, что с
 * параметром поиска у Магнита). Здесь это обычная ошибка, НЕ ProductLookupError:
 * размытая выдача не доказывает переименование, а выдав её за переименование, мы
 * отключили бы breaker и замолчали историю цены.
 */
/**
 * Товары после нормализации. Непустой ответ, из которого не осталось ни одного
 * товара, — это дрейф формата (например, уехало имя поля), а не «товаров нет»:
 * тихая пустая полка выглядит как пустая витрина, а breaker молчит.
 */
function normalizedItems(items: ChizhikItem[], ctx: { city: string; externalStoreId: string }, where: string): ScrapedProduct[] {
  const out = items.map((item) => normalizeChizhikItem(item, ctx)).filter((x): x is ScrapedProduct => x !== null);
  if (items.length > 0 && out.length === 0) {
throw new Error(
      `chizhik: ${where} — ${items.length} товаров, а после разбора не осталось ни одного ` +
        '(у всех нет цены или plu) — смена формата ответа сети?',
    );
  }
  return out;
}
/**
 * Режим поиска: сеть обязана искать ровно по строке.
 *
 * Не `strict` — выдача размыта (сеть вернула популярное вместо нашего товара), и
 * молча уйти в каталог этому нельзя: ровно та ловушка, что с параметром `?query=`
 * у Магнита. Здесь это обычная ошибка, НЕ ProductLookupError: размытая выдача не
 * доказывает переименование, а выдав её за переименование, мы отключили бы breaker
 * и замолчали историю цены.
 *
 * Зовётся из поиска и карточки, но НЕ из полки: там `query_type` не приходит вовсе,
 * это не поиск.
 */
function assertStrictQuery(data: ProductsResponse, where: string): void {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`chizhik: ответ ${where} — не объект (смена ответа сети?)`);
  }
  const type = data.query_type;
  // Пустая выдача без метки — честно: искать было нечего. Непустая без метки — дрейф:
  // метка наблюдается в живых ответах (search.json), и без неё мы не знаем, strict ли
  // поиск. Молча пропустить такой ответ означало бы записать в prices_history цены
  // ЧУЖИХ популярных товаров, а write-on-change их уже не отыграет назад — ровно та
  // ловушка, что с параметром `?query=` у Магнита.
  const nonEmpty = Array.isArray(data.products) && data.products.length > 0;
  if (type === 'strict') return;
  if (type === undefined || type === null) {
    if (nonEmpty) {
      throw new Error(
        `chizhik: в ответе ${where} нет метки query_type — неизвестно, strict ли поиск, ` +
          'а товары есть; доверять такой выдаче цену нельзя',
      );
    }
    return;
  }
  throw new Error(
    `chizhik: сеть искала ${where} в режиме «${type}», а не «strict» — выдача размыта, ` +
      'доверять ей цену нельзя',
  );
}
/**
 * Код магазина перед каждым запросом: формат плюс СООТВЕТСТВИЕ ГОРОДУ. Проверки
 * «код вообще из справочника» недостаточно: у сети цены общие по городам, и чужая
 * строка `stores` (sapId одного города в другом) тихо записала бы цену соседнего
 * города в историю этого, а по дате замера это не отличить.
 */
function storeFor(ctx: { city: string; externalStoreId: string }): string {
  const sapId = assertChizhikSapId(ctx.externalStoreId);
  if (!isKnownChizhikSap(sapId)) {
    throw new Error(`chizhik: магазин ${sapId} не из нашего справочника — цены придут не из того города`);
  }
  const own = chizhikSapId(ctx.city);
  if (own !== sapId) {
    // StaleStoreError, а не обычный Error: код магазина расходится со справочником
    // — это наша неверная настройка точки, а не отказ сети. Обычная ошибка дала бы
    // strike и паузу ВСЕЙ сети, а сеть-то жива: сломана только наша конфигурация.
    throw new StaleStoreError(
      `chizhik: в городе ${ctx.city} настроен магазин ${own}, а опрашивается ${sapId} — ` +
        'цены придут из чужого города',
      `chizhik:${ctx.city}`,
    );
  }
  return sapId;
}

export class ChizhikAdapter {
  readonly storeId = 'chizhik';

  async search(query: string, ctx: { city: string; externalStoreId: string }): Promise<ScrapedProduct[]> {
    const sapId = storeFor(ctx);
    const data = await getWithRebuild<ProductsResponse>(
      sapId,
      `${API(sapId)}/search?mode=delivery&include_restrict=true&limit=${PAGE}&q=${encodeURIComponent(query)}`,
    );
    assertStrictQuery(data, 'пользовательский запрос');
    return normalizedItems(productsOf(data, 'поиска'), ctx, 'пользовательский поиск');
  }

  async fetchProduct(
    canonicalId: string,
    ctx: { city: string; externalStoreId: string; name?: string },
  ): Promise<ScrapedProduct> {
    const sapId = storeFor(ctx);
    const plu = chizhikPlu(canonicalId);
    const name = ctx.name?.trim();
    if (!name) {
      throw new ProductLookupError(
        'у товара нет названия в базе — найди его поиском, чтобы опрос его видел',
        canonicalId,
      );
    }

    // Различаем «выдача была, нашего товара в ней нет» и «выдачи не было вовсе».
    // Второе — дрейф ответа или сеть, и это НЕ переименование: если выдать это за
    // переименование, breaker не сработает и история цены молча замрёт.
    const attempts: string[] = [];
    let sawAnyItems = false;
    for (const query of chizhikNameQueries(name)) {
      const data = await getWithRebuild<ProductsResponse>(
        sapId,
        `${API(sapId)}/search?mode=delivery&include_restrict=true&limit=${PAGE}&q=${encodeURIComponent(query)}`,
      );
      assertStrictQuery(data, `товар «${query.slice(0, 24)}»`);
      const items = productsOf(data, 'поиска');
      if (items.length > 0) sawAnyItems = true;
      attempts.push(`«${query.slice(0, 32)}…» товаров=${items.length}`);
      const hit = items.find((item) => String(item.plu ?? '') === plu);
      if (hit) {
        const product = normalizeChizhikItem(hit, ctx);
        if (!product) throw new Error(`chizhik: товар ${plu} без цены или имени в выдаче поиска`);
        return product;
      }
    }
    if (!sawAnyItems) {
      throw new Error(
        `chizhik: поиск вернул пустую выдачу на все попытки (${attempts.join('; ')}) — сеть или дрейф ответа`,
      );
    }
    throw new ProductLookupError(
      `товар не найден поиском по названию (${attempts.join('; ')}) — возможно, переименован или снят`,
      `chizhik-${plu}`,
    );
  }

  canHandleCategoryUrl(categoryUrl: string): boolean {
    return chizhikCategoryIdFromUrl(categoryUrl) !== null;
  }

  async fetchCategories(ctx: { city: string; externalStoreId: string }): Promise<StoreCategory[]> {
    const sapId = storeFor(ctx);
    const nodes = await getWithRebuild<ChizhikCategoryNode[]>(
      sapId,
      `${API(sapId)}/categories?mode=delivery&include_subcategories=1&include_restrict=true`,
    );
    const list = flattenChizhikCategories(nodes);
    if (list.length === 0) throw new Error('chizhik: категории пусты (смена ответа сети?)');
    return list;
  }

  async fetchCategoryProducts(
    categoryUrl: string,
    ctx: { city: string; externalStoreId: string },
  ): Promise<ScrapedProduct[]> {
    const categoryId = chizhikCategoryIdFromUrl(categoryUrl);
    if (!categoryId) throw new Error('chizhik: categoryUrl вне каталога');
    const sapId = storeFor(ctx);
    const data = await getWithRebuild<ProductsResponse>(
      sapId,
      `${API(sapId)}/categories/${encodeURIComponent(categoryId)}/products` +
        `?mode=delivery&include_restrict=true&limit=${CATEGORY_PAGE}`,
    );
    const items = productsOf(data, 'полки');
    // Пагинации у сети нет (зонд 2026-10-08: offset=200 → 404, page=2
    // игнорируется), то есть полка приходит целиком. Если товаров ровно столько,
    // сколько мы просим — она обрезана по нашему лимиту, и молчать об этом нельзя:
    // половина полки уехала бы в корзину, а витрина выглядела бы целой.
    if (items.length === CATEGORY_PAGE) {
      throw new Error(
        `chizhik: полка ${categoryId} вернула ровно ${CATEGORY_PAGE} товаров — она больше, ` +
          'а пагинации у сети нет: часть товаров потерялась бы молча',
      );
    }
    return normalizedItems(items, ctx, `полка ${categoryId}`);
  }
}