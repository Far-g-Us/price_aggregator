/**
 * Магнит: скрытое JSON-API сайта (`webgate`).
 *
 * Зачем модуль отдельный. Сайт — Nuxt SPA, и с 2026-10-18 страница поиска
 * `/search?term=…` отдаёт только оболочку (~40 КБ, `x-powered-by: Nuxt`),
 * где нет ни `shopCode`, ни ссылок на товары. Старый путь «fetch HTML и
 * распарсить `__NUXT_DATA__`» на этом молча возвращал пусто, а `assertOwnStore`
 * честно ругался «ответ от чужого магазина». Реальные данные приходят
 * XHR'ом, тело запроса снято перехватом трафика (Chromium, 2026-10-18):
 *
 *   POST /webgate/v2/goods/search
 *   {"includeAdultGoods":true,"pagination":{"offset":0,"limit":36},
 *    "sort":{"order":"desc","type":"popularity"},"term":"хлеб",
 *    "storeCode":"303857","storeType":"express","catalogType":"3"}
 *
 *   GET  /webgate/v3/categories/store/{shopCode}?storetype=express&catalogtype=3
 *
 * Оба ходят обычным `fetch` с кукой `shopCode` — ни антифрод-токенов, ни
 * браузера не требуется (проверено живьём, HTTP 200 без заголовков браузера).
 *
 * ГЛАВНОЕ ПРЕИМУЩЕСТВО ПЕРЕД HTML-разбором: код точки приходит полем
 * `storeCode` у КАЖДОГО товара. Это ровно тот признак, которого требовал
 * инвариант «успешный ответ ≠ наш магазин» (см. price-aggregator-domain),
 * и он проверяется без догадок и эвристик по ссылкам.
 *
 * ЕДИНИЦЫ: цены в КОПЕЙКАХ целыми (13099 = 130,99 ₽), проверено на живых
 * ответах «хлеб» и «молоко» по магазину 303857.
 */

/** Товар в ответе `/webgate/v2/goods/search`. Поля — как пришли, без домыслов. */
export interface WebgateGoodsItem {
  id?: number | string;
  productId?: number | string;
  name?: string;
  price?: number | null;
  promotion?: {
    isPromotion?: boolean | null;
    oldPrice?: number | null;
    discountPercent?: number | null;
  } | null;
  quantity?: number | null;
  isLowStock?: boolean | null;
  storeCode?: string | number | null;
  gallery?: { type?: string; url?: string }[] | null;
  seoCode?: string | null;
}

/** Ответ `/webgate/v2/goods/search`. */
export interface WebgateSearchResponse {
  items?: WebgateGoodsItem[] | null;
  pagination?: { totalCount?: number; hasMore?: boolean; nextOffset?: number | null } | null;
}

/** Узел дерева `/webgate/v3/categories/store/{shopCode}`. */
export interface WebgateCategoryNode {
  id?: number;
  name?: string;
  /**
   * Картинки категории. Живой ответ отдаёт их МАССИВОМ ОБЪЕКТОВ
   * (`[{type: "card", url: "https://…"}]`), а не строк: старый разбор искал
   * строки и потому не находил ни одной картинки — витрина получалась пустой,
   * и кэш витрины не писался.
   */
  images?: (string | { url?: string | null; type?: string | null })[] | null;
  /** Картинка категории одной строкой — у верхнего уровня дерева она есть. */
  image?: string | null;
  children?: WebgateCategoryNode[] | null;
}

export interface WebgateCategoriesResponse {
  items?: WebgateCategoryNode[] | null;
}

/** Единый товар после нормализации; цены — УЖЕ в рублях. */
export interface WebgateProduct {
  id: string;
  title: string;
  price: number;
  oldPrice: number | null;
  /** `undefined` — наличие неизвестно (поля нет), `false` — распродано. */
  inStock: boolean | undefined;
  imageUrl: string | null;
  url: string;
  observedShopCode: string;
}

export class WebgateDriftError extends Error {
  constructor(message: string) {
    super(message);
    // Имя класса в сообщении: проект проверяет ошибки по имени (см.
    // adapter-errors.ts), и без него «дрейф» не отличить от обычного отказа.
    this.name = 'WebgateDriftError';
  }
}

/**
 * Пустая выдача при ненулевом `pagination.totalCount`: сеть сама говорит, что
 * результаты есть, но не отдаёт ни одного. Это сбой сети (деградация/WAF), а не
 * «товар переименован» — отдельный класс, чтобы `fetchProduct` не прятал
 * такой ответ под HTML-фолбэк, а планировщик растит strike и ставил паузу.
 */
