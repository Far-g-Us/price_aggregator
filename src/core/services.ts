// Ядро приложения: вся бизнес-логика, без Electron и без node:fs.
// Оболочка (electron/main.ts, позже Capacitor) только реализует порты из
// ./platform.ts, регистрирует IPC и рисует окно. Благодаря этому ядро
// запускается под обычным node в тестах и переносится в другую оболочку без
// дублирования кода.
//
// Ничего не знает про `app.getPath`, `fs`, `Notification`, `setInterval` и
// про то, кто его вызывает.
import type { Database } from 'sql.js';
import type {
  Favorite,
  HistoryPoint,
  OurCategoryInfo,
  PricesQuery,
  ProductShelves,
  ShelfScope,
  SplitPair,
  StoreCatalog,
  StorePrices,
} from '../shared/api.js';
import type { ScrapedProduct, StoreAdapter, StoreCategory } from '../shared/types.js';
import { CITY_STORES } from '../shared/catalog.js';
import { formatPrice } from '../shared/format.js';
import {
  OUR_CATEGORIES,
  classifyOurCategories,
  matchesOurCategory,
  ourCategoryById,
} from '../shared/taxonomy.js';
import {
  getLastRun,
  getPriceHistory,
  getProductShelves,
  listCategoryProducts,
  latestPrices,
  listFavorites,
  listFavoritesAll,
  listTrackedProducts,
  listUnassignedProducts,
  manualShelfIds,
  openDb,
  persistDb,
  releaseProductShelves,
  removeFavorite as removeFavoriteDb,
  removeSplit as removeSplitDb,
  saveFavorite,
  saveLastRun,
  saveNotifiedPrices,
  savePriceIfChanged,
  saveProductCategory,
  saveSplit,
  setProductShelves,
  splitPairsFor,
  toPriceInput,
  type CachedCategoryRow,
} from './db/db.js';
import { pollOnce, type PollCounts } from './scheduler.js';
import type { CoreDeps } from './platform.js';

const CATALOG_TTL_MS = 7 * 24 * 3600 * 1000;
// Сети, чей каталог живёт за браузером, меняют его часто — день вместо недели.
const BROWSER_CATALOG_TTL_MS = 24 * 3600 * 1000;
const OUR_QUERY_PAUSE_MS = 1200;
const OUR_MAX_PER_QUERY = 12;
const OUR_MAX_PER_CATEGORY = 150;
export const UNASSIGNED_ID = '__unassigned__';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SchedulerState {
  running: boolean;
  lastRun: string | null;
  counts: PollCounts;
  intervalHours: number;
}

export interface Core {
  searchPrices(args?: PricesQuery): Promise<StorePrices[]>;
  getCatalogs(args?: { city?: string }): Promise<StoreCatalog[]>;
  getCategoryProducts(args?: { city?: string; url?: string }): Promise<StorePrices[]>;
  getOurCategories(args?: { city?: string }): OurCategoryInfo[];
  getOurCategory(args?: { city?: string; id?: string }): Promise<StorePrices[]>;
  getHistory(args?: { canonicalId?: string; storeId?: string; city?: string }): Promise<HistoryPoint[]>;
  /** Полки товара и признак ручной раскладки. */
  getShelves(args: ShelfScope): Promise<ProductShelves>;
  /** Избранное города с текущей ценой каждой отмеченной точки. */
  getFavorites(args: { city: string }): Promise<Favorite[]>;
  /** Город, выбранный в интерфейсе: автоопрос бьёт только по нему. */
  setCurrentCity(city: string): void;
  /**
   * Избранное с достигнутым порогом. Вызывается после опроса: сеть ответила,
   * цена упала — пора сообщить. Возвращает только те отметки, где порог есть
   // и текущая цена строго ниже него.
   */
  checkTargets(city?: string): Promise<{ canonicalId: string; storeId: string; city: string; name: string; price: number; target: number }[]>;
  /** Пометить цены как уведомлённые: ими пользуется опрос и тесты ядра. */
  markNotifiedForTest(rows: { canonicalId: string; storeId: string; city: string; price: number }[]): Promise<void>;
  setFavorite(args: ShelfScope & { targetPrice: number | null }): Promise<Favorite[]>;
  removeFavorite(args: ShelfScope): Promise<Favorite[]>;
  /** Ручной разрыв склейки: пара id, которые нельзя считать одним товаром. */
  splitProducts(args: SplitPair): Promise<void>;
  removeSplit(args: SplitPair): Promise<void>;
  /**
   * Ключи пар, которые renderer не должен склеивать в один товар. Разрыв — это
   * отрицательное правило об идентичности двух SKU, а не свойство витрины: он
   * действует во всех городах, поэтому параметр `city` тут для симметрии с
   * остальными city-запросами и на выборку не влияет.
   */
  getSplitPairs(args: { city: string }): Promise<string[]>;
  /** Перезаписать полки товара; пустой список = «убрать со всех полок». */
  setShelves(args: ShelfScope & { categoryIds: string[] }): Promise<ProductShelves>;
  /** Вернуть товар под управление автораскладки. */
  releaseShelves(args: ShelfScope): Promise<ProductShelves>;
  schedulerStatus(): SchedulerState;
  runScheduler(args?: { city?: string }): Promise<{ status: SchedulerState; summary: string }>;
  /** Запуск фоновых таймеров. Вызывает оболочка, когда приложение готово. */
  startScheduler(): void;
  saveAll(): void;
}

/**
 * Прогресс опроса коалесцируется: событие уходит не чаще раза в minGapMs, но
 * последнее состояние уходит обязательно (flush).
 *
 * Зачем: ветки пропуска в scheduler зовут onProgress БЕЗ паузы — когда сеть
 * встаёт на паузу breaker'а, все её оставшиеся товары пролетают за
 * миллисекунды, и renderer получает пачку сообщений подряд. На пачке
 * Electron писал [Violation] 'message' handler took 521ms.
 *
 * Штатный темп (пауза 1с между живыми товарами) от этого правила не страдает:
 * там и без него событий не чаще одного в секунду.
 */
