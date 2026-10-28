// Нормализация товара Перекрёстка. Формат ответа снят живьём 2026-10-10
// (фикстуры `tests/fixtures/perekrestok/*.json`), здесь только приводится к общему
// виду `ScrapedProduct`.
//
// Три вещи, которые ломаются тихо, если не закрыть их здесь:
//
// 1. **Цены в КОПЕЙКАХ.** `priceTag.price = 9799` — это 97.99 ₽. Забытый делитель
//    даёт правдоподобные 9799 ₽ за молоко: ни breaker, ни глаз такое не заметят,
//    а write-on-change запись не отыграет.
// 2. **Цена со скидкой лежит в `price`.** При акции `price` — это цена ПОСЛЕ
//    скидки, а `grossPrice` — до неё. Значит `promoPrice` = price, `oldPrice` =
//    grossPrice. Если записать наоборот (как «обычная цена = price»), то история
//    покажет рост цены на каждой акции.
// 3. **Наличие — строка `balanceState`, а не флаг.** Живое значение «many».
//    Словарь целиком не снят, поэтому всё, кроме «много», остаётся
//    «неизвестно»: угаданное «нет в наличии» дало бы волну «распродано» по
//    сети при живых ценах.

import { StaleStoreError } from '../adapter-errors.js';
import type { ScrapedProduct } from '../../shared/types.js';

/** Верхний уровень фида: то, что сеть отдаёт один раз на весь ответ. */
export interface PerekrestokFeed {
  content?: {
    items?: unknown[];
    /** Код точки, к которой относятся цены. В Москве — «2053». */
    sapId?: unknown;
    /** Сеть сама пишет, строгий ли поиск. Не «strict» — ловушка popular-выдачи. */
    searchType?: unknown;
    paginator?: { step?: unknown; current?: unknown; nextPageExists?: unknown } | null;
  } | null;
}

interface PriceTag {
  price?: unknown;
  grossPrice?: unknown;
  labels?: unknown;
  discountCondition?: unknown;
}

interface PerekrestokItem {
  masterData?: { plu?: unknown; slug?: unknown; unitName?: unknown; weight?: unknown; volume?: unknown };
  title?: unknown;
  priceTag?: PriceTag | null;
  balanceState?: unknown;
  image?: { cropUrlTemplate?: unknown } | null;
  catalogPrimaryCategory?: { id?: unknown; title?: unknown; slug?: unknown } | null;
}

/** Понятная причина вместо «молча не нашлось»: цена обязана быть числом. */
function readPrice(kopeks: unknown): number | null {
  if (typeof kopeks !== 'number' || !Number.isFinite(kopeks)) return null;
  // Ноль — тоже не цена. В `prices_history` он навсегда остался бы записью «0 ₽»
  // и молол шкалу истории, а соседние сети (`lenta`, `svetofor`) отбрасывают
  // неположительные цены так же.
  if (kopeks <= 0) return null;
  const rubles = kopeks / 100;
  // Полоса правдоподобия: 1 млн ₽ за единицу товара — это уже не цена, а
  // дрейф формата, и такую цифру в историю цен пускать нельзя.
  if (rubles > 1_000_000) return null;
  return rubles;
}

/**
 * Наличие. Возвращает `true` только на подтверждённом слове, остальное —
 * `undefined` («неизвестно»), а НЕ `false`.
 *
 * Во всех живых фикстурах `balanceState` встречается только как `"many"`
 * (40 вхождений, 2026-10-10). Словарь целиком не снят, поэтому догадки вида
 * «`few` значит есть» здесь не выдумываются: угаданное «нет в наличии» или
 * угаданное «есть» дали бы волну ложных отметок по сети.
 */
function readInStock(balance: unknown): boolean | undefined {
  if (typeof balance !== 'string') return undefined;
  return balance.trim().toLowerCase() === 'many' ? true : undefined;
}

/** Картинка: шаблон с `%s`, в который подставляется размер. */
function readImage(item: PerekrestokItem): string | null {
  const tpl = item.image?.cropUrlTemplate;
  if (typeof tpl !== 'string' || tpl === '' || !tpl.includes('%s')) return null;
  return tpl.replace('%s', '320x320');
}

/**
 * Товар из ответа фида. `null` — товар без цены или без plu: записывать нечего,
 * и молча пропускать тоже нельзя, поэтому фид считает их сам (см.
 * `normalizePerekrestokFeed`).
 */
