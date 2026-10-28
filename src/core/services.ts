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
import { storeCodeMatches, UNKNOWN_STORE_CODE } from '../shared/types.js';
import type { CityStoreInfo } from '../shared/catalog.js';
import {
  pointKey,
  readyStoresForCity,
  storeByCode,
  storeIdsForCity,
  storesForCity,
  type StoreId,
  unknownPointLabel,
} from '../shared/catalog.js';
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
  priceKeyId,
  type PriceKey,
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
import { pointSelected, pollOnce, type PollCounts } from './scheduler.js';
import type { CoreDeps } from './platform.js';

const CATALOG_TTL_MS = 7 * 24 * 3600 * 1000;
// Сети, чей каталог живёт за браузером, меняют его часто — день вместо недели.
const BROWSER_CATALOG_TTL_MS = 24 * 3600 * 1000;
/**
 * Пауза между двумя запросами одной сети подряд (в том числе между её точками).
 *
 * Точки — это отдельные магазины одного домена: у Магнита отличается shopCode,
 * но хост и защита общие. Без паузы две точки дают два запроса подряд туда же,
 * а это ровно то, за что сеть банит. Разные сети тоже идут подряд (домены
 * разные, лимиты свои) — пауза между ними не нужна.
 *
 * Меряется между СТАРТАМИ запросов (см. networkSlot): у запроса есть длительность,
 * поэтому фактический зазор «конец → старт» получается не меньше, а запрос внутри
 * полки и так занимает время.
 */
const SAME_STORE_POINT_PAUSE_MS = 1200;
const OUR_MAX_PER_QUERY = 12;
const OUR_MAX_PER_CATEGORY = 150;
export const UNASSIGNED_ID = '__unassigned__';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Монотонные часы для замеров пауз. Date.now() прыгает назад при переводе
// времени или синхронизации NTP, и разность со временем последнего запроса
// становится отрицательной: `sleep` тогда получает величину скачка часов, и
// полка встаёт на минуты вместо паузы в полторы секунды.
const monotonicNow = (): number => performance.now();

export interface SchedulerState {
  running: boolean;
  lastRun: string | null;
  counts: PollCounts;
  intervalHours: number;
}

