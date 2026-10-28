export type CityId = string; // 'moscow' на MVP, дальше — справочник

/**
 * Sentinel «точка неизвестна» в цене.
 *
 * Нужен для строк, где код точки восстановить нечем: например, товар, прочитанный
 * из кэша полки, где строки смешаны по всем точкам сети города. Подставлять туда
 * код из справочника нельзя — получится эхо конфига и ложная уверенность, а
 * как только в городе появится вторая точка, товар точки А пометится кодом
 * точки Б и это уедет в ключ цены.
 */
export const UNKNOWN_STORE_CODE = '?';

/**
 * Подходит ли отметка/раскладка к точке, которую сейчас смотрят.
 *
 * Перенесённые строки помечены `'?'` и относятся к ЛЮБОЙ точке этой сети в
 * городе — так и читает их база (`store_code = ? OR store_code = '?'`).
 * Правило живёт здесь, а не в интерфейсе, потому что его дублирование в
 * рендерере однажды привело к тому, что перенесённая отметка не зажигала
 * звёздочку: товар висел в «Избранном», а на полке выглядел неотмеченным.
 */
export function storeCodeMatches(marked: string, viewing: string): boolean {
  return marked === viewing || marked === UNKNOWN_STORE_CODE;
}

export interface Store {
  id: 'pyaterochka' | 'magnit' | 'lenta' | 'svetofor' | 'chizhik' | 'perekrestok';
  name: string;
  city: CityId;
  // Идентификатор конкретного магазина в API сети:
  // 5ka -> sapCode, Магнит -> shopCode, Лента -> storeId, Светофор -> shopid
  externalStoreId: string;
  address?: string;
}

export interface CanonicalProduct {
  id: string;
  name: string;
  brand?: string;
  unit: string; // '1л', '500г', 'шт'
  barcode?: string;
  imageUrl?: string; // одна главная картинка
  description?: string; // если есть на сайте
}

export interface PricePoint {
  canonicalId: string;
  storeId: Store['id'];
  city: CityId;
  /**
   * Код конкретной точки сети, часть идентичности цены. Обязателен, а не
   * опционален: проект собирается с `exactOptionalPropertyTypes`, и
   * опциональное поле позволило бы оболочке его не передать — ключ молча стал
   * бы пустым, то есть цена приклеилась бы не к той точке.
   *
   * Пока поле провожает код точки, о которой ПОПРОСИЛИ, из контекста в ответ.
   * Это ещё не код, который ОТДАЛА сеть: подтверждение (сверка ответа с
   * настроенной точкой) появляется на шаге 5 фазы 6, и расхождение там будет
   * громкой ошибкой без записи. База данных поле пока не использует.
   */
  storeCode: string;
  price: number;
  promoPrice?: number | null;
  oldPrice?: number | null; // зачёркнутая цена, если сеть отдаёт
  inStock?: boolean; // на своё усмотрение: наличие
  unitPrice?: string | null; // на своё усмотрение: "250 ₽/кг"
  url?: string; // ссылка на товар в магазине
  collectedAt: string; // ISO, дата замера -> история
}

// Полная карточка, которую отдаёт адаптер с сайта магазина
export interface ScrapedProduct extends PricePoint {
  name: string;
  brand?: string;
  unit?: string;
  barcode?: string;
  imageUrl?: string;
  description?: string;
}

// Контекст опроса одного товара. `name` — название из нашей БД: адаптерам, у
// которых нет карточки по id (Лента, api-gateway закрыт WAF), он нужен, чтобы
// найти товар поиском по названию. Необязательный: сетевой карточке по id он не
// нужен, и её поведение не меняется.
export interface ProductFetchContext {
  city: CityId;
  externalStoreId: string;
  name?: string;
}

// Адаптер под каждую сеть. Реализации: Playwright / fetch к скрытому API / Firecrawl / Apify
export interface StoreCategory {
  id: string;
  name: string;
  url: string;
  imageUrl?: string;
}

export interface StoreAdapter {
  readonly storeId: Store['id'];
  search(query: string, ctx: { city: CityId; externalStoreId: string }): Promise<ScrapedProduct[]>;
  fetchProduct(canonicalId: string, ctx: ProductFetchContext): Promise<ScrapedProduct>;
  fetchCategories?(ctx: { city: CityId; externalStoreId: string }): Promise<StoreCategory[]>;
  fetchCategoryProducts?(
    categoryUrl: string,
    ctx: { city: CityId; externalStoreId: string },
  ): Promise<ScrapedProduct[]>;
  /**
   * Отсеивает чужие ссылки на полки. Нужен, потому что один и тот же URL
   * раньше уходил ВСЕМ сетям города: клик по полке Пятёрки ронял Магнит
   * ошибкой «categoryUrl вне каталога». Кто умеет `fetchCategoryProducts`, но
   * не узнаёт ссылку — считается претендентом только на свои.
   */
  canHandleCategoryUrl?(categoryUrl: string): boolean;
}

// Правило обновления: сеть опрашиваем (poll), а в БД пишем только если цена изменилась.
// Иначе историю раздует: polling обязателен, write-on-change — опция.
export interface RefreshPolicy {
  city: CityId;
  intervalHours: number;
  onlyFavorites: boolean;
}
