import type { ScrapedProduct, StoreCategory } from '../../shared/types.js';
import { CITY_TO_STORE } from '../../shared/chizhik-regions.js';

// Разбор ответов Чижика вынесен отдельно от адаптера — так же, как у 5ka: и
// браузерный транспорт, и тесты импортируют этот код статически, без динамического
// import() (см. 5ka-parse.ts про V8 и непокрытую ветку отказа).
//
// Формат ответов — тот же X5-бэкенд, что у 5ka, и разбор намеренно повторяет её
// правила, а не выносит их в общий модуль: цены у сетей свои, `storeId` и ссылки
// свои, а общий модуль превратился бы в точку, где правка одной сети тихо ломает
// другую. Проверено живьём 2026-10-08 по фикстурам tests/fixtures/chizhik/
// (Москва, магазин HD87).

export const CHIZHIK_ORIGIN = 'https://app.chizhik.club';

/** Максимум плиток в каталоге приложения: 40 — как у 5ka, сеть столько и отдаёт. */
export const CATEGORY_LIMIT = 40;

/** Код магазина Чижика: буквы и цифры (живые коды — `HD87`, `HDJ7`, `HD0J`). */
export function assertChizhikSapId(sap: string): string {
  if (!/^[A-Za-z0-9]{2,8}$/.test(sap)) throw new Error(`chizhik: bad sap_id ${sap}`);
  return sap;
}

/**
 * Код из нашего справочника, а не из ответа сети. Проверка нужна не для красоты:
 * `/api/v1/shops` обычному клиенту недоступен (307-петля), и если бы код приходил
 * из ответа каталога, в БД попал бы мусор, а не магазин.
 */
export function isKnownChizhikSap(sap: string): boolean {
  return Object.values(CITY_TO_STORE).some((store) => store.sapId === sap);
}

/** Короткий адрес товара: `/goods/<plu>` (зонд 2026-10-08 — 200, а несуществующий plu → 403). */
export function chizhikProductUrl(plu: string): string {
  return `${CHIZHIK_ORIGIN}/goods/${encodeURIComponent(plu)}`;
}

/** Короткий адрес полки: со слэшем на конце (без него сеть отдаёт 403). */
export function chizhikCategoryUrl(id: string): string {
  return `${CHIZHIK_ORIGIN}/catalog/${encodeURIComponent(id)}/`;
}

export function chizhikCategoryIdFromUrl(url: string): string | null {
  const m = url.match(/^https:\/\/app\.chizhik\.club\/catalog\/([A-Za-z0-9]+)\/?$/);
  return m?.[1] ?? null;
}

/** plu из нашего canonical id вида `chizhik-4309774`. */
export function chizhikPlu(canonicalId: string): string {
  const plu = canonicalId.replace(/^chizhik-/, '').trim();
  if (!/^\d+$/.test(plu)) throw new Error(`chizhik: не plu в canonical id ${canonicalId}`);
  return plu;
}

export interface ChizhikCategoryNode {
  id?: string | number | null;
  name?: string | null;
  type?: string | null;
  image_link?: string | null;
  categories?: ChizhikCategoryNode[] | null;
}

/**
 * Категории сети приходят ДЕРЕВОМ, и верхний узел служебный: на 2026-10-08 это
 * «Основной каталог», в другие дни кампания («Юбилейный раздел») — имя меняется,
 * а структура та же: один верхний узел без товаров и без картинки, реальные
 * категории лежат в его `categories`.
 *
 * Поэтому полка — это ЛИСТ дерева (узел без вложенных категорий), а всё, у чего
 * есть дети, — раздел: товары лежат в детях, и полка раздела вернула бы пустое.
 * Признак структурный, а не по имени или по `type`: у разделов поле `type`
 * бывает не у всех (у листьев оно не приходит вовсе, у разделов — `category_list`
 * у кампании и `undefined` у настоящих разделов), то есть ориентироваться на
 * него — значит однажды потерять половину витрины. Имя кампании меняется день ото
 * дня, структура — нет.
 */