export class EmptySearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptySearchError';
  }
}

/** Отметка «тело не разобралось как JSON». Не ошибка сама по себе. */
export const NOT_JSON = Symbol('magnit:not-json');

/**
 * Разбор JSON без `SyntaxError` на входе. Различать надо ТРИ случая, иначе
 * ломается фолбэк:
 *  - не-JSON (WAF-страница, редирект на логин) — это транзиентный блок,
 *    повторный заход через другой маршрут имеет смысл;
 *  - JSON неожиданной ФОРМЫ (нет `items`, поля переименованы) — дрейф сети,
 *    повтор только жжёт бюджет, должен быть громкий отказ;
 *  - JSON ожидаемой формы с дрейфом значений — см. `parseWebgateSearch`.
 * Голый `JSON.parse` не различал бы первые два и вёл в браузерный фолбэк
 * даже там, где надо честно сказать «сменился ответ».
 */
export function safeJsonParse(text: string): unknown | typeof NOT_JSON {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Копейки → рубли. Единицы — целые копейки, поэтому целое число ТРЕБУЕТСЯ:
 * без этой проверки смена формата (`price: 130.99` вместо `13000`) молча
 * дала бы 1,31 ₽ и тихо уехала бы в `prices_history`. Тихий делитель —
 * худший вид поломки в ценах.
 *
 * `strict` различает, чьё это поле: для `price` дробное значение означает
 * смену единиц и обязано уронить весь разбор, а для `promotion.oldPrice`
 * (поле только для зачёркнутой подписи) достаточно не рисовать подчёркивание —
 * одна грязная скидка не должна обнулять остальные 35 товаров выдачи.
 */
function kopecksToRub(v: unknown, strict = true): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v <= 0) return null;
  if (!Number.isInteger(v)) {
    if (!strict) return null;
    throw new WebgateDriftError(
      `magnit: цена пришла не целыми копейками (${v}) — сменились единицы, делить на 100 нельзя`,
    );
  }
  // Целая, но подозрительно маленькая цена = рубли вместо копейек
  // (`130` вместо `13000`). Деление всё равно даст 1,30 ₽, поэтому ловим
  // пологом: любая цена Магнита дороже рубля.
  if (strict && v < 100) {
    throw new WebgateDriftError(
      `magnit: цена ${v} подозрительно мала для копеек — скорее всего пришли рубли, а не копейки`,
    );
  }
  return v / 100;
}

/**
 * Товар без цены пропускаем, а не пишем нулевой: сравнивать нечего, и в
 * `prices_history` попал бы товар без смысла. Это не «смена формата» —
 * пустой результат честный.
 */
