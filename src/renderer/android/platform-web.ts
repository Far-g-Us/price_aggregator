/**
 * Порты ядра для Android-оболочки (Capacitor, WebView).
 *
 * Ядро то же самое, что на Electron, — меняются только четыре порта. Здесь они
 * реализованы поверх того, что есть в WebView: IndexedDB для бинарника БД,
 * localStorage для кэша витринных категорий, таймеры вместо фоновых задач.
 *
 * Почему не «просто IndexedDB»: `AppStorage` СИНХРОННЫЙ (`readDb()` возвращает
 * `Uint8Array | null`), а IndexedDB отвечает только промисами. Поэтому бинарник
 * читается ОДИН раз в `openAsync` до создания ядра, дальше отдаётся из памяти,
 * а запись буферизуется и сливается асинхронно.
 */

import { consoleLogger } from '../../core/platform.js';
import type { AppStorage, AppShell, BackgroundTasks, JsonStore } from '../../core/platform.js';

const DB_KEY = 'pa.db';
const BACKUP_KEY = 'pa.db.backup';

interface StoredBlob {
  bytes: ArrayBuffer;
  at: number;
}

const readStore = (idb: IDBDatabase, key: string): Promise<StoredBlob | null> =>
  new Promise((resolve, reject) => {
    const tx = idb.transaction('files', 'readonly');
    const req = tx.objectStore('files').get(key);
    req.onsuccess = () => {
      const v = req.result as { bytes?: ArrayBuffer; at?: number } | undefined;
      resolve(v && v.bytes ? { bytes: v.bytes, at: v.at ?? 0 } : null);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB: чтение не удалось'));
  });

const writeStore = (idb: IDBDatabase, key: string, bytes: Uint8Array): Promise<void> =>
  new Promise((resolve, reject) => {
    const tx = idb.transaction('files', 'readwrite');
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    tx.objectStore('files').put({ bytes: buf, at: Date.now() }, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB: запись не удалась'));
  });

export const openIdb = (name = 'pa-files'): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('files')) req.result.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB: открытие не удалось'));
  });

/**
 * Синхронный порт поверх прочитанного блоба.
 *
 * Отложенный сброс ограничен СРОКОМ, а не только дебаунсом: Android душит
 * таймеры в фоне, и обычный `setTimeout` мог бы не сработать никогда — то есть
 * последние записанные цены просто потерялись бы. Поэтому дублируются три
 * ручки: потолок ожидания, `visibilitychange`/`pagehide` и явный `flush()`
 * (его зовёт оболочка при своём `saveAll`).
 */
export const createWebStorage = (idb: IDBDatabase, wasmUrl: string, flushMs = 1500): AppStorage & {
  flush: () => Promise<void>;
} => {
  let current: Uint8Array | null = null;
  let pending: Uint8Array | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const drain = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const bytes = pending;
    if (bytes === null) return;
    pending = null;
    writing = writing
      .then(() => writeStore(idb, DB_KEY, bytes))
      .catch((err: unknown) => {
        // Молчание здесь опаснее, чем на Electron: там сбой записи ловит
        // `saveAll` и пишет в лог, а сводка опроса считает провал БД. Здесь
        // ошибка уходит в консоль, иначе цены просто перестали бы сохраняться
        // «тихо», а интерфейс показывал бы зелёный прогон.
        consoleLogger.error('android: запись базы не удалась', String(err).slice(0, 200));
      });
    await writing;
  };

  const schedule = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => void drain(), flushMs);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void drain();
  });
  window.addEventListener('pagehide', () => void drain());

  return {
    wasmUrl,
    readDb: () => current,
    writeDb: (bytes) => {
      current = bytes;
      // Копия: контракт writeDb не обещает, что оболочка владеет памятью буфера,
      // а держать его полторы секунды после записи — значит рисковать тихой порчей БД.
      pending = bytes.slice();
      schedule();
    },
    backupDb: (bytes) => {
      // Копия миграции идёт в ОТДЕЛЬНОЕ хранилище: иначе откат версии
      // перезаписал бы то, что он и должен был сохранить.
      void writeStore(idb, BACKUP_KEY, bytes).catch(() => undefined);
    },
    flush: drain,
  };
};

/** Асинхронная часть порта: читает блоб до создания ядра. */
export const loadWebStorage = async (idb: IDBDatabase, wasmUrl: string): Promise<
  AppStorage & { flush: () => Promise<void> }
> => {
  const stored = await readStore(idb, DB_KEY);
  const store = createWebStorage(idb, wasmUrl);
  if (stored) store.writeDb(new Uint8Array(stored.bytes));
  return store;
};

/** Кэш витринных категорий: localStorage хватает (десятки килобайт). */
export const createWebJson = (): JsonStore => ({
  read: (name) => {
    try {
      return localStorage.getItem(`pa.${name}`);
    } catch {
      return null;
    }
  },
  write: (name, text) => {
    try {
      localStorage.setItem(`pa.${name}`, text);
    } catch {
      // Квота origin на Android — единицы мегабайт, а каталоги сетей тянут
      // десятки килобайт. Если квота всё же исчерпана, кэш просто не
      // обновится: следующий заход в сеть его наполнит заново. Терять данные
      // из-за кэша было бы хуже, чем молча его не записать.
    }
  },
});

/** Таймеры вместо фоновых задач: планировщик живёт, пока открыто приложение. */
export const createWebBackground = (): BackgroundTasks => ({
  every: (ms, task) => {
    setInterval(task, ms);
  },
  after: (ms, task) => {
    setTimeout(task, ms);
  },
});

/**
 * Уведомления: липкая очередь баннеров вместо системной ленты.
 *
 * Почему не системные: локальное уведомление без фонового сервиса приходит
 * только пока приложение открыто, а плагина в проекте нет. Но молчать тоже
 * нельзя — порог сработавшего товара пользователь обязан увидеть, иначе он не
 * знает, что цена упала.
 *
 * Доставка идёт событием `pa:notify` в окне: интерфейс подписывается в своём
 * эффекте. Раньше здесь был метод `onNotify`, который никто не звал, — то есть
 * `shell.notify()` уходил в пустоту, а комментарий обещал обратное.
 */
export const NOTIFY_EVENT = 'pa:notify';

export const createWebShell = (
  version: string,
  openExternal: (url: string) => boolean | void,
): AppShell => ({
  version: () => version,
  notify: (text, actionUrl) => {
    window.dispatchEvent(new CustomEvent(NOTIFY_EVENT, { detail: { text, actionUrl } }));
  },
  openExternal: async (url) => {
    openExternal(url);
  },
});