export function flattenChizhikCategories(nodes: ChizhikCategoryNode[] | null | undefined): StoreCategory[] {
  const out: StoreCategory[] = [];
  const seen = new Set<string>();
  // Обход В ШИРИНУ, а не в глубину: при обрезке по лимиту обход в глубину отдал бы
  // все листья первой ветки и ни одного из остальных разделов — то есть молча
  // потерял бы половину витрины. Поуровневый обход режет равномерно.
  // Копия обязательна: ниже очередь чистится через `length = 0`, а взятая ссылка
  // на входной массив стёрла бы ответ сети у вызывающего (тест это ловит).
  const level: ChizhikCategoryNode[] = Array.isArray(nodes) ? [...nodes] : [];
  while (level.length > 0 && out.length < CATEGORY_LIMIT) {
    const next: ChizhikCategoryNode[] = [];
    for (const node of level) {
      const id = node?.id != null ? String(node.id) : '';
      const name = String(node?.name ?? '').trim();
      const kids = Array.isArray(node?.categories) ? node.categories : [];
      if (kids.length > 0) {
        next.push(...kids);
        continue;
      }
      if (!id || !name || seen.has(id) || out.length >= CATEGORY_LIMIT) continue;
      seen.add(id);
      const image = String(node?.image_link ?? '').trim();
      out.push({
        id,
        name,
        url: chizhikCategoryUrl(id),
        ...(/^https:\/\/\S+$/.test(image) ? { imageUrl: image } : {}),
      });
    }
    level.length = 0;
    level.push(...next);
  }
  return out;
}

export interface ChizhikItem {
  plu?: string | number | null;
  name?: string | null;
  /**
   * Формат цены у X5 встречается ДВА — как и у Пятёрки: в выдаче поиска и полки
   * `prices` это ОБЪЕКТ `{regular, discount, …}`, а в некоторых ответах приходит
   * МАССИВ `[{value, placement_type}]`. Объектный разбор массив не покрывает: цена
   * стала бы `undefined`, и все товары молча отфильтровались — полка пустая, breaker
   * молчит. Поэтому массивная форма тоже разбирается (см. priceParts).
   */
  prices?:
    | {
        regular?: string | number | null;
        discount?: string | number | null;
        cpd_promo_price?: string | number | null;
        cpd_promo_price_from_sum_cart?: string | number | null;
        markdown?: string | number | null;
      }
    | { value?: string | number | null; placement_type?: string | null }[]
    | null;
  /**
   * Мультибай-механика X5: `rebate.units_to_activate` = «цена ко 2-му», то есть
   * цена действует только от N-го товара в корзине, а единичная остаётся regular.
   * В живых выборках Чижика поле приходило `null`, но бэкенд у нас с 5ka общий и
   * там маркер виден в товарах, поэтому гард держим (см. 5ka-parse.ts).
   */
  promo?: { rebate?: { units_to_activate?: number | null } | null } | null;
  image_links?: { normal?: string[] | null; small?: string[] | null } | null;
  media?: { image_links?: { normal?: string[] | null; small?: string[] | null } | null } | null;
  is_available?: boolean | null;
  uom?: string | null;
  property_clarification?: string | null;
  price_piece_unit?: string | number | null;
}

/** Прайс-поля X5: строкой или числом, точка или запятая. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function validOldPrice(old: number | null, price: number): old is number {
  return old !== null && old > price && old / price < 5;
}

/**
 * Цена = `regular`. Акционная = `discount`. `cpd_promo_price` и
 * `cpd_promo_price_from_sum_cart` НЕ берём, и это отличие от 5ka осознанное:
 * у Пятёрки `cpd_promo_price` как обычная скидка подтверждён живой фикстурой, а у
 * Чижика в выборках 2026-10-08 (поиск, полка, 5 городов) оба поля приходили
 * `null`, и живого подтверждения, что это обычная акция, у нас нет. По формату
 * X5 это «цена ко 2-му», то есть мультибай: записав её в promoPrice, мы соврём о
 * цене единичного товара, а `prices_history` потом ещё и переписывать нельзя
 * (write-on-change). Если сеть начнёт отдавать непустой `discount` — он и попадёт
 * в промо, а расхождение с Пятёркой всплывёт в живых проверках.
 * Зачёркнутая цена — `markdown`.
 */