export function progressEmitter(
  emit: (channel: string, payload: unknown) => void,
  minGapMs = 250,
): { onProgress: (done: number, total: number) => void; flush: () => void } {
  // Монотонные часы: Date.now() прыгает назад при переводе времени или правке
  // часов, разность с lastAt становится отрицательной, и до выравнивания
  // прогресс глух — счётчик прыгал с «12/237» сразу на «237/237».
  // performance.now() от этого свободен.
  const monotonic = (): number => performance.now();
  let lastAt = Number.NEGATIVE_INFINITY;
  let last: { done: number; total: number } | null = null;
  return {
    onProgress: (done, total) => {
      last = { done, total };
      const now = monotonic();
      if (now - lastAt < minGapMs) return;
      lastAt = now;
      emit('scheduler:progress', last);
    },
    flush: () => {
      // last обнуляется: повторный flush не должен слать то же самое ещё раз.
      const pending = last;
      if (!pending) return;
      last = null;
      lastAt = monotonic();
      emit('scheduler:progress', pending);
    },
  };
}

export function createCore(deps: CoreDeps): Core {
  const { storage, json, shell, background, log, adapters } = deps;
  const emit = deps.emit ?? (() => {});

  const SHELF_CACHE_TTL_MS = 3 * 60 * 1000;
  // Кэш полки в памяти. Каждое открытие бьётся в сети заново: восемь запросов
  // на три сети, а Пятёрка через браузер — около 5 секунд на запрос. При
  // возвращении «назад → та же полка» повторный обход сети смысла не имеет, а
  // цены за три минуты не уезжают. История всё равно пишется по изменению.
  const shelfCache = new Map<string, { at: number; value: StorePrices[] }>();

  // Провал открытия БД не должен оставаться только в логе: цены на экране
  // есть, а в истории пусто — пользователь должен видеть почему.
  const DB_ERROR_SUFFIX = 'цены показаны, но в историю не записаны: база недоступна';

  const openDatabase = async (): Promise<{ database: Database | null; error?: string }> => {
    try {
      return { database: await openDb(storage) };
    } catch (err) {
      log.error('db open failed', err);
      return { database: null, error: `${DB_ERROR_SUFFIX} (${String(err).slice(0, 80)})` };
    }
  };

  // Кэш витринных категорий: сеть отвечает медленно и часто, а список меняется
  // раз в месяц. TTL и валидация формы — здесь, в ядре; оболочка только
  // умеет прочитать и записать строку.
  const catalogFile = (city: string, storeId: string, externalStoreId: string): string => {
    const safe = externalStoreId.replace(/[^A-Za-z0-9_-]/g, '_');
    return `catalog-${city}-${storeId}-${safe}.json`;
  };

  const readCatalogCache = (
    city: string,
    storeId: string,
    externalStoreId: string,
    ignoreTtl = false,
  ): StoreCategory[] | null => {
    try {
      const rawText = json.read(catalogFile(city, storeId, externalStoreId));
      if (rawText == null) return null;
      const raw = JSON.parse(rawText) as { at: number; categories: unknown };
      // Сеть на скрытом API перестраивает каталог (у Пятёрки id — hex, он
      // меняется при перестройке). Недельный кэш держал бы мёртвые ссылки и
      // «вернись и открой заново» не помогало бы: витрина осталась бы прежней.
      // Поэтому для таких сетей срок — сутки.
      const ttl = storeId === 'pyaterochka' ? BROWSER_CATALOG_TTL_MS : CATALOG_TTL_MS;
      if (!ignoreTtl && Date.now() - raw.at > ttl) return null;
      if (!Array.isArray(raw.categories)) return null;
      return raw.categories.filter(
        (c): c is StoreCategory =>
          typeof c === 'object' &&
          c !== null &&
          typeof (c as StoreCategory).id === 'string' &&
          typeof (c as StoreCategory).name === 'string' &&
          typeof (c as StoreCategory).url === 'string',
      );
    } catch (err) {
      log.warn('catalog cache unreadable', city, storeId, String(err).slice(0, 120));
      return null;
    }
  };

  const writeCatalogCache = (
    city: string,
    storeId: string,
    externalStoreId: string,
    categories: StoreCategory[],
  ): void => {
    // Витрину без картинок в кэш не кладём (30.09, Магнит 303857: сеть один раз
    // отдала 40 категорий без картинок, и недельной TTL закрепил пустые плитки на
    // семь суток). Лучше лишний раз сходить в сеть, чем неделями показывать
    // пустые плитки, которые нечем перезапросить.
    if (!categories.some((c) => c.imageUrl)) {
      log.warn('catalog cache skipped: сеть отдала витрину без картинок', city, storeId, categories.length);
      return;
    }
    try {
      json.write(catalogFile(city, storeId, externalStoreId), JSON.stringify({ at: Date.now(), categories }));
    } catch (err) {
      log.error('catalog cache write failed', city, storeId, err);
    }
  };

  // Запись цен по сети. Ошибка по одному товару не должна ронять остальные.
  // storeId и city берём ОТ СЕТИ, которую опрашивали, а не из ответа адаптера:
  // ключ истории (canonicalId, storeId, city) не должен зависеть от того, что
  // вернул сайт, иначе цена и раскладка разъедутся по разным store_id.
  // Возвращает id, которые реально записались (по ним раскладываем товар).
  const storeItems = async (
    database: Database | null,
    storeId: string,
    city: string,
    items: ScrapedProduct[],
  ): Promise<Set<string>> => {
    const saved = new Set<string>();
    if (!database) return saved;
    for (const item of items) {
      try {
        savePriceIfChanged(database, { ...toPriceInput(item), storeId, city });
        saved.add(item.canonicalId);
      } catch (err) {
        log.error('db item skipped', item.canonicalId, err);
      }
    }
    return saved;
  };

  // Раскладывает полученные товары по НАШИМ категориям (many-to-many) —
  // независимо от того, откуда они пришли: поиск, витринная категория или
  // наша. Так «Не разложено» показывает ровно то, что мимо всех полок.
  // Пишем только по реально записанным id: иначе FK на несуществующий товар
  // откатит транзакцию и потеряет раскладку всей пачки.
  // Товары под ручным управлением (product_category_manual) пропускаем: раз
  // пользователь разложил товар сам, автораскладка не должна ни добавлять, ни
  // убирать у него полки. Маркеры читаем одним запросом на магазин, а не по
  // товару — иначе на полку уходит лишняя сотня prepare/step.
  const classifyAndSave = (
    database: Database | null,
    storeId: string,
    city: string,
    items: ScrapedProduct[],
    saved?: Set<string>,
  ): void => {
    if (!database) return;
    const manual = manualShelfIds(database, storeId, city);
    const rows = items.flatMap((i) =>
      (saved && !saved.has(i.canonicalId) ? [] : manual.has(i.canonicalId) ? [] : classifyOurCategories(i.name)).map(
        (categoryId) => ({
          canonicalId: i.canonicalId,
          storeId,
          city,
          categoryId,
        }),
      ),
    );
    if (rows.length === 0) return;
    /* c8 ignore start — catch недостижим не из-за INSERT OR IGNORE (нарушение
       внешнего ключа он как раз пропускает), а потому что все значения уже
       проверены: categoryId взят из OUR_CATEGORIES, city — из CITY_STORES,
       canonicalId — из saved, то есть из товаров, которые только что успешно
       записаны в products. */
    try {
      saveProductCategory(database, rows);
    } catch (err) {
      log.error('auto classify failed', storeId, String(err).slice(0, 120));
    }
    /* c8 ignore stop */
  };

  // Кэш из БД в тот же формат, что отдаёт живой сбор. Имя полки передаётся
  // отдельно: строки уже отфильтрованы по сети, искать её имя в справочнике
  // по storeId было бы подстановкой на случай, которого не бывает.
  const cachedToStorePrices = (
    rows: CachedCategoryRow[],
    city: string,
    storeName: string,
  ): StorePrices[] => {
    const byStore = new Map<StorePrices['storeId'], ScrapedProduct[]>();
    for (const r of rows) {
      const product: ScrapedProduct = {
        canonicalId: r.canonicalId,
        storeId: r.storeId,
        city,
        name: r.name,
        price: r.price,
        promoPrice: r.promoPrice,
        oldPrice: r.oldPrice,
        inStock: r.inStock,
        collectedAt: r.collectedAt,
      };
      if (r.imageUrl) product.imageUrl = r.imageUrl;
      if (r.unit) product.unit = r.unit;
      if (r.brand) product.brand = r.brand;
      if (r.url) product.url = r.url;
      // Цена за единицу: без неё полки из базы показывали товар дешевле, чем он
      // стоит на самом деле (250 ₽/кг выглядит как 250 ₽ за упаковку).
      if (r.unitPrice) product.unitPrice = r.unitPrice;
      const list = byStore.get(r.storeId) ?? [];
      list.push(product);
      byStore.set(r.storeId, list);
    }
    return [...byStore.entries()].map(([storeId, items]) => ({
      storeId,
      name: storeName,
      ready: true,
      items,
    }));
  };

  const saveAll = (): void => {
    try {
      persistDb();
    } catch (err) {
      log.error('persist failed', err);
    }
  };

  const searchPrices = async (args?: PricesQuery): Promise<StorePrices[]> => {
    const city = args?.city ?? 'moscow';
    shelfCache.clear();
    const query = args?.query?.trim() ?? '';
    if (!query) return [];
    const stores = CITY_STORES[city] ?? [];
    const out: StorePrices[] = [];
    const { database, error: dbError } = await openDatabase();
    for (const s of stores) {
      if (!s.ready) {
        out.push({ storeId: s.storeId, name: s.name, ready: false, items: [] });
        continue;
      }
      const adapter = adapters.get(s.storeId);
      if (!adapter) {
        out.push({ storeId: s.storeId, name: s.name, ready: false, items: [], error: 'нет адаптера' });
        continue;
      }
      try {
        const items = await adapter.search(query, { city, externalStoreId: s.externalStoreId });
        const saved = await storeItems(database, s.storeId, city, items);
        classifyAndSave(database, s.storeId, city, items, saved);
        out.push({ storeId: s.storeId, name: s.name, ready: true, items });
      } catch (err) {
        log.error('search failed', s.storeId, err);
        out.push({ storeId: s.storeId, name: s.name, ready: true, items: [], error: String(err) });
      }
    }
    if (dbError) for (const entry of out) entry.error = entry.error ?? dbError;
    saveAll();
    return out;
  };

  const getCatalogs = async (args?: { city?: string }): Promise<StoreCatalog[]> => {
    const city = args?.city ?? 'moscow';
    const stores = CITY_STORES[city] ?? [];
    const out: StoreCatalog[] = [];
    for (const s of stores) {
      const adapter = adapters.get(s.storeId);
      if (!s.ready || !adapter || typeof adapter.fetchCategories !== 'function') {
        out.push({ storeId: s.storeId, name: s.name, categories: [] });
        continue;
      }
      try {
        // Пустой кэш — это промах, а не попадание: иначе разъехавшаяся форма
        // (сеть переименовала url) заблокирует сеть на весь TTL в 7 суток.
        const cached = readCatalogCache(city, s.storeId, s.externalStoreId);
        if (cached && cached.length > 0) {
          out.push({ storeId: s.storeId, name: s.name, categories: cached });
          continue;
        }
        const categories = await adapter.fetchCategories({ city, externalStoreId: s.externalStoreId });
        writeCatalogCache(city, s.storeId, s.externalStoreId, categories);
        out.push({ storeId: s.storeId, name: s.name, categories });
      } catch (err) {
        log.error('catalog failed', s.storeId, err);
        // Сеть молчит — отдаём протухший кэш, но не выдумываем: без кэша
        // категория просто недоступна и это видно в error.
        const stale = readCatalogCache(city, s.storeId, s.externalStoreId, true);
        if (stale && stale.length > 0) out.push({ storeId: s.storeId, name: s.name, categories: stale });
        else out.push({ storeId: s.storeId, name: s.name, categories: [], error: String(err) });
      }
    }
    return out;
  };

  const getCategoryProducts = async (args?: { city?: string; url?: string }): Promise<StorePrices[]> => {
    const city = args?.city ?? 'moscow';
    if (!args?.url) return [];
    const stores = CITY_STORES[city] ?? [];
    const out: StorePrices[] = [];
    const { database, error: dbError } = await openDatabase();
    // Ссылка на полку принадлежит ОДНОЙ сети. Раньше она уходила всем
    // готовым сетям города, и клик по полке Пятёрки ронял Магнит ошибкой
    // «categoryUrl вне каталога». Теперь претендента выбирает сам адаптер.
    const url = args.url;
    const ready = stores
      .map((s) => ({ s, adapter: adapters.get(s.storeId) }))
      .filter((x): x is { s: (typeof stores)[number]; adapter: NonNullable<ReturnType<typeof adapters.get>> } =>
        Boolean(x.s.ready && x.adapter),
      );
    const candidates = ready.filter((x) =>
      typeof x.adapter!.canHandleCategoryUrl === 'function'
        ? x.adapter!.canHandleCategoryUrl(url)
        : typeof x.adapter!.fetchCategoryProducts === 'function',
    );
    if (candidates.length === 0) {
      return [{
        storeId: stores[0]?.storeId ?? 'magnit',
        name: stores[0]?.name ?? 'Полка',
        ready: false,
        items: [],
        error: 'ссылка на полку не принадлежит ни одной сети этого города — вернись к категориям и открой полку заново',
      }];
    }
    for (const { s, adapter } of candidates) {
      if (typeof adapter!.fetchCategoryProducts !== 'function') {
        out.push({ storeId: s.storeId, name: s.name, ready: false, items: [] });
        continue;
      }
      try {
        const items = await adapter!.fetchCategoryProducts(url, {
          city,
          externalStoreId: s.externalStoreId,
        });
        const saved = await storeItems(database, s.storeId, city, items);
        classifyAndSave(database, s.storeId, city, items, saved);
        out.push({ storeId: s.storeId, name: s.name, ready: true, items });
      } catch (err) {
        log.error('category failed', s.storeId, err);
        out.push({ storeId: s.storeId, name: s.name, ready: true, items: [], error: String(err) });
      }
    }
    if (dbError) for (const entry of out) entry.error = entry.error ?? dbError;
    saveAll();
    return out;
  };

  const getOurCategories = (args?: { city?: string }): OurCategoryInfo[] => {
    const city = args?.city ?? 'moscow';
    const stores = CITY_STORES[city] ?? [];
    const readyStores = stores.filter((s) => s.ready && adapters.has(s.storeId)).length;
    const out: OurCategoryInfo[] = OUR_CATEGORIES.map((c) => ({
      id: c.id,
      name: c.name,
      parentId: c.parentId,
      queryCount: c.queries.length,
      storeCount: readyStores,
    }));
    out.push({
      id: UNASSIGNED_ID,
      name: 'Не разложено',
      parentId: null,
      queryCount: 0,
      storeCount: readyStores,
      virtual: true,
    });
    return out;
  };

  const getOurCategory = async (args?: { city?: string; id?: string }): Promise<StorePrices[]> => {
    const city = args?.city ?? 'moscow';
    const categoryId = args?.id ?? '';
    const cacheKey = `${city}:${categoryId}`;
    const cached = shelfCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SHELF_CACHE_TTL_MS) {
      log.info(`полка «${categoryId}» ${city}: из кэша (${Math.round((Date.now() - cached.at) / 1000)}с назад)`);
      return cached.value;
    }
    const category = categoryId === UNASSIGNED_ID ? undefined : ourCategoryById(categoryId);
    if (!category && categoryId !== UNASSIGNED_ID) throw new Error('ourcategory:get: неизвестная категория');
    const stores = CITY_STORES[city] ?? [];
    const { database, error: dbError } = await openDatabase();
    const startedAt = Date.now();
    // Магазины идут ПАРАЛЛЕЛЬНО: они ходят на разные домены, общий rate-limit
    // у них один только внутри сети. По очереди полка «Молочное и яйца» (8
    // запросов) ждала паузу трижды на каждый магазин — минуты на пустом месте.
    // Внутри одного магазила порядок запросов и пауза сохраняются.
    const perStore = await Promise.all(
      stores.map(async (s): Promise<StorePrices> => {
        const adapter = adapters.get(s.storeId);
        if (!s.ready || !adapter) {
          return { storeId: s.storeId, name: s.name, ready: false, items: [] };
        }
        const byId = new Map<string, ScrapedProduct>();
        const errors: string[] = [];
        if (category) {
          // Предохранитель: Пятёрка ходит через браузер, и её таймаут — 60 секунд
          // на запрос. Восемь запросов подряд дают 8 минут ожидания на одну
          // полку, причём сеть после первого отказа почти наверняка откажет и
          // дальше. Два отказа подряд — и сеть выбывает до конца открытия полки,
          // а её товары показываются из кэша с честной пометкой.
          let strikes = 0;
          const STRIKE_LIMIT = 2;
          for (const query of category.queries) {
            // Пауза между запросами: сеть враждебная, а запросов на категорию
            // до восьми на магазин (иначе один клик = шторм).
            if (byId.size > 0) await sleep(OUR_QUERY_PAUSE_MS);
            const qStart = Date.now();
            try {
              const found = await adapter.search(query, { city, externalStoreId: s.externalStoreId });
              for (const item of found.slice(0, OUR_MAX_PER_QUERY)) {
                // Слова из названия решают, попадает ли товар в нашу полку:
                // без этого в «Молоко» попадали коктейли молочные.
                if (!matchesOurCategory(category, item.name)) continue;
                const prev = byId.get(item.canonicalId);
                if (!prev || item.collectedAt > prev.collectedAt) byId.set(item.canonicalId, item);
              }
              strikes = 0;
              log.info(
                `полка «${category.name}» ${s.storeId}: запрос «${query}» ${Date.now() - qStart}мс, найдено ${found.length}`,
              );
            } catch (err) {
              strikes += 1;
              log.error(
                `ourcategory query failed ${s.storeId} «${query}» за ${Date.now() - qStart}мс (${strikes}-й подряд)`,
                String(err).slice(0, 200),
              );
              errors.push(`${query}: ${String(err).slice(0, 100)}`);
              if (strikes >= STRIKE_LIMIT) {
                const rest = category.queries.length - category.queries.indexOf(query) - 1;
                errors.push(`сеть не ответила ${strikes} раза подряд, остальные ${rest} запросов пропущены`);
                log.warn(
                  `полка «${category.name}» ${s.storeId}: ${s.name} выбыла после ${strikes} отказов, ` +
                    `пропущено запросов: ${rest}`,
                );
                break;
              }
            }
          }
        } else {
          // «Не разложено» в сеть не ходим — это про уже увиденные товары.
          if (!database) {
            // БД не открылась: молча пустая полка выглядела бы как «товаров
            // нет», поэтому говорим прямо.
            return {
              storeId: s.storeId,
              name: s.name,
              ready: false,
              items: [],
              // Базы нет — значит, openDatabase уже объяснил почему, и текст
              // ошибки здесь есть всегда.
              error: dbError!,
            };
          }
          const rows = listUnassignedProducts(database, { city }).filter((r) => r.storeId === s.storeId);
          const cached = cachedToStorePrices(rows, city, s.name);
          // Пусто здесь — не «товаров нет», а «ещё нечего показать»: полка читает
          // только локальную базу и в сеть не ходит, поэтому и в статусе полки
          // нельзя писать «опрошен» (это враньё читателю, который только что
          // увидел подпись «в сеть не ходит»). Флаг cached renderer показывает как
          // «из локальной базы».
          const shelf = cached[0] ?? { storeId: s.storeId, name: s.name, ready: true, items: [] };
          return { ...shelf, cached: true };
        }
        const items = [...byId.values()].slice(0, OUR_MAX_PER_CATEGORY);
        const saved = await storeItems(database, s.storeId, city, items);
        if (database && category) {
          try {
            // Товар под ручным управлением сюда не пишем: ручная раскладка
            // должна пережить открытие любой полки, иначе «убрать со всех полок»
            // отменилось бы само собой при первом же запросе.
            const manual = manualShelfIds(database, s.storeId, city);
            saveProductCategory(
              database,
              items
                .filter((i) => saved.has(i.canonicalId) && !manual.has(i.canonicalId))
                .map((i) => ({
                  canonicalId: i.canonicalId,
                  storeId: s.storeId,
                  city,
                  categoryId: category.id,
                })),
            );
            /* c8 ignore start — как и выше: вставка через INSERT OR IGNORE с
               проверенными значениями, внешний отказ здесь невозможен. */
          } catch (err) {
            log.error('product category write failed', category.id, err);
          }
          /* c8 ignore stop */
        }
        // Плюс автораскладка по названию: товар должен лежать на всех
        // подходящих полках, а не только в той, откуда пришёл.
        classifyAndSave(database, s.storeId, city, items, saved);
        const entry: StorePrices = { storeId: s.storeId, name: s.name, ready: true, items };
        // Сеть не ответила — отдаём кэш, но честно говорим, что он из кэша.
        // Только при реальных ошибках: сеть ответила и товаров правда нет.
        if (errors.length > 0) {
          // Ветка живёт внутри `if (category)`, поэтому проверки category здесь
          // не нужны: категория определена, иначе бы сюда не дошли.
          const categoryRows = database
            ? listCategoryProducts(database, { city, categoryId: category.id }).filter(
                (r) => r.storeId === s.storeId,
              )
            : [];
          const cached = database ? cachedToStorePrices(categoryRows, city, s.name) : [];
          const cachedItems = cached[0]?.items ?? [];
          if (cachedItems.length > 0) {
            entry.items = cachedItems;
            entry.cached = true;
            entry.error = `сеть не ответила, показаны цены из кэша (${new Date().toISOString().slice(0, 10)})`;
          } else {
            /* c8 ignore start — «часть запросов не удалась» недостижима: как
               только хоть один запрос ответил, автораскладка наполняет кэш полки,
               и выше срабатывает ветка кэша. Ветка сохранена на случай, если
               фильтрация изменится. */
            entry.error =
              items.length === 0
                ? `ни один запрос не сработал (${errors.length}): ${errors[0]}`
                : `часть запросов не удалась (${errors.length} из ${category?.queries.length ?? 0}): ${errors[0]}`;
            /* c8 ignore stop */
          }
        }
        if (dbError && !entry.error) entry.error = dbError;
        return entry;
      }),
    );
    const out = perStore;
    log.info(
      `полка «${category?.name ?? 'Не разложено'}» ${city}: ${Date.now() - startedAt}мс, товаров ${out.reduce((n, e) => n + e.items.length, 0)}`,
    );
    shelfCache.set(cacheKey, { at: Date.now(), value: out });
    saveAll();
    return out;
  };

  const getHistory = async (args?: {
    canonicalId?: string;
    storeId?: string;
    city?: string;
  }): Promise<HistoryPoint[]> => {
    try {
      if (!args?.canonicalId || !args?.storeId || !args?.city) return [];
      const database = await openDb(storage);
      return getPriceHistory(database, { canonicalId: args.canonicalId, storeId: args.storeId, city: args.city });
    } catch (err) {
      log.error('history failed', err);
      return [];
    }
  };

  // --- Избранное ----------------------------------------------------------
  // Город из интерфейса: без него автоопрос шёл бы по всем городам сразу.
  let currentCity: string | null = null;
  const selectedCity = (): string | null => currentCity;

  // Цена для избранного берётся из последней строки истории по (canonical_id,
  // store_id, city): это ровно та цена, за которой мы последний раз платили,
  // и она не требует похода в сеть — список открывается мгновенно и офлайн.
  const getFavorites = async ({ city }: { city: string }): Promise<Favorite[]> => {
    const database = await openDb(storage);
    const rows = listFavorites(database, city);
    // Названия берём одним списком, цены — по одному запросу на ключ из
    // latestPrices (не getPriceHistory: та отдаёт ПЕРВЫЕ N строк по возрастанию,
    // то есть на длинной истории это цена из прошлого). N+1 здесь допустим:
    // отметок десятки, а не тысячи, и запрос уже готовится один раз.
    const tracked = new Map(listTrackedProducts(database).map((t) => [t.canonicalId, t.name]));
    const prices = latestPrices(database, rows);
    return rows.map((row) => {
      const last = prices.get(`${row.storeId}:${row.canonicalId}:${row.city}`);
      return {
        canonicalId: row.canonicalId,
        storeId: row.storeId,
        city: row.city,
        name: tracked.get(row.canonicalId) || row.canonicalId,
        price: last ? last.price : null,
        targetPrice: row.targetPrice,
      };
    });
  };

  // target_price проверяем здесь, а не в SQL: значение из интерфейса не должно
  // молча превращаться в «уведомлять всегда».
  const setFavorite = async ({ targetPrice, ...scope }: ShelfScope & { targetPrice: number | null }) => {
    if (targetPrice !== null && (!Number.isFinite(targetPrice) || targetPrice <= 0)) {
      throw new Error('favorites:set: целевая цена должна быть положительным числом');
    }
    const database = await openDb(storage);
    saveFavorite(database, scope, targetPrice);
    saveAll();
    return getFavorites({ city: scope.city });
  };

  /**
 * Порог сработал: цена строго ниже цели. Сравнение строгое, потому что
 * «цена равна порогу» — это не «упала ниже», а молчаливое уведомление.
 *
 * city передаётся явно: проверять надо то, что только что опросили, а не
 * текущий выбор интерфейса — иначе опрос Ульяновска уведомлял бы по московским
 * ценам. city = undefined означает «все города» (ручной запуск без города).
 */
  const checkTargets = async (city?: string) => {
    const database = await openDb(storage);
    const rows = city ? listFavorites(database, city) : listFavoritesAll(database);
    if (rows.length === 0) return [];
    const tracked = new Map(listTrackedProducts(database).map((t) => [t.canonicalId, t.name]));
    const prices = latestPrices(database, rows);
    const hit: { canonicalId: string; storeId: string; city: string; name: string; price: number; target: number }[] = [];
    for (const row of rows) {
      if (row.targetPrice === null) continue;
      const last = prices.get(`${row.storeId}:${row.canonicalId}:${row.city}`);
      // Товара нет в наличии — сообщать не о чем: цена в истории осталась от
      // прошлого наблюдения, и уведомление вводило бы в заблуждение.
      if (!last || last.in_stock === 0) continue;
      // Повтор по той же цене не слать: без проверки одна и та же отметка
      // сообщала бы на каждом опросе, то есть каждые 6 часов. Порог сработал,
      // когда цена опустилась НИЖЕ прежней уведомлённой.
      if (last.price >= row.targetPrice) continue;
      if (row.notifiedPrice !== null && last.price >= row.notifiedPrice) continue;
      hit.push({
        canonicalId: row.canonicalId,
        storeId: row.storeId,
        city: row.city,
        name: tracked.get(row.canonicalId) || row.canonicalId,
        price: last.price,
        target: row.targetPrice,
      });
    }
    return hit;
  };

  // Помечает отправленные уведомления, чтобы те же цены не сообщали снова.
  const markNotified = async (hit: { canonicalId: string; storeId: string; city: string; price: number }[]) => {
    if (hit.length === 0) return;
    const database = await openDb(storage);
    saveNotifiedPrices(database, hit);
    saveAll();
  };

  const removeFavorite = async (scope: ShelfScope) => {
    const database = await openDb(storage);
    removeFavoriteDb(database, scope);
    saveAll();
    return getFavorites({ city: scope.city });
  };

  // Разрыв склейки проверяем на существование обоих id: иначе опечатка в
  // интерфейсе тихо создала бы правило, которое ничего не разделяет.
  const splitProducts = async ({ canonicalIdA, canonicalIdB }: SplitPair) => {
    const database = await openDb(storage);
    saveSplit(database, canonicalIdA, canonicalIdB);
    saveAll();
  };

  const removeSplit = async ({ canonicalIdA, canonicalIdB }: SplitPair) => {
    const database = await openDb(storage);
    removeSplitDb(database, canonicalIdA, canonicalIdB);
    saveAll();
  };

  const getSplitPairs = async ({ city }: { city: string }): Promise<string[]> => {
    const database = await openDb(storage);
    // Ключи строим по canonical_id — он уже несёт префикс сети ('magnit-1',
    // '5ka-9'), поэтому пара однозначна и без города. Фильтр по городу НЕ
    // сужает выборку: отметка «разные товары» про две конкретные позиции, и
    // сузив её до товаров этого города, мы потеряли бы пары, отмеченные, когда
    // пользователь смотрел другой город, — они бы молча исчезли из правил.
    // Set обязателен: listTrackedProducts возвращает distinct по
    // (canonical_id, store_id, city), поэтому один товар в трёх сетях даёт три
    // одинаковых id. Без дедупликации в IN-список шло втрое больше значений, а
    // он биндится дважды (left/right) — при ~16k строк дошли бы до лимита
    // параметров SQLite, и разрывы перестали бы работать молча.
    const ids = [...new Set(listTrackedProducts(database).map((t) => t.canonicalId))];
    return [...splitPairsFor(database, ids)];
  };

  const state: SchedulerState = {
    running: false,
    lastRun: null,
    counts: { inserted: 0, skipped: 0, failed: 0, notReady: 0, failedStores: [] },
    intervalHours: 6,
  };
  // Упавший опрос нельзя рапортовать как успешный: renderer красит summary как
  // «всё хорошо», и цены молча перестают обновляться. Держим последнюю ошибку
  // и счётчик подряд идущих провалов (правило домена: повторные фейлы — алерт).
  let lastError: string | null = null;
  let consecutiveFailures = 0;

  const pollSummary = (): string => {
    if (lastError) {
      return consecutiveFailures > 1
        ? `Опрос не удался ${consecutiveFailures} раз подряд: ${lastError}`
        : `Опрос не удался: ${lastError}`;
    }
    const c = state.counts;
    const total = c.inserted + c.skipped + c.failed + c.notReady;
    if (total === 0) {
      return 'Опрос завершён: отслеживаемых товаров пока нет — найди что-нибудь поиском или категорией.';
    }
    // Имя сети в сводке обязательно: «ошибок 1» не говорит, что чинить.
    const who = c.failedStores.length ? ` (${c.failedStores.join(', ')})` : '';
    // Непроверенные показываем отдельно: проход, где всё ушло в notReady
    // (сеть выключена или стоит на паузе breaker'а), иначе рапортовал бы
    // «проверено 0, ошибок 0» — зелёный баннер при нуле реальных проверок.
    const notReady = c.notReady > 0 ? `, не проверено ${c.notReady}` : '';
    return `Опрос завершён: проверено ${c.inserted + c.skipped}, новых цен ${c.inserted}, ошибок ${c.failed}${notReady}${who}.`;
  };

  const runScheduled = async (opts?: { city?: string | null; force?: boolean; dryRun?: boolean }): Promise<void> => {
    if (state.running) return;
    // dryRun — только показать, когда был последний опрос, без запросов.
    if (opts?.dryRun === true) {
      // Не поднимаем state.running: этот проход только читает метку, иначе он
      // на миллисекунды заблокировал бы реальный опрос, если пользователь
      // жмёт «Опросить сейчас» ровно в этот момент.
      try {
        const database = await openDb(storage);
        const cities = [...new Set(listTrackedProducts(database).map((t) => t.city))];
        const last = cities.map((c) => getLastRun(database, c)).filter(Boolean).sort().pop() ?? null;
        state.lastRun = last;
      } catch (err) {
        // startScheduler зовёт это через void, то есть без await: без catch
        // падение openDb стало бы unhandled rejection в main.
        log.error('опрос: не удалось прочитать метку последнего прохода', err);
      }
      return;
    }
    // Баннер на проход ровно один и он обязан быть честным: ветка «отложен»
    // знает, что сетевых запросов не было, и говорит это своим текстом.
    let summaryOverride: string | null = null;
    state.running = true;
    try {
      const database = await openDb(storage);
      // Опрос без цели: пока ни один товар не отслеживается, он не делает
      // ничего, но всё равно показывает баннер «отслеживаемых товаров пока
      // нет» — а его видно как «опрос пошёл при открытии полки». Молчим.
      if (listTrackedProducts(database).length === 0) {
        log.info('опрос пропущен: отслеживаемых товаров ещё нет');
        return;
      }
      // Автозапуск не повторяет недавний ручной. Без этой проверки старт
      // после запуска (background.after(30000)) опрашивал бы город заново
      // даже если пользователь только что нажал «Опросить сейчас», а на
      // бесплатной сети это лишние запросы к магазину без нужды.
      const auto = opts?.force !== true;
      const targetCity = opts?.city ?? selectedCity();
      // Автозапуск не повторяет недавний опрос этого города. Правило — метка против
      // интервала, а не «5 минут после ручного»: ручной запуск сам пишет
      // метку, поэтому свежая метка одинаково отсекает и повтор ручного, и
      // автозапуск после перезапуска приложения.
      if (auto && targetCity) {
        const last = getLastRun(database, targetCity);
        if (last && Date.now() - Date.parse(last) < state.intervalHours * 3600 * 1000) {
          log.info(`опрос ${targetCity} отложен: последний был ${last}`);
          state.lastRun = last;
          // Молчащий return рапортовался бы как успешный опрос: баннер в
          // интерфейсе показал бы «проверено N, новых цен M» от прошлого
          // прохода, хотя сетевых запросов не было. Текст уходит в finally
          // единственным событием done: раньше ветка эмитила сама, а потом
          // finally эмитил ВТОРОЕ событие со сводкой прошлого прохода, и
          // пользователь читал выдуманные «проверено 237, новых цен 7».
          summaryOverride = `Опрос отложен: ${targetCity} проверяли в ${last.slice(0, 16).replace('T', ' ')}.`;
          return;
        }
      }
      const progress = progressEmitter(emit);
      state.counts = await pollOnce(database, adapters, {
        // Пауза между товарами: 1 секунда. Раньше здесь стояло 2000, и опрос
        // на 76 позиций начисто съедал две минуты на ожидания.
        delayMs: 1000,
        // Только выбранный город: цена привязана к магазину, и обход всех
        // городов одной кнопкой означал бы запросы туда, куда пользователь
        // не смотрел.
        ...(targetCity ? { city: targetCity } : {}),
        onProgress: progress.onProgress,
        log,
      });
      // Финальное состояние уходит обязательно: иначе последние 250 мс
      // прогресса терялись бы и счётчик не дошёл бы до «N/N».
      progress.flush();
      state.lastRun = new Date().toISOString();
      // Метку пишем в БД: без неё перезапуск приложения (особенно portable —
      // каждый запуск новый процесс) забывал опрос и начинал его заново.
      if (targetCity) {
        saveLastRun(database, targetCity, state.lastRun);
        persistDb();
      }
      lastError = null;
      consecutiveFailures = 0;
      shell.notify(pollSummary());
      // Уведомление живёт до следующего опроса и в консоли не остаётся ни
      // следа: упавший опрос потом нечем разобрать. Поэтому провалы пишем в
      // консоль — с текстом ровно того, что увидел пользователь.
      if (state.counts.failed > 0) {
        log.warn('опрос прошёл с ошибками', pollSummary());
      }
      // Пороги избранного проверяем после опроса, а не по таймеру: цена только
      // что пришла из сети, и сообщать о снижении раньше бессмысленно.
      const hit = await checkTargets(targetCity ?? undefined);
      for (const t of hit) {
        const where = CITY_STORES[t.city]?.find((s) => s.storeId === t.storeId)?.name ?? t.storeId;
        shell.notify(`${t.name}: ${formatPrice(t.price)} в ${where} — дешевле ${formatPrice(t.target)}`);
      }
      // Помечаем ПОСЛЕ отправки: если уведомление бросит исключение, цена
      // останется неотмеченной и мы сообщим о ней при следующем опросе, что
      // лучше, чем потерять уведомление навсегда.
      await markNotified(hit);
    } catch (err) {
      log.error('scheduled poll failed', err);
      lastError = String(err).slice(0, 160);
      consecutiveFailures += 1;
      const summary = pollSummary();
      log.error('уведомление об опросе', summary);
      shell.notify(summary);
    } finally {
      state.running = false;
      emit('scheduler:done', { status: { ...state }, summary: summaryOverride ?? pollSummary() });
    }
  };

  const startScheduler = (): void => {
    // after(30000) — только чтобы «последний опрос» в подвале появился свежим
    // при первом запуске, без сетевых запросов.
    background.after(30000, () => void runScheduled({ city: null, force: false, dryRun: true }));
    // every(...) — настоящий опрос. Первым делом после старта его делать не
    // надо: у каждой сети есть своя защита, а пользователь может только что
    // опросить город вручную. Поэтому первый автоматический — через интервал.
    background.every(state.intervalHours * 3600 * 1000, () => void runScheduled());
  };

  // Ручная раскладка: набор полок товара и признак «под ручным управлением».
  const getShelves = async (scope: { canonicalId: string; storeId: string; city: string }) => {
    const database = await openDb(storage);
    return getProductShelves(database, scope);
  };

  // categoryIds проверяем ДО транзакции: иначе неизвестная полка уронила бы
  // откатом всю правку, и пользователь потерял бы выбор молча.
  const setShelves = async ({ categoryIds, ...scope }: ShelfScope & { categoryIds: string[] }) => {
    const database = await openDb(storage);
    const unique = [...new Set(categoryIds)];
    for (const id of unique) {
      if (id === UNASSIGNED_ID) throw new Error('shelves:set: «Не разложено» не полка, товар просто не выбран');
      if (!id || !id.trim()) throw new Error('shelves:set: пустая полка');
      if (!ourCategoryById(id)) throw new Error(`shelves:set: неизвестная полка «${id}»`);
    }
    setProductShelves(database, scope, unique);
    // Кэш полки живёт 3 минуты; без сброса правка выглядит как «не работает».
    shelfCache.clear();
    saveAll();
    return getProductShelves(database, scope);
  };

  const releaseShelves = async (scope: { canonicalId: string; storeId: string; city: string }) => {
    const database = await openDb(storage);
    releaseProductShelves(database, scope);
    shelfCache.clear();
    saveAll();
    return getProductShelves(database, scope);
  };

  return {
    searchPrices,
    getCatalogs,
    getCategoryProducts,
    getOurCategories,
    getOurCategory,
    getHistory,
    getShelves,
    setShelves,
    releaseShelves,
    getFavorites,
  setCurrentCity: (city: string) => {
    currentCity = city;
  },
  checkTargets,
  // Только для тестов ядра: тот же markNotified, что зовёт опрос, но без
  // рассылки уведомлений. В проде недостижимо — оболочка наружу не отдаёт.
  markNotifiedForTest: async (rows: { canonicalId: string; storeId: string; city: string; price: number }[]) =>
    markNotified(rows),
  setFavorite,
  removeFavorite,
  splitProducts,
  removeSplit,
  getSplitPairs,
  schedulerStatus: () => ({ ...state }),
  // Ручной запуск: force = true всегда. Иначе кнопка «Опросить сейчас» молча
  // ничего бы не делала сразу после автоопроса — пользователь нажал и не видит
  // ни счётчика, ни ошибки.
  runScheduler: async (args?: { city?: string }) => {
    if (state.running) {
      return { status: { ...state }, summary: 'Опрос уже идёт — дождись завершения.' };
    }
    await runScheduled({ ...(args?.city ? { city: args.city } : {}), force: true });
    return { status: { ...state }, summary: pollSummary() };
  },
  saveAll,
  startScheduler,
};
}
