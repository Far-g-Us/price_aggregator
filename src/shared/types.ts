export type CityId = string; // 'moscow' на MVP, дальше — справочник

export interface Store {
  id: 'pyaterochka' | 'magnit' | 'lenta';
  name: string;
  city: CityId;
  // Идентификатор конкретного магазина в API сети:
  // 5ka -> sapCode, Магнит -> shopCode, Лента -> storeId
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
  fetchProduct(canonicalId: string, ctx: { city: CityId; externalStoreId: string }): Promise<ScrapedProduct>;
  fetchCategories?(ctx: { city: CityId; externalStoreId: string }): Promise<StoreCategory[]>;
  fetchCategoryProducts?(
    categoryUrl: string,
    ctx: { city: CityId; externalStoreId: string },
  ): Promise<ScrapedProduct[]>;
}

// Правило обновления: сеть опрашиваем (poll), а в БД пишем только если цена изменилась.
// Иначе историю раздует: polling обязателен, write-on-change — опция.
export interface RefreshPolicy {
  city: CityId;
  intervalHours: number;
  onlyFavorites: boolean;
}