export function normalizePerekrestokItem(raw: unknown, ctx: { city: string; externalStoreId: string }): ScrapedProduct | null {
  if (raw === null || typeof raw !== 'object') return null;
  const item = raw as PerekrestokItem;
  const plu = typeof item.masterData?.plu === 'string' ? item.masterData.plu : '';
  const name = typeof item.title === 'string' ? item.title.trim() : '';
  const price = readPrice(item.priceTag?.price);
  if (plu === '' || name === '' || price === null) return null;

  const gross = readPrice(item.priceTag?.grossPrice);
  // Акция: цена в `price` уже со скидкой, `grossPrice` — до неё. Зачёркнутая
  // цена выше текущей — единственное честное подтверждение скидки.
  //
  // Обычная цена считается ОДИН раз здесь, а не переиспользуется через `??`
  // дальше: при `hasDiscount` значение `gross` заведомо не null, и проверка
  // «а вдруг null» была бы недостижимой веткой, которая читается как
  // «здесь возможен случай, которого не бывает».
  const regular = gross !== null && gross > price ? gross : price;
  const hasDiscount = regular !== price;
  const oldPrice = hasDiscount ? regular : null;
  const promoPrice = hasDiscount ? price : null;

  const image = readImage(item);
  const inStock = readInStock(item.balanceState);
  const out: ScrapedProduct = {
    canonicalId: `perekrestok:${plu}`,
    storeId: 'perekrestok',
    city: ctx.city,
    storeCode: ctx.externalStoreId,
    name,
    // Обычная цена товара — цена ДО скидки: именно она сравнивается с прошлым
    // замером в write-on-change, и именно её видит пользователь как «было».
    price: regular,
    collectedAt: new Date().toISOString(),
  };
  if (promoPrice !== null) out.promoPrice = promoPrice;
  if (oldPrice !== null) out.oldPrice = oldPrice;
  if (image !== null) out.imageUrl = image;
  if (inStock !== undefined) out.inStock = inStock;
  const unit = item.masterData?.unitName;
  if (typeof unit === 'string' && unit !== '') out.unit = unit;
  const url = item.masterData?.slug;
  if (typeof url === 'string' && url !== '') {
    out.url = `https://www.perekrestok.ru/catalog/product/${encodeURIComponent(url)}/`;
  }
  return out;
}

/**
 * Товары из ответа.
 *
 * Пустой массив — честная пустота (мусорный запрос так и отвечает). А вот
 * непустой ответ, из которого не осталось ни одного товара, — дрейф формата:
 * сеть жива, поля поехали, и тихая пустая витрина убрала бы товары из поиска и
 * из истории, а breaker смолчал бы. Такой отказ громкий — как у соседей
 * (`chizhik.ts`, `lenta.ts`).
 */
export function normalizePerekrestokFeed(raw: unknown, ctx: { city: string; externalStoreId: string }): ScrapedProduct[] {
  const feed = (raw ?? {}) as PerekrestokFeed;
  const items = Array.isArray(feed.content?.items) ? feed.content.items : [];
  const out: ScrapedProduct[] = [];
  for (const item of items) {
    const p = normalizePerekrestokItem(item, ctx);
    if (p !== null) out.push(p);
  }
  if (items.length > 0 && out.length === 0) {
    throw new Error(
      'perekrestok: в ответе есть товары, но после разбора не осталось ни одного ' +
        '(у всех нет plu, названия или цены) — смена ответа сети',
    );
  }
  return out;
}

/**
 * Код точки из ответа. Это и есть главная сверка: цена привязана к магазину,
 * а если сеть отдаст другую точку, её цена уехала бы в нашу историю.
 */
export function perekrestokSapId(raw: unknown): string | null {
  const feed = (raw ?? {}) as PerekrestokFeed;
  const sapId = feed.content?.sapId;
  if (typeof sapId !== 'string' || sapId === '') return null;
  return sapId;
}

/**
 * Строгий ли поиск. Сеть отдаёт `searchType` сама: при `strict` пустая выдача
 * означает «не нашлось», а любой другой режим (например `popular`) вернул бы
 * чужие товары, и `fetchProduct` записал бы их в историю.
 */
export function isStrictPerekrestokSearch(raw: unknown): boolean {
  const feed = (raw ?? {}) as PerekrestokFeed;
  return feed.content?.searchType === 'strict';
}