function priceParts(prices: ChizhikItem['prices']): { regular: number | null; promo: number | null; old: number | null } {
  if (prices === null || prices === undefined) return { regular: null, promo: null, old: null };
  if (Array.isArray(prices)) {
    // Массивная форма X5 (как в карточке Пятёрки): обычная цена помечена
    // `placement_type: regular_primary`, акционная определяется по величине
    // относительно неё. Метки у акционной цены в массиве не наблюдалось.
    const values = prices.map((p) => num(p?.value)).filter((v): v is number => v !== null);
    const tagged = prices.find((p) => p?.placement_type === 'regular_primary');
    const regular = num(tagged?.value) ?? values[0] ?? null;
    // Без обычной цены акции тоже нет: сравнивать не с чем.
    if (regular === null) return { regular: null, promo: null, old: null };
    const rest = values.filter((v) => v !== regular);
    return {
      regular,
      promo: rest.find((v) => v < regular) ?? null,
      old: rest.find((v) => v > regular) ?? null,
    };
  }
  return {
    regular: num(prices.regular),
    promo: num(prices.discount),
    old: num(prices.markdown),
  };
}

/** normal, иначе small с подъёмом до 800x800 — иначе картинка тихо ухудшалась бы. */
function bestImage(links?: { normal?: string[] | null; small?: string[] | null }): string | null {
  const normal = links?.normal?.[0];
  if (normal) return normal;
  const small = links?.small?.[0];
  return small ? small.replace(/\/320x320\.jpeg/, '/800x800.jpeg') : null;
}

/**
 * Цена за единицу приходит строкой («123,45 ₽/кг»). Числом сеть в выборках не
 * отдавала: придумывать формат для неё нельзя (в БД уедет строка, которой на
 * сайте нет), поэтому числовое значение молча отбрасываем — если сеть начнёт его
 * отдавать, это всплывёт в живых проверках и правило допишут.
 */
function pieceUnit(raw: ChizhikItem['price_piece_unit']): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

export function normalizeChizhikItem(raw: ChizhikItem, ctx: { city: string; externalStoreId: string }): ScrapedProduct | null {
  const plu = String(raw.plu ?? '');
  const name = String(raw.name ?? '').trim();
  if (!/^\d+$/.test(plu) || !name) return null;
  const { regular: price, promo: promoRaw, old: oldRaw } = priceParts(raw.prices);
  if (price === null) return null;
  // Мультибай («% ко 2-му»): цена действует только от N-го товара в корзине,
  // единичная остаётся regular. Здесь это страховка: даже если сеть отдаст
  // непустой промо-объект, в promoPrice такая скидка не попадёт (см. priceParts).
  const isMultibuy = raw.promo?.rebate?.units_to_activate != null;
  const product: ScrapedProduct = {
    canonicalId: `chizhik-${plu}`,
    storeId: 'chizhik',
    city: ctx.city,
    storeCode: ctx.externalStoreId,
    name,
    unit:
      String(raw.property_clarification ?? '').trim() ||
      String(raw.uom ?? '').trim() ||
      'шт',
    price,
    promoPrice: !isMultibuy && promoRaw !== null && promoRaw < price ? promoRaw : null,
    oldPrice: validOldPrice(oldRaw, price) ? oldRaw : null,
    url: chizhikProductUrl(plu),
    collectedAt: new Date().toISOString(),
    // Наличие отличаем от «неизвестно»: при дрейфе формата (у Ленты признак уже
    // уезжал в features.isBlockedForSale) утверждение «нет в наличии» записало бы
    // по всей сети волну «распродано» при живых ценах.
    ...(typeof raw.is_available === 'boolean' ? { inStock: raw.is_available } : {}),
  };
  const img = bestImage(raw.image_links ?? undefined) ?? bestImage(raw.media?.image_links ?? undefined);
  if (img) product.imageUrl = img;
  const unitPrice = pieceUnit(raw.price_piece_unit);
  if (unitPrice) product.unitPrice = unitPrice;
  return product;
}

/** Запросы для поиска товара по названию: полное имя и его укороченные префиксы. */
export function chizhikNameQueries(name: string): string[] {
  const full = name.trim();
  if (!full) return [];
  const out = [full];
  for (const cut of [40, 25]) {
    if (full.length > cut) out.push(full.slice(0, cut).trim());
  }
  return out;
}