export interface Core {
  searchPrices(args?: PricesQuery): Promise<StorePrices[]>;
  getCatalogs(args?: { city?: string }): Promise<StoreCatalog[]>;
  /**
   * Сети, у которых в этой сборке есть адаптер.
   *
   * На десктопе их шесть, на Android — три: там нет браузера, а Пятёрка,
   * Чижик и Перекрёсток работают только через него. Интерфейс обязан считать
   * доступные точки по этому списку, иначе он обещает опрос, которого не
   * будет («Магазины: 0/6» при трёх сетях под рукой).
   */
  getSupportedNetworks(): string[];
  getCategoryProducts(args?: { city?: string; url?: string }): Promise<StorePrices[]>;
  getOurCategories(args?: { city?: string }): OurCategoryInfo[];
  getOurCategory(args?: { city?: string; id?: string }): Promise<StorePrices[]>;
  // Код точки обязателен и в типе ядра: опциональным он был ровно на то время,
// пока код подставлялся угадыванием. С опциональным полем «истории нет» и
// «не знаю, чья это история» отвечали бы одинаково — и пустой список молча
// выдавался бы за «нет замеров».
getHistory(args: {
    canonicalId: string;
    storeId: string;
    city: string;
    storeCode: string;
  }): Promise<HistoryPoint[]>;
  /** Полки товара и признак ручной раскладки. */
  getShelves(args: ShelfScope): Promise<ProductShelves>;
  /** Избранное города с текущей ценой каждой отмеченной точки. */
  getFavorites(args: { city: string }): Promise<Favorite[]>;
/** Город, выбранный в интерфейсе: автоопрос бьёт только по нему. */
  setCurrentCity(city: string): void;
  /** Выбор сетей города: null — все сети (пользователь ещё не выбирал). */
  /** Выбор ТОЧЕК города (storeId:storeCode); null — «выбор не сделан». */
  setCurrentStores(pointKeys: string[] | null): void;
  /**
   * Избранное с достигнутым порогом. Вызывается после опроса: сеть ответила,
   * цена упала — пора сообщить. Возвращает только те отметки, где порог есть
   // и текущая цена строго ниже него.
   */
  // Код точки в срабатывании обязателен: уведомление подписывается именем ТОЧКИ,
  // и без кода подпись была бы именем сети — то есть врёт при двух точках.
  checkTargets(city?: string): Promise<
    (PriceKey & { name: string; price: number; target: number })[]
  >;
  /** Пометить цены как уведомлённые: ими пользуется опрос и тесты ядра. */
  markNotifiedForTest(rows: (PriceKey & { price: number })[]): Promise<void>;
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
  runScheduler(args?: { city?: string; pointKeys?: string[] }): Promise<{ status: SchedulerState; summary: string }>;
  /**
   * Прервать идущий опрос. Отмена кооперативная: останавливается на границе
   * товара (уже начатый запрос у браузерных сетей доживает), собранное за прогон
   * сохраняется, а незакрытый цикл докачивается следующим запуском.
   * `false` — идти нечего.
   */
  cancelScheduler(): boolean;
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
): {
  onProgress: (done: number, total: number, storeId?: string, storeCode?: string) => void;
  flush: () => void;
} {
  // Монотонные часы: Date.now() прыгает назад при переводе времени или правке
  // часов, разность с lastAt становится отрицательной, и до выравнивания
  // прогресс глух — счётчик прыгал с «12/237» сразу на «237/237».
  // performance.now() от этого свободен (монотонный источник один на файл —
  // `monotonicNow` рядом с паузами сети).
  const monotonic = monotonicNow;
  let lastAt = Number.NEGATIVE_INFINITY;
  let last: { done: number; total: number; storeId?: string; storeCode?: string } | null = null;
  return {
    // storeId едет вместе со счётчиком: без него интерфейс не знает, ЧЕЙ магазин
    // сейчас опрашивается, и прогресс выглядит как «что-то делается в тишине».
    onProgress: (done, total, storeId, storeCode) => {
      last = {
        done,
        total,
        ...(storeId === undefined ? {} : { storeId }),
        ...(storeCode === undefined ? {} : { storeCode }),
      };
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
  const { storage, json, shell, background, log, adapters, closeBrowsers } = deps;
  const emit = deps.emit ?? (() => {});

  const SHELF_CACHE_TTL_MS = 3 * 60 * 1000;
  // Потолок на разбор браузеров после прогона. Обычно это десятки миллисекунд;
  // пять секунд ждём только зависший Playwright, чтобы интерфейс не остался с
  // вечно включённой кнопкой «Опрашиваю…».
  const BROWSER_CLOSE_TIMEOUT_MS = 5000;
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
  // Точка, за которую спросили. Сеть может не подтвердить код (sentinel «?»),
  // и тогда товар получает код запрошенной точки. Без этого две точки одной
  // сети дали бы товары с одинаковым ключом «сеть + canonicalId», и склейка
  // проглотила бы вторую точку как дубль — то есть сравнение цен между
  // точками перестало бы существовать физически.
  const pointItems = (items: ScrapedProduct[], storeCode: string): ScrapedProduct[] =>
    items.map((i) => (i.storeCode === UNKNOWN_STORE_CODE ? { ...i, storeCode } : i));

  /**
   * Ответ пришёл за другую точку. Цену мы не записали (см. storeItems), но
   * показать ответ в интерфейсе можно — только сказать честно, что это не
   * наш магазин, иначе в блоке сети появилась бы цена безо всякой оговорки.
   */
  const foreignPointError = (items: ScrapedProduct[], storeCode: string): string | undefined => {
    const foreign = items.filter((i) => i.storeCode !== UNKNOWN_STORE_CODE && i.storeCode !== storeCode);
    if (foreign.length === 0) return undefined;
    // Цены показаны как пришли, но в блоке стоит честная оговорка: в историю
    // нашей точки они не попали.
    return `сеть ответила за другую точку (${foreign[0]!.storeCode}) — цены показаны как есть, в историю не записаны`;
  };

  const storeItems = async (
    database: Database | null,
    storeId: string,
    city: string,
    storeCode: string,
    items: ScrapedProduct[],
  ): Promise<Set<string>> => {
    const saved = new Set<string>();
    if (!database) return saved;
    // Единственное горло для кода точки: даже если вызывающий забудет
    // про pointItems, запись всё равно получит код запрошенной точки, а не
    // sentinel. Идемпотентно: применённый код уже не sentinel.
    for (const item of pointItems(items, storeCode)) {
      try {
        // Инвариант домена на коде точки: сеть обязана подтвердить, ЧТО
        // это за магазин. Адаптер, который это умеет, кладёт в товар код,
        // который увидел в ответе; sentinel '?' означает «сеть код не
        // подтвердила» (тогда доверяем запрошенной точке).
        // Расхождение — это цены ЧУЖОЙ точки в нашей истории: молча пропускать
        // их нельзя, а писать тем более.
        if (item.storeCode !== storeCode) {
          throw new Error(
            `db: сеть ответила за точку ${item.storeCode}, а просили ${storeCode} (${item.canonicalId})`,
          );
        }
        savePriceIfChanged(database, { ...toPriceInput(item), storeId, city, storeCode });
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
    storeCode: string,
    items: ScrapedProduct[],
    saved?: Set<string>,
  ): void => {
    if (!database) return;
    const manual = manualShelfIds(database, storeId, city, storeCode);
    const rows = items.flatMap((i) =>
      (saved && !saved.has(i.canonicalId) ? [] : manual.has(i.canonicalId) ? [] : classifyOurCategories(i.name)).map(
        (categoryId) => ({
          canonicalId: i.canonicalId,
          storeId,
          city,
          storeCode,
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
  // Блок полки — это ТОЧКА, а не сеть: строки базы приходят поточечно, и блок с
  // sentinel-адресом фильтр выбора в интерфейсе отбросил бы целиком, то есть
  // обычная полка молча пустела бы.
  const cachedToStorePrices = (
    rows: CachedCategoryRow[],
    city: string,
    storeName: string,
  ): StorePrices[] => {
    const byPoint = new Map<string, { storeId: string; storeCode: string; items: ScrapedProduct[] }>();
    for (const r of rows) {
      const product: ScrapedProduct = {
        canonicalId: r.canonicalId,
        storeId: r.storeId,
        city,
        // Код точки из строки базы, а не эхо справочника: у блока может быть
        // sentinel (перенесённая строка), и подстановка кода точки изменила бы
        // её ключ — то есть цена уехала бы в другой магазин.
        storeCode: r.storeCode,
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
      // Ключ группы держим структурно, а не склейкой «storeId:storeCode» с последующим
      // split(':') — код точки с двоеточием разъехался бы молча.
      const key = pointKey(r.storeId, r.storeCode);
      const group = byPoint.get(key) ?? { storeId: r.storeId, storeCode: r.storeCode, items: [] };
      group.items.push(product);
      byPoint.set(key, group);
    }
    return [...byPoint.values()].map((g) => ({
      storeId: g.storeId,
      storeCode: g.storeCode,
      name: storeName,
      ready: true,
      items: g.items,
    }));
  };

  /**
   * Блоки кэша полки, относящиеся к точке: и её собственные строки, и
   * перенесённые ('?'). Слияния в один блок тут намеренно нет — перенесённые
   * цены не принадлежат названной точке, и подпись «точка неизвестна» обязана
   * дойти до пользователя.
   */
  const cacheBlocksFor = (cached: StorePrices[], storeCode: string): StorePrices[] =>
    cached.filter((c) => storeCodeMatches(c.storeCode, storeCode));

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
    const stores = storesForCity(city);
    const out: StorePrices[] = [];
    const lastHitByStore = new Map<string, number>();
    const { database, error: dbError } = await openDatabase();
    for (const s of stores) {
      if (!s.ready) {
        out.push({ storeId: s.storeId, storeCode: s.externalStoreId, name: s.name, ready: false, items: [] });
        continue;
      }
      const adapter = adapters.get(s.storeId);
      if (!adapter) {
        out.push({ storeId: s.storeId, storeCode: s.externalStoreId, name: s.name, ready: false, items: [], error: 'нет адаптера' });
        continue;
      }
      try {
        // Пауза перед повторным заходом в ТУ ЖЕ сеть: точки перечислены по
        // справочнику и в списке не обязаны стоять рядом, поэтому время
        // последнего запроса помним по каждой сети отдельно. Два запроса в
        // один домен подряд — ровно то, за что сеть банит.
        const lastHit = lastHitByStore.get(s.storeId);
        const wait = lastHit === undefined ? 0 : SAME_STORE_POINT_PAUSE_MS - (monotonicNow() - lastHit);
        if (wait > 0) await sleep(wait);
        const raw = await adapter.search(query, { city, externalStoreId: s.externalStoreId }).finally(() => {
          // Метку времени ставим в finally, а не на успешном пути: после отказа
          // сеть тоже должна выдержать паузу, иначе следующая точка получала бы
          // запрос сразу после неудачи — то есть ровно тогда, когда сеть враждебнее
          // всего.
          lastHitByStore.set(s.storeId, monotonicNow());
        });
        const items = pointItems(raw, s.externalStoreId);
        const saved = await storeItems(database, s.storeId, city, s.externalStoreId, items);
        classifyAndSave(database, s.storeId, city, s.externalStoreId, items, saved);
        const entry: StorePrices = {
          storeId: s.storeId,
          storeCode: s.externalStoreId,
          name: s.name,
          ready: true,
          items,
        };
        const foreign = foreignPointError(items, s.externalStoreId);
        if (foreign) entry.error = foreign;
        out.push(entry);
      } catch (err) {
        log.error('search failed', s.storeId, err);
        out.push({ storeId: s.storeId, storeCode: s.externalStoreId, name: s.name, ready: true, items: [], error: String(err) });
      }
    }
    if (dbError) for (const entry of out) entry.error = entry.error ?? dbError;
    saveAll();
    return out;
  };

  /**
   * Сети с адаптером в этой сборке. Список, а не число: интерфейс должен
   * отличать «сеть недоступна на этой платформе» от «сеть молчит» — иначе
   * недоступные сети выглядят как сломанные.
   */
  const getSupportedNetworks = (): string[] => [...adapters.keys()];

  const getCatalogs = async (args?: { city?: string }): Promise<StoreCatalog[]> => {
    const city = args?.city ?? 'moscow';
    const stores = storesForCity(city);
    const out: StoreCatalog[] = [];
    // Точки одной сети идут в один домен, поэтому между запросами каталога пауза
    // обязательна: без неё две точки дают два fetchCategories подряд в magnit.ru.
    const lastCatalogHit = new Map<string, number>();
    for (const s of stores) {
      const adapter = adapters.get(s.storeId);
      if (!s.ready || !adapter || typeof adapter.fetchCategories !== 'function') {
        out.push({ storeId: s.storeId, storeCode: s.externalStoreId, name: s.name, categories: [] });
        continue;
      }
      try {
        // Пустой кэш — это промах, а не попадание: иначе разъехавшаяся форма
        // (сеть переименовала url) заблокирует сеть на весь TTL в 7 суток.
        const cached = readCatalogCache(city, s.storeId, s.externalStoreId);
        if (cached && cached.length > 0) {
          out.push({ storeId: s.storeId, storeCode: s.externalStoreId, name: s.name, categories: cached });
          continue;
        }
        const prev = lastCatalogHit.get(s.storeId);
        if (prev !== undefined) {
          const wait = SAME_STORE_POINT_PAUSE_MS - (monotonicNow() - prev);
          if (wait > 0) await sleep(wait);
        }
        const categories = await adapter
          .fetchCategories({ city, externalStoreId: s.externalStoreId })
          .finally(() => {
            lastCatalogHit.set(s.storeId, monotonicNow());
          });
        writeCatalogCache(city, s.storeId, s.externalStoreId, categories);
        out.push({ storeId: s.storeId, storeCode: s.externalStoreId, name: s.name, categories });
      } catch (err) {
        log.error('catalog failed', s.storeId, err);
        // Сеть молчит — отдаём протухший кэш, но не выдумываем: без кэша
        // категория просто недоступна и это видно в error.
        const stale = readCatalogCache(city, s.storeId, s.externalStoreId, true);
        if (stale && stale.length > 0)
            out.push({ storeId: s.storeId, storeCode: s.externalStoreId, name: s.name, categories: stale });
        else
          out.push({
            storeId: s.storeId,
            storeCode: s.externalStoreId,
            name: s.name,
            categories: [],
            error: String(err),
          });
      }
    }
    return out;
  };

  const getCategoryProducts = async (args?: { city?: string; url?: string }): Promise<StorePrices[]> => {
    const city = args?.city ?? 'moscow';
    if (!args?.url) return [];
    const stores = storesForCity(city);
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
        storeCode: stores[0]?.externalStoreId ?? UNKNOWN_STORE_CODE,
        name: stores[0]?.name ?? 'Полка',
        ready: false,
        items: [],
        error: 'ссылка на полку не принадлежит ни одной сети этого города — вернись к категориям и открой полку заново',
      }];
    }
    // Кандидаты — это ТОЧКИ, а не сети: с двумя точками одной сети в городе клик по
    // плитке даёт два запроса в один домен. Пауза между ними — та же константа
    // (SAME_STORE_POINT_PAUSE_MS), иначе это двойной удар по сети через
    // миллисекунды. Метку ставим ПОСЛЕ запроса (цикл последовательный), то есть
    // пауза здесь считается от конца предыдущего — строже, чем на полке, где слот
    // резервируется до запроса, потому что там цепочки идут параллельно.
    const lastCategoryHit = new Map<string, number>();
    for (const { s, adapter } of candidates) {
      if (typeof adapter!.fetchCategoryProducts !== 'function') {
        out.push({ storeId: s.storeId, storeCode: s.externalStoreId, name: s.name, ready: false, items: [] });
        continue;
      }
      const lastHit = lastCategoryHit.get(s.storeId);
      if (lastHit !== undefined) {
        const wait = SAME_STORE_POINT_PAUSE_MS - (monotonicNow() - lastHit);
        if (wait > 0) await sleep(wait);
      }
      try {
        const raw = await adapter!.fetchCategoryProducts(url, {
          city,
          externalStoreId: s.externalStoreId,
        }).finally(() => {
          // Метка и на отказе: после неудачи пауза нужна тем же, что после успеха.
          lastCategoryHit.set(s.storeId, monotonicNow());
        });
        const items = pointItems(raw, s.externalStoreId);
        const saved = await storeItems(database, s.storeId, city, s.externalStoreId, items);
        classifyAndSave(database, s.storeId, city, s.externalStoreId, items, saved);
        const categoryEntry: StorePrices = {
          storeId: s.storeId,
          storeCode: s.externalStoreId,
          name: s.name,
          ready: true,
          items,
        };
        const categoryForeign = foreignPointError(items, s.externalStoreId);
        if (categoryForeign) categoryEntry.error = categoryForeign;
        out.push(categoryEntry);
      } catch (err) {
        log.error('category failed', s.storeId, err);
        out.push({ storeId: s.storeId, storeCode: s.externalStoreId, name: s.name, ready: true, items: [], error: String(err) });
      }
    }
    if (dbError) for (const entry of out) entry.error = entry.error ?? dbError;
    saveAll();
    return out;
  };

  const getOurCategories = (args?: { city?: string }): OurCategoryInfo[] => {
    const city = args?.city ?? 'moscow';
    // Считаем СЕТИ, а не точки: поле называется storeCount, и подпись в интерфейсе
    // читается как «столько магазинов готово». Точек на город сейчас одна, и
    // счётчики совпадали; с двумя точками одной сети написание «7 магазинов» при
    // шести сетях было бы враньём (вторую часть шага 4).
    const readyStores = storeIdsForCity(city).filter((id) => {
      const point = readyStoresForCity(city, id)[0];
      return point !== undefined && adapters.has(id);
    }).length;
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
    const stores = storesForCity(city);
    const { database, error: dbError } = await openDatabase();
    const startedAt = Date.now();
    // Магазины (то есть точки) идут ПАРАЛЛЕЛЬНО: разные сети ходят на разные
    // домены, общий rate-limit у них один только внутри сети. По очереди полка
    // «Молочное и яйца» (8 запросов) ждала паузу трижды на каждый магазин — минуты
    // на пустом месте.
    //
    // ТОЧКИ ОДНОЙ СЕТИ — исключение: они ходят на тот же домен, и две
    // параллельные цепочки в один magnit.ru — ровно то, за что банят. Пока на
    // город была одна точка, это правило было невидимо; с двумя точками пауза
    // между ними обязана быть, иначе клик по полке станет двойным запросом в
    // один домен через миллисекунды.
    const lastPointHit = new Map<string, number>();
    // Слот сети: резервируется СИНХРОННО (до await), иначе при трёх и более
    // точках все читали бы отметку одновременно, проснулись бы в одну
    // миллисекунду и ударили в домен вместе.
    //
    // Гарантия — «≥ SAME_STORE_POINT_PAUSE_MS между СТАРТАМИ двух запросов одной
    // сети». Отдельно складывать сюда паузу между запросами одной точки нельзя:
    // две константы по 1200 дают 2400, и полка «Молочное и яйца» (8 запросов)
    // растягивалась на десятки секунд впустую. Внутриточечный зазор и так
    // больше 1200 — запрос занимает время.
    const networkSlot = async (storeId: string): Promise<void> => {
      const now = monotonicNow();
      const prev = lastPointHit.get(storeId);
      const earliest = prev === undefined ? now : prev + SAME_STORE_POINT_PAUSE_MS;
      const startAt = Math.max(now, earliest);
      lastPointHit.set(storeId, startAt);
      if (startAt > now) await sleep(startAt - now);
    };
    const perStore = await Promise.all(
      stores.map(async (s): Promise<StorePrices[]> => {
        const adapter = adapters.get(s.storeId);
        // Финализатор блоков точки. Объявлен до ранних return'ов и существует
        // из-за них: без него сообщение «база недоступна» терялось, и
        // пользователь читал про сеть то, на что сеть не виновата.
        const finishBlocks = (...blocks: StorePrices[]): StorePrices[] => {
          for (const b of blocks) if (dbError && !b.error) b.error = dbError;
          return blocks;
        };
        if (!s.ready || !adapter) {
          return finishBlocks({
            storeId: s.storeId,
            storeCode: s.externalStoreId,
            name: s.name,
            ready: false,
            items: [],
          });
        }
        const byId = new Map<string, ScrapedProduct>();
        const errors: string[] = [];
        // Счётчик УСПЕШНЫХ запросов. Живёт рядом с errors, а не внутри цикла:
        // ветка разбора отказа читает его и для полки, и для виртуальной
        // «Не разложено». По нему текст отказа остаётся правдой — раньше
        // единственный счётчик ошибок давал «ни один запрос не сработал» и в
        // случае, когда запросы отработали, но товары не подошли под полку.
        let okQueries = 0;
        if (category) {
          // Предохранитель: Пятёрка ходит через браузер, и её таймаут — 60 секунд
          // на запрос. Восемь запросов подряд дают 8 минут ожидания на одну
          // полку, причём сеть после первого отказа почти наверняка откажет и
          // дальше. Два отказа подряд — и сеть выбывает до конца открытия полки,
          // а её товары показываются из кэша с честной пометкой.
          let strikes = 0;
          const STRIKE_LIMIT = 2;
          for (const query of category.queries) {
            // Пауза резервируется на КАЖДЫЙ сетевой запрос, а не один раз на
            // цепочку точки: полка «Молочное и яйца» — это восемь запросов, и при
            // двух точках второй запрос точки А попадал в первый запрос точки Б
            // (разрыв 0 мс) — то есть два запроса в один домен одновременно.
            await networkSlot(s.storeId);
            const qStart = Date.now();
            try {
              const found = pointItems(
                await adapter.search(query, { city, externalStoreId: s.externalStoreId }),
                s.externalStoreId,
              );
              for (const item of found.slice(0, OUR_MAX_PER_QUERY)) {
                // Слова из названия решают, попадает ли товар в нашу полку:
                // без этого в «Молоко» попадали коктейли молочные.
                if (!matchesOurCategory(category, item.name)) continue;
                const prev = byId.get(item.canonicalId);
                if (!prev || item.collectedAt > prev.collectedAt) byId.set(item.canonicalId, item);
              }
              strikes = 0;
              okQueries += 1;
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
            return [
              {
                storeId: s.storeId,
                storeCode: s.externalStoreId,
                name: s.name,
                ready: false,
                items: [],
                // Базы нет — значит, openDatabase уже объяснил почему, и текст
                // ошибки здесь есть всегда.
                error: dbError!,
              },
            ];
          }
          const rows = listUnassignedProducts(database, { city }).filter(
            (r) => r.storeId === s.storeId && storeCodeMatches(r.storeCode, s.externalStoreId),
          );
          const cached = cachedToStorePrices(rows, city, s.name);
          // Пусто здесь — не «товаров нет», а «ещё нечего показать»: полка читает
          // только локальную базу и в сеть не ходит, поэтому и в статусе полки
          // нельзя писать «опрошен» (это враньё читателю, который только что
          // увидел подпись «в сеть не ходит»). Флаг cached renderer показывает как
          // «из локальной базы».
          //
          // Блоки НЕ сливаем: свои строки точки и перенесённые ('?') — это разные
          // данные, и подпись «точка неизвестна» обязана остаться честной. Раньше
          // брался find по первой подходящей группе, из-за чего перенесённые
          // строки молча исчезали с полки вместе с товарами.
          const blocks = cacheBlocksFor(cached, s.externalStoreId);
          if (blocks.length > 0) return blocks.map((b) => ({ ...b, cached: true }));
          return [
            {
              storeId: s.storeId,
              storeCode: s.externalStoreId,
              name: s.name,
              ready: true,
              items: [],
              cached: true,
            },
          ];
        }
        const items = [...byId.values()].slice(0, OUR_MAX_PER_CATEGORY);
        const saved = await storeItems(database, s.storeId, city, s.externalStoreId, items);
        if (database && category) {
          try {
            // Товар под ручным управлением сюда не пишем: ручная раскладка
            // должна пережить открытие любой полки, иначе «убрать со всех полок»
            // отменилось бы само собой при первом же запросе.
            const manual = manualShelfIds(database, s.storeId, city, s.externalStoreId);
            saveProductCategory(
              database,
              items
                .filter((i) => saved.has(i.canonicalId) && !manual.has(i.canonicalId))
                .map((i) => ({
                  canonicalId: i.canonicalId,
                  storeId: s.storeId,
                  city,
                  storeCode: s.externalStoreId,
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
        classifyAndSave(database, s.storeId, city, s.externalStoreId, items, saved);
        const entry: StorePrices = {
          storeId: s.storeId,
          storeCode: s.externalStoreId,
          name: s.name,
          ready: true,
          items,
        };
        // Ответ пришёл за чужую точку: цены показаны как есть, но в историю
        // нашей точки они не попали (см. storeItems), и пользователь обязан видеть
        // оговорку — иначе в блоке нашей точки просто появилась бы чужая цена.
        const foreign = foreignPointError(items, s.externalStoreId);
        if (foreign) entry.error = foreign;
        // Сеть не ответила — отдаём кэш, но честно говорим, что он из кэша.
        // Только при реальных ошибках: сеть ответила и товаров правда нет.
        // Проверка category в условии — не формальность: она сужает тип, и в
        // тексте не приходится писать `?? 0` на месте, где нулевая сторона
        // недостижима (отказ накапливается только внутри цикла запросов полки).
        if (category && errors.length > 0) {
          // Ветка живёт внутри `if (category)`, поэтому проверки category здесь
          // не нужны: категория определена, иначе бы сюда не дошли.
          const categoryRows = database
            ? listCategoryProducts(database, { city, categoryId: category.id }).filter(
                (r) => r.storeId === s.storeId && storeCodeMatches(r.storeCode, s.externalStoreId),
              )
            : [];
          const cached = database ? cachedToStorePrices(categoryRows, city, s.name) : [];
          const ownCache = cached.find((c) => c.storeCode === s.externalStoreId);
          const unknownCache = cached.find((c) => c.storeCode === UNKNOWN_STORE_CODE);
          // Перенесённый кэш показываем ОТДЕЛЬНЫМ блоком с его собственным
          // кодом '?' и в том случае, когда своя точка молчит, и когда у неё
          // есть свои строки: иначе перенесённые цены либо выдавались бы за
          // цены названной точки, либо молча пропадали бы с полки.
          const migratedBlock = (): StorePrices => ({
            ...unknownCache!,
            cached: true,
            // Сообщение о чужой точке наследуется (сеть отвечала не за нашу
            // точку), а сообщение о кэше — своё: block собственного кода '?'
            // не должен называться «цены из кэша» точки, которой он не принадлежит.
            error: foreign ?? `сеть не ответила, показаны перенесённые цены (${new Date()
              .toISOString()
              .slice(0, 10)})`,
          });
          if (ownCache) {
            entry.items = ownCache.items;
            entry.cached = true;
            // Сообщение о чужой точке не затирается: товар подменён кэшем, но
            // пользователь всё равно должен знать, что по его точке отвечала
            // другая точка сети.
            if (!entry.error) {
              entry.error = `сеть не ответила, показаны цены из кэша (${new Date().toISOString().slice(0, 10)})`;
            }
            // Сравнение объектов, а не кодов: у точки, чей код сам '?', ownCache и
            // unknownCache — один и тот же блок, и вернуть его дважды значило бы
            // продублировать ключ React в шапке выдачи.
            if (unknownCache && unknownCache !== ownCache) return finishBlocks(entry, migratedBlock());
          } else if (unknownCache) {
            return finishBlocks(migratedBlock());
          } else if (okQueries === 0) {
            entry.error = `ни один запрос не сработал (${errors.length}): ${errors[0]}`;
          } else if (items.length === 0) {
            // Запросы отработали, но товары не подошли под полку («молоко» на
            // полке сыров). Прежний текст звал это «ни один запрос не сработал»,
            // то есть обвинял сеть в том, в чём виновата полка.
            entry.error = `сеть ответила, но ни один товар не подошёл под полку (запросов: ${okQueries})`;
          } else {
            entry.error = `часть запросов не удалась (${errors.length} из ${category.queries.length}): ${errors[0]}`;
          }
        }
        return finishBlocks(entry);
      }),
    );
    const rawBlocks = perStore.flat();
    // Блок перенесённых цен ('?') общий для сети: при двух точках он пришёл бы
    // от обеих одинаковым и дал дубль ключа в шапке выдачи. Данные те же,
    // поэтому оставляем первый.
    const out = rawBlocks.filter(
      (b, i) => rawBlocks.findIndex((x) => x.storeId === b.storeId && x.storeCode === b.storeCode) === i,
    );
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
    storeCode?: string;
  }): Promise<HistoryPoint[]> => {
    try {
      // Код точки обязателен: без него мы вернули бы историю «какой-то точки
      // этой сети», то есть чужой график. Раньше здесь подставлялась первая
      // готовая точка — стоило добавить вторую, и график тихо уезжал бы на неё.
      if (!args?.canonicalId || !args?.storeId || !args?.city || !args?.storeCode) return [];
      const database = await openDb(storage);
      return getPriceHistory(database, {
        canonicalId: args.canonicalId,
        storeId: args.storeId,
        city: args.city,
        storeCode: args.storeCode,
      });
    } catch (err) {
      log.error('history failed', err);
      return [];
    }
  };

  // --- Избранное ----------------------------------------------------------
  // Город из интерфейса: без него автоопрос шёл бы по всем городам сразу.
  let currentCity: string | null = null;
/**
 * Выбранные пользователем сети для текущего города. Живёт в памяти процесса, как и
 * currentCity: после перезапуска приложения renderer снова присылает выбор, а до этого
 * автоопрос идёт по всем сетям города (пользователь ещё не выбирал).
 */
// Выбор ТОЧЕК из шапки — список ключей `storeId:storeCode`. null означает
// «пользователь ещё не выбирал», и тогда автоопрос идёт по всем точкам города.
let currentPoints: string[] | null = null;
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
      const last = prices.get(priceKeyId(row));
      return {
        canonicalId: row.canonicalId,
        storeId: row.storeId,
        city: row.city,
        // Код точки едет в интерфейс: без него отметка точки А была бы
        // неотличима от отметки точки Б той же сети, и снять можно было бы
        // только одну из них наугад.
        storeCode: row.storeCode,
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
    const hit: (PriceKey & { name: string; price: number; target: number })[] = [];
    for (const row of rows) {
      if (row.targetPrice === null) continue;
      const last = prices.get(priceKeyId(row));
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
        storeCode: row.storeCode,
        name: tracked.get(row.canonicalId) || row.canonicalId,
        price: last.price,
        target: row.targetPrice,
      });
    }
    return hit;
  };

  // Помечает отправленные уведомления, чтобы те же цены не сообщали снова.
  const markNotified = async (hit: (PriceKey & { price: number })[]) => {
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
    counts: {
      inserted: 0,
      skipped: 0,
      failed: 0,
      notReady: 0,
      failedStores: [],
      staleStores: [],
      interrupted: false,
      remaining: 0,
    },
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
    // Имя сети в сводке обязательно: «ошибок 1» не говорит, что чинить.
    const who = c.failedStores.length ? ` (${c.failedStores.join(', ')})` : '';
    // Непроверенные показываем отдельно: проход, где всё ушло в notReady
    // (сеть выключена или стоит на паузе breaker'а), иначе рапортовал бы
    // «проверено 0, ошибок 0» — зелёный баннер при нуле реальных проверок.
    const notReady = c.notReady > 0 ? `, не проверено ${c.notReady}` : '';
    // Протухшие точки — отдельная строка: сеть жива, но её магазины она не
    // обновляет, поэтому цены этих товаров заморожены. Без этой строки сводка
    // выглядит как обычная ошибка сети, а пользователь не понимает, почему по
    // части магазинов цены не меняются месяцами.
    const stale = c.staleStores.length
      ? ` Сеть не обновляет: ${c.staleStores.join(', ')} — цены этих магазинов заморожены.`
      : '';
    // Прерванный прогон НЕ называется завершённым: баннер «Опрос завершён» был бы
    // зелёным при незакрытом цикле, и следующее нажатие снова выглядело бы
    // как «всё проверил». Показываем, сколько осталось — ради этого всё и было.
    // Проверка РАНЬШЕ ветки нуля целей: прерванный на первом же товаре прогон
    // имеет нулевые счётчики, и «товаров нет» перебивало бы честное «прерван».
    if (c.interrupted) {
      return `Опрос прерван: проверено ${c.inserted + c.skipped}, осталось ${c.remaining}.` +
        ` Следующий запуск докачает остаток (ошибок ${c.failed}${notReady}${who}).${stale}`;
    }
    if (total === 0) {
      return 'Опрос завершён: отслеживаемых товаров пока нет — найди что-нибудь поиском или категорией.';
    }
    return `Опрос завершён: проверено ${c.inserted + c.skipped}, новых цен ${c.inserted}, ошибок ${c.failed}${notReady}${who}.${stale}`;
  };

  /**
  * Прерывание идущего прогона.
  *
  * Отмена кооперативная: планировщик спрашивает `isCancelled` перед каждым
  * товаром, поэтому точность — один товар, а у браузерных сетей уже начатый
  * запрос доживает сам (до минуты). Мгновенной остановки не обещаем ни в UI,
  * ни здесь — иначе пользователь снимет галочку, увидит «опрос идёт» и решит,
  * что кнопка не работает.
  */
  let pollCancelled = false;
  const stopRunningPoll = (reason: string): void => {
    if (!state.running) return;
    pollCancelled = true;
    log.info(`опрос прерывается: ${reason} (останавливается на текущем товаре)`);
  };

  const runScheduled = async (opts?: {
    city?: string | null;
    pointKeys?: string[];
    force?: boolean;
    dryRun?: boolean;
  }): Promise<string> => {
    // Сводка возвращается всегда строкой: ранние ветки (уже идёт, dryRun) отдают
    // текущую, чтобы вызывающий не получил void в типе.
    if (state.running) return pollSummary();
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
      return pollSummary();
    }
// Баннер на проход ровно один и он обязан быть честным: ветка «отложен»
    // знает, что сетевых запросов не было, и говорит это своим текстом.
let summaryOverride: string | null = null;
    state.running = true;
    // Флаг прерывания сбрасывается на старте: прошлый прогон мог быть отменён,
    // и без сброса новый прогон встал бы на первом же товаре.
    pollCancelled = false;
    try {
      const database = await openDb(storage);
      // Опрос без цели: пока ни один товар не отслеживается, он не делает
      // ничего, но всё равно показывает баннер «отслеживаемых товаров пока
      // нет» — а его видно как «опрос пошёл при открытии полки». Молчим.
      if (listTrackedProducts(database).length === 0) {
        log.info('опрос пропущен: отслеживаемых товаров ещё нет');
        return pollSummary();
      }
      // Автозапуск не повторяет недавний ручной. Без этой проверки старт
      // после запуска (background.after(30000)) опрашивал бы город заново
      // даже если пользователь только что нажал «Опросить сейчас», а на
      // бесплатной сети это лишние запросы к магазину без нужды.
      const auto = opts?.force !== true;
      const targetCity = opts?.city ?? selectedCity();
      // Выбор магазинов из шапки — фильтр опроса, а не только фильтр выдачи: без
      // него счётчик обещал обход всех сетей города, а ходил и в выключенные.
      const targetPoints = opts?.pointKeys ?? currentPoints;
      // Ни одной сети не выбрано: это НЕ то же, что «нет отслеживаемых
      // товаров». Молчаливый баннер про товары увёл бы пользователя искать
      // товары, хотя он просто снял все галочки магазинов.
      if (targetPoints !== null && targetPoints.length === 0) {
        log.info('опрос пропущен: ни одна сеть не выбрана');
        summaryOverride = 'Опрос пропущен: не выбрано ни одного магазина.';
        return summaryOverride;
      }
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
          // summaryOverride тут всегда задан: ветка только что его выставила.
          return summaryOverride;
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
        // И только выбранные сети: галочка в шапке обещала не больше, а опрос
        // ходил во все сети города — отсюда «28 из 445» при одном магазине.
        ...(targetPoints ? { pointKeys: targetPoints } : {}),
        // Продолжение незаконченного цикла города: повторное нажатие берёт
        // неповеренное и ошибочное, а не всё подряд. Полный проход обнуляет
        // чек-лист сам (в планировщике) — тогда следующий прогон снова весь.
        resume: targetCity !== null && targetCity !== undefined,
        // Отмена кооперативная: снятие галочки или смена города останавливают
        // прогон на границе товара, собранное за него сохраняется.
        isCancelled: () => pollCancelled,
        onProgress: progress.onProgress,
        log,
      });
      // Финальное состояние уходит обязательно: иначе последние 250 мс
      // прогресса терялись бы и счётчик не дошёл бы до «N/N».
    progress.flush();
      state.lastRun = new Date().toISOString();
      // Метку пишем в БД: без неё перезапуск приложения (особенно portable —
      // каждый запуск новый процесс) забывал опрос и начинал его заново.
      //
      // Прерванный прогон метку НЕ пишет: цикл города не закрыт, и запись
      // «проверяли час назад» отложила бы автозапуск на полный интервал (до 6
      // часов) — то есть остаток добирался бы только ручным нажатием, что
      // тихо противоречит самой идее докачки. Автозапуск при этом тоже
      // пропустит город по старой метке, и это осознанный размен: единственный
      // способ ускорить докачку — нажать кнопку ещё раз.
      if (targetCity && !state.counts.interrupted) {
        saveLastRun(database, targetCity, state.lastRun);
        persistDb();
      }
      lastError = null;
      consecutiveFailures = 0;
      // Ноль проверок после живого прогона — не всегда «товаров нет вообще»:
      // выбор магазинов отсекает цели ещё до опроса, и старый текст звал
      // искать то, что уже было найдено (на телефоне выбор из одной сети без
      // истории выглядел именно так). Два нуля различаем честно: сводка
      // различит «нет товаров» от «товары есть, но не в выбранных магазинах».
      const checkedTotal =
        state.counts.inserted + state.counts.skipped + state.counts.failed + state.counts.notReady;
      if (checkedTotal === 0) {
        const cityTracked = listTrackedProducts(database).filter(
          (t) => !targetCity || t.city === targetCity,
        );
        if (cityTracked.length > 0 && !cityTracked.some((t) => pointSelected(t, targetPoints))) {
          summaryOverride =
            'Опрос завершён: в выбранных магазинах отслеживаемых товаров нет — отметь другие магазины или поищи в выбранных.';
        } else if (!state.counts.interrupted && state.counts.remaining > 0) {
          // Ноль целей при живом чек-листе: остаток прошлого прерванного
          // прогона уже проверен. «Товаров нет» здесь было бы враньём.
          summaryOverride = 'Опрос завершён: все отслеживаемые товары уже проверены в этом цикле.';
        }
      }
      const runSummary = summaryOverride ?? pollSummary();
      shell.notify(runSummary);
      // Уведомление живёт до следующего опроса и в консоли не остаётся ни
      // следа: упавший опрос потом нечем разобрать. Поэтому провалы пишем в
      // консоль — с текстом ровно того, что увидел пользователь.
      if (state.counts.failed > 0) {
        log.warn('опрос прошёл с ошибками', runSummary);
      }
      // Пороги избранного проверяем после опроса, а не по таймеру: цена только
      // что пришла из сети, и сообщать о снижении раньше бессмысленно.
      const hit = await checkTargets(targetCity ?? undefined);
      for (const t of hit) {
        // Подпись называет ТОЧКУ, а не сеть: цена пришла по коду точки, и
        // «в Магните» при двух точках в городе означало бы, что мы не знаем,
        // где именно она. Адрес точки подставит шаг 8, пока — её название.
        const point = storeByCode(
          t.storeId as StoreId,
          t.city,
          t.storeCode,
        );
        const networkTitle = storesForCity(t.city, t.storeId as StoreId)[0]?.name ?? t.storeId;
        // Перенесённая отметка (код '?') назвать точку не может: цена пришла по
        // настоящему коду точки, и «в Магнит, Пушкинская» вводило бы в
        // заблуждение, будто отметка относится к этой точке.
        const where =
          t.storeCode === UNKNOWN_STORE_CODE ? unknownPointLabel(networkTitle) : (point?.name ?? networkTitle);
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
      // Override успех-ветки сгорает: упавший прогон обязан иметь ОДНУ правду
      // в баннере («не удался») и в событии done, иначе они расходятся —
      // баннер честный, а возврат runScheduler унёс бы текст успеха.
      summaryOverride = null;
      const summary = pollSummary();
      log.error('уведомление об опросе', summary);
      shell.notify(summary);
} finally {
      // Браузеры сетей после прогона НЕ нужны: каждый — отдельный процесс Firefox
      // с сотнями мегабайт памяти, и до выхода из приложения они висели бы зря
      // (проверено 2026-11-11 на живой сборке: после прогона по Москве оставалось
      // 8 таких процессов). Закрытие в finally, а не после опроса: ветки
      // «пропущен» и «отложен» тоже уходят отсюда, а браузеры, открытые прошлым
      // прогоном, им не нужны тем более.
      if (closeBrowsers !== undefined) {
        // С таймаутом: зависший close() Playwright иначе держал бы и флаг
        // прогона, и ответ runScheduler вечно — интерфейс остался бы с
        // неактивной кнопкой. Цены к этому моменту уже записаны, терять нечего.
        // Таймер НЕ unref-ится намеренно: с unref он не срабатывал, когда в цикле
        // событий больше ничего не держано (тест висел), и «потолок» превращался в
        // вечное ожидание. Вместо этого таймер гасится сразу после гонки.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          closeBrowsers().catch((err) => {
            log.error('не удалось закрыть браузеры после опроса', err);
          }),
          new Promise<void>((r) => {
            timer = setTimeout(r, BROWSER_CLOSE_TIMEOUT_MS);
          }),
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        });
      }
      // Флаг снимается ПОСЛЕ закрытия. Иначе за окно teardown (сотни
      // миллисекунд) таймер или второй клик успевали бы начать новый опрос и
      // убить только что поднятый браузер, а запрос полки — словить «Target
      // closed» ровно на завершении предыдущего прогона.
      state.running = false;
      const summary = summaryOverride ?? pollSummary();
      emit('scheduler:done', { status: { ...state }, summary });
      return summary;
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
  const getShelves = async (scope: ShelfScope) => {
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

  const releaseShelves = async (scope: ShelfScope) => {
    const database = await openDb(storage);
    releaseProductShelves(database, scope);
    shelfCache.clear();
    saveAll();
    return getProductShelves(database, scope);
  };

  return {
    searchPrices,
    getCatalogs,
    getSupportedNetworks,
    getCategoryProducts,
    getOurCategories,
    getOurCategory,
    getHistory,
    getShelves,
    setShelves,
    releaseShelves,
    getFavorites,
setCurrentCity: (city: string) => {
      // Смена города — тоже смена объёма работы: идущий опрос старого города
      // пользователь отменил фактом перехода. Прерываем до сброса выбора.
      if (city !== currentCity) stopRunningPoll('смена города');
      currentCity = city;
      // Выбор магазинов принадлежит городу: сменили город — галочки прежнего
      // города не должны молча решать, какие сети опрашивать.
      currentPoints = null;
    },
    /**
     * Выбранные сети города. `null` — пользователь ещё не выбирал (опрос по всем
     * сетям города), иначе — только эти: пустой массив означает «ни одной», а не
     * «все», иначе пустой выбор в UI означал бы опрос всего подряд.
     *
     * Прерывание идёт только при РЕАЛЬНОМ изменении выбора: `stores:set`
     * прилетает на каждое изменение состояния, включая само монтирование
     * приложения, и безусловная отмена сорвала бы автоопрос на старте.
     */
    setCurrentStores: (pointKeys: string[] | null) => {
      // Сети без адаптера отбрасываются ЗДЕСЬ, а не только в интерфейсе: ядро
      // знает свои адаптеры точнее, чем оболочка, и только так выбор не
      // «прыгает» на первом кадре (интерфейс сначала шлёт все точки города,
      // потом — отфильтрованные; без фильтрации здесь это выглядело бы как
      // смена выбора и прерывало бы идущий опрос).
      const filtered =
        pointKeys === null
          ? null
          : pointKeys.filter((key) => {
              const storeId = key.slice(0, key.indexOf(':'));
              return adapters.has(storeId);
            });
      // Порядок галочек в массиве не имеет значения для опроса, но имеет — для
      // сравнения: иначе перестановка того же выбора рвала бы идущий прогон.
      const next = filtered === null ? null : [...filtered].sort();
      const previous = currentPoints === null ? null : [...currentPoints].sort();
      const same =
        (next === null && previous === null) ||
        (next !== null &&
          previous !== null &&
          next.length === previous.length &&
          next.every((id, i) => id === previous[i]));
      currentPoints = next;
      if (!same) stopRunningPoll('выбор магазинов изменился');
    },
  checkTargets,
  // Только для тестов ядра: тот же markNotified, что зовёт опрос, но без
  // рассылки уведомлений. В проде недостижимо — оболочка наружу не отдаёт.
  markNotifiedForTest: async (rows: (PriceKey & { price: number })[]) =>
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
  runScheduler: async (args?: { city?: string; pointKeys?: string[] }) => {
    if (state.running) {
      return { status: { ...state }, summary: 'Опрос уже идёт — дождись завершения.' };
    }
    // pointKeys передаются явно: кнопка «Опросить сейчас» может быть нажата раньше,
    // чем эффект отправит выбор отдельным вызовом, и молча ушёл бы опрос по всем
    // сетям города.
    // Сводка берётся из самого прохода: ветки «пропущен/отложен» объясняют
    // себя СВОИМ текстом, и возвращать вместо него общий pollSummary() значило
    // бы показать пользователю «проверено 0» вместо причины пропуска.
    const summary = await runScheduled({
      ...(args?.city ? { city: args.city } : {}),
      ...(args?.pointKeys === undefined ? {} : { pointKeys: args.pointKeys }),
      force: true,
    });
return { status: { ...state }, summary };
  },
  /**
   * Остановить идущий опрос. `false` — идти нечего (прогон уже закончился или
   * не начинался): кнопка могла остаться нажатой после завершения, и «я
   * остановил» на пустом месте было бы враньём в интерфейсе.
   */
  cancelScheduler: (): boolean => {
    if (!state.running) return false;
    stopRunningPoll('пользователь нажал «Прервать»');
    return true;
  },
  saveAll,
  startScheduler,
};
}