import type { Database } from 'sql.js';
import type { StoreAdapter } from '../shared/types.js';
import { CITY_STORES } from '../shared/catalog.js';
import { consoleLogger, type CoreLogger } from './platform.js';
import { isProductLookupError } from './adapter-errors.js';
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
  /** Сети, где что-то отвалилось: «ошибок 1» без имени сети бесполезно. */
  failedStores: string[];
}

export interface PollOptions {
  /** Пауза между товарами: сеть враждебная, без пауз получишь блок. */
  delayMs?: number;
  onProgress?: (done: number, total: number) => void;
  log?: CoreLogger;
  /**
   * Опрашивать только этот город. Опрос без фильтра бьёт по всем городам сразу,
   * а цены и наличие привязаны к магазину конкретного города: пользователь,
   * который смотрит Ульяновск, не запрашивал Москву. Пусто или undefined — все
   * города (прежнее поведение, нужно ручному запуску из консоли).
   */
  city?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollOnce(
    database: Database,
    adapters: Map<string, StoreAdapter>,
    options: PollOptions = {},
  ): Promise<PollCounts> {
    const { delayMs = 1000, onProgress, log = consoleLogger, city } = options;
    const counts: PollCounts = { inserted: 0, skipped: 0, failed: 0, notReady: 0, failedStores: [] };
    // Фильтр по городу ДО счётчика total: иначе прогресс «3 из 76» обещает
    // обход всей базы, а проходим мы 15 позиций своего города.
    const targets = listTrackedProducts(database).filter((t) => !city || t.city === city);
    if (targets.length === 0) {
      log.info(`опрос: нет отслеживаемых товаров${city ? ` в городе ${city}` : ''}`);
      return counts;
    }
    const startedAt = Date.now();
    // Сеть, которая только что упала по таймауту, почти наверняка упадёт и
    // снова: у Пятёрки это значит ещё 60 секунд на КАЖДЫЙ оставшийся товар, и
    // опрос на 76 позиций не заканчивается никогда. После двух отказов подряд
    // сеть выбывает, но НЕ навсегда: через RETRY_COOLDOWN_MS её пробуют снова,
    // потому что сеть могла отдохнуть (капча, кратковременный 429, смена IP).
    // Следующий плановый опрос стартует с чистого листа в любом случае.
    const STRIKE_LIMIT = 2;
    const RETRY_COOLDOWN_MS = 120_000;
    const strikes = new Map<string, number>();
    const disabledUntil = new Map<string, number>();
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
      const blockedUntil = disabledUntil.get(t.storeId) ?? 0;
      if (blockedUntil > Date.now()) {
        counts.notReady += 1;
        if (onProgress) onProgress(i + 1, targets.length);
        continue;
      }
      const itemStart = Date.now();
      try {
        const p = await adapter.fetchProduct(t.canonicalId, {          city: t.city,
          externalStoreId: store.externalStoreId,
          name: t.name,
        });
        const r = savePriceIfChanged(database, {
          ...toPriceInput(p),
          canonicalId: t.canonicalId,
          storeId: t.storeId,
          city: t.city,
        });
        counts[r === 'inserted' ? 'inserted' : 'skipped'] += 1;
        strikes.set(t.storeId, 0);
        if (itemStart > 0 && Date.now() - itemStart > 10_000) {
          log.info(`опрос: ${t.storeId} ${t.canonicalId} ${Date.now() - itemStart}мс`);
        }
      } catch (err) {
        // «Товар не найден» — не отказ сети: сеть ответила, просто товара нет.
        // Считаем его в failed (пользователь должен видеть), но strikes не
        // растим, иначе два переименованных товара выключат магазин целиком.
        if (isProductLookupError(err)) {
          counts.failed += 1;
          if (!counts.failedStores.includes(t.storeId)) counts.failedStores.push(t.storeId);
          log.warn(`poll: ${t.storeId} ${t.canonicalId} — ${err.message}`);
          if (onProgress) onProgress(i + 1, targets.length);
          if (i < targets.length - 1) await sleep(delayMs);
          continue;
        }
        const fails = (strikes.get(t.storeId) ?? 0) + 1;
        strikes.set(t.storeId, fails);
        log.error(
          `poll item failed ${t.storeId} ${t.canonicalId} за ${Date.now() - itemStart}мс (${fails}-й подряд)`,
          err,
        );
        counts.failed += 1;
        if (!counts.failedStores.includes(t.storeId)) counts.failedStores.push(t.storeId);
        if (fails >= STRIKE_LIMIT) {
          disabledUntil.set(t.storeId, Date.now() + RETRY_COOLDOWN_MS);
          log.warn(
            `опрос: ${t.storeId} поставлена на паузу на ${Math.round(RETRY_COOLDOWN_MS / 1000)}с после ` +
              `${fails} отказов подряд — её товары до конца паузы остаются без проверки`,
          );
        }
      }
      if (onProgress) onProgress(i + 1, targets.length);
      if (i < targets.length - 1) await sleep(delayMs);
    }
  try {
    persistDb(database);
  } catch (err) {
    // Молча терять запись нельзя: цены останутся только в памяти и исчезнут
    // при выходе. Считаем провалом опроса и пишем в лог.
      log.error('poll persist failed', err);
      counts.failed += 1;
      if (!counts.failedStores.includes('база данных')) counts.failedStores.push('база данных');
    }
    log.info(
      `опрос: ${targets.length} товаров за ${Math.round((Date.now() - startedAt) / 1000)}с — ` +
        `добавлено ${counts.inserted}, без изменений ${counts.skipped}, ошибок ${counts.failed}, не проверено ${counts.notReady}` +
        (counts.failedStores.length ? `; с ошибками: ${counts.failedStores.join(', ')}` : ''),
    );
    return counts;
  }
