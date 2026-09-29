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
  noReleases?: boolean;
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

export interface RendererApi {
  ping: () => Promise<string>;
  getVersion: () => Promise<string>;
  getPrices: (args: PricesQuery) => Promise<StorePrices[]>;
  openExternal: (url: string) => Promise<boolean>;
  getCatalog: (args: { city?: string }) => Promise<StoreCatalog[]>;
  getCategory: (args: { city?: string; url?: string }) => Promise<StorePrices[]>;
  getOurCategories: (args: { city?: string }) => Promise<OurCategoryInfo[]>;
  getOurCategory: (args: { city?: string; id?: string }) => Promise<StorePrices[]>;
  getHistory: (args: { canonicalId: string; storeId: string; city: string }) => Promise<HistoryPoint[]>;
  getSchedulerStatus: () => Promise<SchedulerStatus>;
  runScheduler: () => Promise<SchedulerDone>;
  onSchedulerProgress: (cb: (done: number, total: number) => void) => () => void;
  onSchedulerDone: (cb: (done: SchedulerDone) => void) => () => void;
  checkUpdates: () => Promise<UpdateCheck>;
  installUpdate: () => Promise<void>;
  onUpdateEvent: (cb: (kind: string, payload: unknown) => void) => () => void;
}
