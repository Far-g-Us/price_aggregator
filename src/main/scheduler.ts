import type { Database } from 'sql.js';
import log from 'electron-log';
import type { StoreAdapter } from '../shared/types.js';
import { CITY_STORES } from '../shared/catalog.js';
import {
  listTrackedProducts,
  persistDb,
  savePriceIfChanged,
  toPriceInput,
} from './db/db.js';

export interface PollCounts {
  inserted: number;
  skipped: number;
  failed: number;
  notReady: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollOnce(
  database: Database,
  adapters: Map<string, StoreAdapter>,
  delayMs = 2000,
  onProgress?: (done: number, total: number) => void,
): Promise<PollCounts> {
  const counts: PollCounts = { inserted: 0, skipped: 0, failed: 0, notReady: 0 };
  const targets = listTrackedProducts(database);
  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i];
    if (!t) continue;
    const store = CITY_STORES[t.city]?.find((s) => s.storeId === t.storeId);
    const adapter = adapters.get(t.storeId);
    if (!store?.ready || !adapter) {
      counts.notReady += 1;
      if (onProgress) onProgress(i + 1, targets.length);
      continue;
    }
    try {
      const p = await adapter.fetchProduct(t.canonicalId, {
        city: t.city,
        externalStoreId: store.externalStoreId,
      });
      const r = savePriceIfChanged(database, {
        ...toPriceInput(p),
        canonicalId: t.canonicalId,
        storeId: t.storeId,
        city: t.city,
      });
      counts[r === 'inserted' ? 'inserted' : 'skipped'] += 1;
    } catch (err) {
      log.error('poll item failed', t.storeId, t.canonicalId, err);
      counts.failed += 1;
    }
    if (onProgress) onProgress(i + 1, targets.length);
    if (i < targets.length - 1) await sleep(delayMs);
  }
  try {
    persistDb(database);
  } catch {
    counts.failed += 1;
  }
  return counts;
}