/**
 * Адрес единственного входа в товары: деревьев категорий у Перекрёстка нет,
 * поиск `/catalog/product/feed` — единственный путь и на десктопе, и в
 * читалке Android.
 */
export const FEED_PATH = '/catalog/product/feed';

/**
 * Сколько товаров берём за один запрос.
 *
 * 100 — потолок сети: при `perPage: 500` она отвечает 400 (проверено живьём
 * 2026-10-10). Поэтому «первые 10» означало бы молчаливо показывать четверть
 * того, что нашлось, без единого слова об обрезке.
 */
export const FEED_PAGE = 100;

const PREFIX = 'perekrestok:';

/** plu из нашего ключа товара: `perekrestok:2059346` → `2059346`. */
export function perekrestokPlu(canonicalId: string): string {
  if (!canonicalId.startsWith(PREFIX)) {
    throw new Error(`perekrestok: не наш ключ товара ${canonicalId.slice(0, 40)}`);
  }
  const plu = canonicalId.slice(PREFIX.length);
  if (plu === '') throw new Error('perekrestok: в ключе товара нет кода');
  return plu;
}

/** Код точки: цифры и ничего кроме них, код в адрес не подставляется. */
export function assertPerekrestokSapId(value: string): string {
  if (!/^\d{1,12}$/.test(value)) {
    throw new Error(`perekrestok: код магазина «${value.slice(0, 20)}» не похож на sapId (цифры)`);
  }
  return value;
}

/** Лестница длин названия: сеть режет запрос, полное название может не найтись. */
const NAME_CUTS = [40, 25];

/** Названия для поиска: целиком и укороченные. */
export function perekrestokNameQueries(name: string): string[] {
  const out = [name];
  for (const cut of NAME_CUTS) {
    const short = name.slice(0, cut).trim();
    if (short !== '' && !out.includes(short)) out.push(short);
  }
  return out;
}

/**
 * Строгий ли поиск. Сеть сама пишет `searchType`: если она искала не строго,
 * выдача размыта и в неё попали чужие популярные товары, а write-on-change их
 * потом не отыграет. Это обычная ошибка (breaker должен остановить сеть), а не
 * `ProductLookupError`.
 */
export function assertStrictSearch(data: unknown, where: string): void {
  // Массив — тоже `typeof 'object'`, поэтому проверяем явно: без этого
  // `[]`-ответ прошёл бы дальше как «пустая выдача», а это дрейф формата.
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`perekrestok: ответ ${where} — не объект (смена ответа сети?)`);
  }
  const feed = data as { content?: { items?: unknown[] } };
  const nonEmpty = Array.isArray(feed.content?.items) && feed.content.items.length > 0;
  if (isStrictPerekrestokSearch(data)) return;
  if (nonEmpty) {
    throw new Error(
      `perekrestok: сеть искала ${where} не строго (searchType=${JSON.stringify((data as { content?: { searchType?: unknown } }).content?.searchType)}), ` +
        'а товары вернула — доверять такой выдаче цену нельзя',
    );
  }
}

/**
 * Ответ относится к нашей точке. `sapId` в ответе — единственное, что можно
 * сверить: код из нашего справочника подставляется в заголовок/тело запроса,
 * но если сеть отдаст другую точку, её цены уедут в нашу историю молча.
 *
 * Отсутствие `sapId` — тоже отказ, а не «нечем проверять, ну и ладно»: сеть
 * отдаёт его в каждом ответе (снимали живьём 2026-10-10), а молча пропустить
 * проверку значило бы записать в историю цены неизвестно чьей точки.
 */
export function assertOwnStore(data: unknown, sapId: string, where: string): void {
  const answer = perekrestokSapId(data);
  if (answer === null) {
    throw new Error(`perekrestok: в ответе ${where} нет sapId — сеть сменила ответ, цены неизвестно чьи`);
  }
  if (answer === sapId) return;
  // Расхождение кода точки — наша неверная настройка, а не отказ сети: обычная
  // ошибка дала бы strike и паузу ВСЕЙ сети, а сеть-то жива.
  throw new StaleStoreError(
    `perekrestok: ${where} вернул цены точки ${answer}, а опрашивается ${sapId} — это чужой магазин`,
    `perekrestok:${sapId}`,
  );
}
