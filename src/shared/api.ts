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
  /**
   * Код точки, к которой относится этот блок. Обязателен: у одной сети в
   * городе может быть несколько точек, и без кода два блока неразличимы —
   * интерфейс склеил бы их в один и показал бы две строки с одинаковым ключом.
   * Пока точка на город одна, поле просто повторяет код справочника.
   */
  storeCode: string;
  name: string;
  ready: boolean;
  items: ScrapedProduct[];
  error?: string;
  /** Данные из локального кэша, а не из живой сети. */
  cached?: boolean;
}

export interface StoreCatalog {
  storeId: string;
  /**
   * Код точки. Блок каталога — это ТОЧКА (справочник отдаёт блок на каждую),
   * и без кода две точки одной сети получили бы одинаковый React-ключ и общее
   * состояние раскрытия.
   */
  storeCode: string;
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
  counts: {
    inserted: number;
    skipped: number;
    failed: number;
    notReady: number;
    /**
     * Магазины, которые сеть перестала обновлять (протухший прайс точки). Сеть
     * при этом жива, поэтому они отделены от сетевых сбоев: по ним цены
     * заморожены, и пользователь должен видеть это в сводке опроса.
     */
    staleStores: string[];
    /**
     * Прогон прерван по просьбе пользователя (снял галочку или сменил город).
     * Renderer обязан показать это иначе, чем успех: баннер «Опрос завершён» был бы
     * зелёным при незакрытом цикле города.
     */
    interrupted: boolean;
    /** Сколько целей осталось в цикле после этого прогона. */
    remaining: number;
  };
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
 * Отметка «избранное» на конкретное предложение (товар + магазин + город +
 * точка). targetPrice — порог уведомления; null означает просто отметку без
 * порога.
 *
 * storeCode обязателен и здесь: без него отметка точки А неотличима от отметки
 * точки Б той же сети в том же городе — и интерфейс не смог бы ни показать,
 * ни снять правильную.
 */
export interface Favorite {
  canonicalId: string;
  storeId: string;
  city: string;
  storeCode: string;
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
  /**
   * Код точки. Раскладка привязана к полке конкретного магазина, и без кода
   * отметка точки А всплыла бы в выдаче точки Б.
   *
   * Обязателен: раньше ядро подставляло «первую готовую точку сети», и стоило
   * добавить в город вторую точку — всё избранное и раскладки молча переехали
   * бы на неё. Точку называет тот, кто показывает товар: список цен, отметка,
   * карточка — во всех трёх код известен из ответа сети.
   */
  storeCode: string;
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
  /**
   * Сети, для которых в этой сборке есть адаптер. На десктопе — все шесть,
   * на Android — три (там нет браузера). Интерфейс считает по этому списку
   * доступные точки, иначе обещает опрос сетей, которых в сборке нет.
   */
  getSupportedNetworks: () => Promise<string[]>;
  /**
   * Установка браузера для Пятёрки, Чижика и Перекрёстка. Firefox не вшит в
   * установщик (это было бы около 340 МБ из 210 МБ сборки), поэтому ставится
   * по требованию — пользователь сам решает, нужны ли ему эти сети.
   */
  /** Скачать обновление. Скачивание идёт только по клику пользователя. */
  downloadUpdate: () => Promise<void>;
  installBrowser: () => Promise<{ ok: boolean; message: string }>;
  /** Готов ли браузер и где он лежит. */
  browserStatus: () => Promise<{ installed: boolean; message: string }>;
  getCategory: (args: { city?: string; url?: string }) => Promise<StorePrices[]>;
  getOurCategories: (args: { city?: string }) => Promise<OurCategoryInfo[]>;
  getOurCategory: (args: { city?: string; id?: string }) => Promise<StorePrices[]>;
  getShelves: (args: ShelfScope) => Promise<ProductShelves>;
  setShelves: (args: ShelfScope & { categoryIds: string[] }) => Promise<ProductShelves>;
  releaseShelves: (args: ShelfScope) => Promise<ProductShelves>;
  /**
   * История цены конкретной точки. storeCode обязателен: кривые двух точек
   * одной сети в одном городе — разные графики, и без кода интерфейс показал
   * бы историю той точки, чью строку случайно нашёл в базе.
   */
  getHistory: (args: { canonicalId: string; storeId: string; city: string; storeCode: string }) => Promise<HistoryPoint[]>;
  /** Избранное города: текущая цена каждой отмеченной точки. */
  getFavorites: (args: { city: string }) => Promise<Favorite[]>;
  /** Отметить или снять; targetPrice = null оставляет прежний порог. */
  setFavorite: (args: ShelfScope & { targetPrice: number | null }) => Promise<Favorite[]>;
  removeFavorite: (args: ShelfScope) => Promise<Favorite[]>;
  /**
   * Пометить пару как разные товары. Без города: canonicalId несёт префикс
   * сети (5ka-/magnit-/lenta-/svt-), товар не city-scoped, и «это разные товары»
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
  runScheduler: (args?: { city?: string; pointKeys?: string[] }) => Promise<SchedulerDone>;
  /**
   * Прервать идущий опрос. Отмена кооперативная: останавливается на границе
   * товара, уже начатый запрос у браузерных сетей доживает. alse — идти нечего.
   */
  cancelScheduler: () => Promise<boolean>;
  /** Сообщить ядру выбранный город: автоопрос бьёт только по нему. */
  setCurrentCity: (city: string) => Promise<void>;
  /**
 * Выбор ТОЧЕК города: ключи `storeId:storeCode` из `pointKeysForCity`.
 *
 * Опрос бьёт только по ним. null — «выбор не сделан» и тогда опрос идёт по всем
 * точкам города; пустой массив — «нечего опрашивать» (так выглядит снятие всех
 * галочек, и это не то же самое, что «выбор не сделан»).
 */
setCurrentStores: (city: string, pointKeys: string[] | null) => Promise<void>;
  onSchedulerProgress: (
    cb: (done: number, total: number, storeId?: string, storeCode?: string) => void,
  ) => () => void;
  onSchedulerDone: (cb: (done: SchedulerDone) => void) => () => void;
  checkUpdates: () => Promise<UpdateCheck>;
  installUpdate: () => Promise<void>;
  onUpdateEvent: (cb: (kind: string, payload: unknown) => void) => () => void;
}