function toProduct(item: WebgateGoodsItem): WebgateProduct | null {
  const title = typeof item.name === 'string' ? item.name.trim() : '';
  if (!title) return null;
  const price = kopecksToRub(item.price);
  if (price === null) return null;

  // `productId` — идентификатор ТОВАРА, `id` в живой выдаче с ним совпадает
  // (проверено 2026-10-18, 36 из 36 уникальны). Берём `productId` осознанно:
  // он же требуется `fetchProduct`, который строит адрес `/product/<id>`.
  const idRaw = item.productId ?? item.id;
  const id = idRaw != null && idRaw !== '' ? String(idRaw) : '';
  if (!id) return null;

  // Зачёркнутая цена — только когда она ДЕЙСТВИТЕЛЬНО выше текущей. У Магнита
  // `isPromotion: true` приходит и при `oldPrice: null` (живой пример: молоко
  // 146,00 ₽), поэтому верить флагу нельзя — зачёркнутая есть только там, где
  // она выше. Верхняя граница та же, что у HTML-пути (`validOldPrice`):
  // «старая цена в 5 раз дороже текущей» — это уже не скидка, а мусор сети.
  // Порог строгий (`<`), как там же: на ровно 5× подчёркивать нечего.
  const promo = item.promotion ?? null;
  const oldRaw = kopecksToRub(promo?.oldPrice, false);
  const oldPrice = oldRaw !== null && oldRaw > price && oldRaw < price * 5 ? oldRaw : null;

  // Остаток: `quantity` — реальный счётчик (живая выдача давала 0, 2, 3, 5, 6,
  // 13, 15, 24). Ноль — товара нет. ПОЛЯ НЕТ — «неизвестно» (undefined), а не
  // «есть»: иначе дрейф имени поля стал бы волной «в наличии» по всей сети.
  const inStock =
    typeof item.quantity === 'number' && Number.isFinite(item.quantity)
      ? item.quantity > 0
      : undefined;

  // Картинка: живой ответ кладёт в `gallery` и картинки, и видео (`type`),
  // поэтому https-ссылку ищем СНАЧАЛА среди IMAGE, и лишь затем — среди всех.
  // Иначе товар получил бы превью mp4 вместо фото.
  const gallery = Array.isArray(item.gallery) ? item.gallery : [];
  const imageUrl =
    gallery.find((g) => g?.type === 'IMAGE' && typeof g.url === 'string' && g.url.startsWith('https://'))?.url ??
    gallery.find((g) => typeof g?.url === 'string' && g.url.startsWith('https://'))?.url ??
    null;

  return {
    id,
    title,
    price,
    oldPrice,
    inStock,
    imageUrl,
    // Короткий адрес — единственный ПРОВЕРЕННЫЙ (живая проверка 2026-10-18:
    // `/product/1000153899` → 200 со склеем на slug). Вариант
    // `/product/<id>/<seoCode>` отдаёт 404, поэтому не используется. `slug`
    // оставлен в типах ответа: пригодится, когда у сети появится канонический
    // адрес без редиректа.
    url: `https://magnit.ru/product/${encodeURIComponent(id)}`,
    // Код точки приходит и строкой, и числом (число ведущий ноль теряет), а
    // в базу и в товар должен ехать ОДИН И ТОТ ЖЕ канонический вид, что
    // настроен в справочнике точек: шесть цифр. Сверка — по ключу без
    // ведущих нулей, иначе «010033» и «10033» сочли бы разными магазинами.
    observedShopCode: canonicalShopCode(item.storeCode),
  };
}

/**
 * Ключ сверки кода точки: цифры без ведущих нулей. `010033` (Краснодар) и
 * `10033` — ОДИН И ТОТ ЖЕ магазин, а сеть отдаёт код то строкой, то числом
 * (число ведущий ноль теряет по определению). Сравнивать «как есть» нельзя:
 * живой код города уехал бы в «ответ от чужого магазина» и выключил бы опрос
 * целого города.
 */
export function shopCodeKey(code: string | number | null | undefined): string {
  if (code == null) return '';
  return String(code).replace(/^0+(?=\d)/, '');
}

/**
 * Каноническая запись кода точки: шесть цифр. Число и строка без ведущих
 * нулей приводятся к одному виду, чтобы в товар и в базу ехал ОДИН И ТОТ ЖЕ
 * код, что настроен в справочнике точек.
 */
export function canonicalShopCode(code: string | number | null | undefined): string {
  if (code == null) return '';
  // Число — приводим к строке; строка должна быть ЦЕЛИКОМ из цифр. Иначе из
  // мусора («abc303857») собирался бы «настоящий» код 303857, и сверка
  // пропустила бы чужую точку.
  const digits = typeof code === 'number' ? String(Math.trunc(code)) : code;
  if (!/^\d+$/.test(digits)) return '';
  // Ноль — не код точки: «000000» выглядел бы как настоящий магазин.
  if (/^0+$/.test(digits)) return '';
  return digits.padStart(6, '0');
}

/**
 * Тело ответа поиска: поле `items` обязана быть массивом, ответ без него —
 * дрейф сети, а не «ничего не нашлось». Вынесено отдельно от
 * `parseWebgateSearch`, чтобы адаптер и зонд `magnit:store` опирались на одно
 * правило, а не держали две его копии, которые уже разъезжались.
 */
export function readSearchItems(raw: unknown): WebgateGoodsItem[] {
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new WebgateDriftError('magnit: в ответе webgate/v2/goods/search нет поля items (смена ответа сети?)');
  }
  return raw.items as WebgateGoodsItem[];
}

/**
 * Разбор выдачи поиска. Контракт жёсткий: ответ без `items` — дрейф сети
 * (громкий отказ, чтобы breaker поставил сети паузу), а ПУСТЫЙ массив —
 * честный «ничего не нашлось».
 */
