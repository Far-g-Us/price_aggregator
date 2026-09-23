import type { ScrapedProduct } from './types.js';

export interface PricesQuery {
  city?: string;
  query?: string;
}

export interface UpdateCheck {
  packaged: boolean;
  current: string;
  latest: string | null;
  available?: boolean;
  error?: string;
}

export interface StorePrices {
  storeId: string;
  name: string;
  ready: boolean;
  items: ScrapedProduct[];
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

export interface RendererApi {
  ping: () => Promise<string>;
  getVersion: () => Promise<string>;
  getPrices: (args: PricesQuery) => Promise<StorePrices[]>;
  getHistory: (args: { canonicalId: string; storeId: string; city: string }) => Promise<HistoryPoint[]>;
  getSchedulerStatus: () => Promise<SchedulerStatus>;
  runScheduler: () => Promise<SchedulerStatus>;
  checkUpdates: () => Promise<UpdateCheck>;
  installUpdate: () => Promise<void>;
  onUpdateEvent: (cb: (kind: string, payload: unknown) => void) => () => void;
}
