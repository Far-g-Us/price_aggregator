import type { ScrapedProduct } from './types.js';
import type { StoreCategory } from './types.js';

export interface PricesQuery {
  city?: string;
  query?: string;
}

export interface UpdateCheck {
  packaged: boolean;
  current: string;
  latest: string | null;
  available?: boolean;
  /** Portable не обновляется сам: только уведомление, ничего не скачивается. */
  portable?: boolean;
  error?: string;
}

export interface StorePrices {
  storeId: string;
  name: string;
  ready: boolean;
  items: ScrapedProduct[];
  error?: string;
  /** Данные из локального кэша, а не из живой сети. */
  cached?: boolean;
}

export interface StoreCatalog {
  storeId: string;
  name: string;
  categories: StoreCategory[];
  error?: string;
}
export interface HistoryPoint {
  price: number;
  promo_price: number | null;
  old_price: number | null;
  in_stock: number;
  collected_at: string;
}

export interface SchedulerStatus {
  running: boolean;
  lastRun: string | null;
  counts: { inserted: number; skipped: number; failed: number; notReady: number };
  intervalHours: number;
}

export interface SchedulerDone {
  status: SchedulerStatus;
  summary: string;
}

export interface OurCategoryInfo {
  id: string;
  name: string;
  parentId: string | null;
  queryCount: number;
  storeCount: number;
  /** Виртуальная категория: товары, не попавшие ни в одну нашу. */
  virtual?: boolean;
}

/** Ручная раскладка товара: на каких наших полках он лежит. */
export interface ProductShelves {
  categoryIds: string[];
  manual: boolean;
}

/**
 * Отметка «избранное» на конкретное предложение (товар + магазин + город).
 * targetPrice — порог уведомления; null означает просто отметку без порога.
 */
export interface Favorite {
  canonicalId: string;
  storeId: string;
  city: string;
  name: string;
  price: number | null;
  targetPrice: number | null;
}

/** Аргумент «это разные товары»: пара id, которые нельзя склеивать. */
export interface SplitPair {
  canonicalIdA: string;
  canonicalIdB: string;
}

export interface ShelfScope {
  canonicalId: string;
  storeId: string;
  city: string;
}

// Канал разрыва склейки нужен и в API: renderer спрашивает у ядра, какие пары
// разведены, иначе отметка «разные товары» жила бы только в БД и карточка
// продолжала бы собираться из двух товаров до перезапуска.
export interface RendererApi {
  ping: () => Promise<string>;
  getVersion: () => Promise<string>;
  getPrices: (args: PricesQuery) => Promise<StorePrices[]>;
  openExternal: (url: string) => Promise<boolean>;
  getCatalog: (args: { city?: string }) => Promise<StoreCatalog[]>;
  getCategory: (args: { city?: string; url?: string }) => Promise<StorePrices[]>;
  getOurCategories: (args: { city?: string }) => Promise<OurCategoryInfo[]>;
  getOurCategory: (args: { city?: string; id?: string }) => Promise<StorePrices[]>;
  getShelves: (args: ShelfScope) => Promise<ProductShelves>;
  setShelves: (args: ShelfScope & { categoryIds: string[] }) => Promise<ProductShelves>;
  releaseShelves: (args: ShelfScope) => Promise<ProductShelves>;
  getHistory: (args: { canonicalId: string; storeId: string; city: string }) => Promise<HistoryPoint[]>;
  /** Избранное города: текущая цена каждой отмеченной точки. */
  getFavorites: (args: { city: string }) => Promise<Favorite[]>;
  /** Отметить или снять; targetPrice = null оставляет прежний порог. */
  setFavorite: (args: ShelfScope & { targetPrice: number | null }) => Promise<Favorite[]>;
  removeFavorite: (args: ShelfScope) => Promise<Favorite[]>;
  /**
   * Пометить пару как разные товары. Без города: canonicalId несёт префикс
   * сети (5ka-/magnit-/lenta-), товар не city-scoped, и «это разные товары»
   * по смыслу одно правило для всех городов. Раньше город был в сигнатуре,
   но игнорировался в ядре и в main — мёртвый параметр на трёх слоях.
   */
  splitProducts: (args: SplitPair) => Promise<void>;
  removeSplit: (args: SplitPair) => Promise<void>;
  /**
   * Ручные разрывы склейки готовыми ключами matchSplitKey: renderer отдаёт их в
   * groupByProduct. Разрыв — отрицательное правило об идентичности двух SKU,
   * поэтому он общий для всех городов, а параметр `city` на выборку не влияет.
   * Async по существу, а не по оформлению — useMemo синхронный, поэтому
   * прочитать их иначе нечем.
   */
  getSplitPairs: (args: { city: string }) => Promise<string[]>;
  getSchedulerStatus: () => Promise<SchedulerStatus>;
  runScheduler: (args?: { city?: string }) => Promise<SchedulerDone>;
  /** Сообщить ядру выбранный город: автоопрос бьёт только по нему. */
  setCurrentCity: (city: string) => Promise<void>;
  onSchedulerProgress: (cb: (done: number, total: number) => void) => () => void;
  onSchedulerDone: (cb: (done: SchedulerDone) => void) => () => void;
  checkUpdates: () => Promise<UpdateCheck>;
  installUpdate: () => Promise<void>;
  onUpdateEvent: (cb: (kind: string, payload: unknown) => void) => () => void;
}