export function parseWebgateSearch(raw: unknown, shopCode: string): WebgateProduct[] {
  const items = readSearchItems(raw);
  const out: WebgateProduct[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const product = toProduct(item);
    if (!product) continue;
    // Сверка точки ПО ТОВАРУ. Чужой shopCode в выдаче = цены чужого магазина,
    // и молча отбрасывать их нельзя: это ровно тот случай, из-за которого в
    // инварианте запрещён silent skip. Сравнение — по ключу без ведущих
    // нулей: «010033» и «10033» это один магазин, а не два.
    if (shopCodeKey(product.observedShopCode) !== shopCodeKey(shopCode)) {
      throw new Error(
        `magnit: ответ от чужого магазина (товар ${product.id} отдал shopCode=${product.observedShopCode || 'нет'}, настроен ${shopCode})`,
      );
    }
    out.push(product);
  }
  // Непустая выдача, из которой не узнан НИ ОДИН товар, — это дрейф, а не
  // «ничего не нашлось»: скорее всего сеть переименовала `price` или `name`.
  // Молча вернуть `[]` здесь означало бы показать пустую выдачу и НЕ дать
  // breaker'у поставить сети паузу (тот же класс ошибки, что у Чижика и Ленты).
  if (items.length > 0 && out.length === 0) {
    throw new WebgateDriftError(
      `magnit: сеть отдала ${items.length} товаров, но не узнан ни один (смена полей ответа?)`,
    );
  }
  return out;
}

/**
 * Полка = ЛИСТ дерева (узел без детей), как у Чижика. Обход в ширину, чтобы
 * лимит не съеден верхними ветвями: дерево Магнита — «Молоко» → «Кефир» →
 * «Кефир 3,2%» → …, и обход в глубину ушёл бы в одну ветку.
 */
/**
 * Картинка категории.
 *
 * Живой ответ кладёт картинки в `images` МАССИВОМ ОБЪЕКТОВ (`{type, url}`), а
 * у верхнего уровня дерева есть ещё и поле `image` со строкой. Раньше разбор
 * искал в `images` только строки — и не находил ничего: витрина получалась
 * без единой картинки, а кэш витрины из-за этого не писался вовсе.
 */
function categoryImage(node: WebgateCategoryNode): string | null {
  const images = Array.isArray(node.images) ? node.images : [];
  for (const item of images) {
    if (typeof item === 'string' && item.startsWith('https://')) return item;
    if (item && typeof item === 'object' && typeof item.url === 'string' && item.url.startsWith('https://'))
      return item.url;
  }
  return typeof node.image === 'string' && node.image.startsWith('https://') ? node.image : null;
}

/**
 * Дерево витрины `/webgate/v3/categories/store/{shopCode}`.
 *
 * Верхний уровень — это «сюжетные» разделы (у них есть картинка), а листья —
 * конкретные категории вроде «Бакалея» или «Заморозка»: у листьев картинок
 * в ответе нет вовсе, поэтому витрина с картинками берётся из HTML-главной
 * (см. `fetchCategories` адаптера), а этот разбор — запасной путь.
 */
export function parseWebgateCategories(raw: unknown): { id: string; name: string; imageUrl: string | null }[] {
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new WebgateDriftError('magnit: в ответе webgate/v3/categories/store нет поля items (смена ответа сети?)');
  }
  const leaves: { id: string; name: string; imageUrl: string | null }[] = [];
  const seen = new Set<string>();
  const queue: WebgateCategoryNode[] = [...(raw.items as WebgateCategoryNode[])];
  const LIMIT = 40;
  while (queue.length > 0 && leaves.length < LIMIT) {
    const node = queue.shift()!;
    const children = Array.isArray(node.children) ? node.children : [];
    const id = node.id != null ? String(node.id) : '';
    const name = typeof node.name === 'string' ? node.name.trim() : '';
    if (children.length > 0) {
      for (const child of children) if (child) queue.push(child);
      continue;
    }
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
      const img = categoryImage(node);
      leaves.push({ id, name, imageUrl: img });
  }
  if (leaves.length === 0) {
    throw new WebgateDriftError('magnit: дерево webgate вернуло 0 листьев (смена ответа сети?)');
  }
  return leaves;
}

/** Тело POST-запроса поиска — ровно как шлёт сайт (снято перехватом). */
export function buildSearchBody(term: string, shopCode: string, limit = 36): string {
  return JSON.stringify({
    includeAdultGoods: true,
    pagination: { offset: 0, limit },
    sort: { order: 'desc', type: 'popularity' },
    term,
    storeCode: shopCode,
    storeType: 'express',
    catalogType: '3',
  });
}
