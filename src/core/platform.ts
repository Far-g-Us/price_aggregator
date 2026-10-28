// Порты платформы: что ядру нужно от оболочки. Реализации —
// electron/node-platform.ts (fs, app, Notification, setInterval) и, позже,
// нативные для Android. В ядре не остаётся ни одного импорта Electron/node:fs,
// поэтому оно запускается и под тестом, и во второй оболочке.

/** Хранилище бинарника БД. Ядро не знает, файл это или файл в андроидных prefs. */
export interface AppStorage {
  readDb(): Uint8Array | null;
  writeDb(bytes: Uint8Array): void;
  /**
   * Копия бинарника БД перед разрушающей миграцией. Обязательна не для красоты:
   * откатить пересборку `prices_history` после первой же записи нечем, а
   * откат версии без отката БД невозможен. Вызывается ровно один раз — перед
   * первой пересборкой.
   */
  backupDb(bytes: Uint8Array): void;
  /**
   * Где лежит `sql-wasm.wasm`.
   *
   * Нужен именно портом, а не константой: на Electron wasm лежит в
   * `node_modules`, и путь к нему знает только оболочка, а на Android это
   * отдельный ассет со своим хешем в имени. Без него `initSqlJs()` ищет wasm
   * рядом с документом и получает 404, то есть база не открывается вовсе.
   * Необязателен: тесты и файловая оболочка передают свой путь иным способом.
   */
  wasmUrl?: string;
}

/** Текстовые файлы ядра (сейчас — кэш витринных категорий). */
export interface JsonStore {
  read(name: string): string | null;
  write(name: string, text: string): void;
}

/** То, что умеет только оболочка: версия, уведомление, внешняя ссылка. */
export interface AppShell {
  version(): string;
  /** `actionUrl` — куда открывать кликом по уведомлению (страница релиза). */
  notify(text: string, actionUrl?: string): void;
  openExternal(url: string): Promise<void>;
}

/** Фоновые задачи. На Android это будет WorkManager, здесь — таймеры. */
export interface BackgroundTasks {
  every(ms: number, task: () => void): void;
  after(ms: number, task: () => void): void;
}

/** Лог ядра. electron-log в ядре недопустим: это импорт Electron. */
export interface CoreLogger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  /** Замеры и ход работы: без них «долго грузит» и «куда делось время» не найти. */
  info(...args: unknown[]): void;
}

/** События наружу (прогресс опроса, обновления) — оболочка сама решает, куда слать. */
export type CoreEventSink = (channel: string, payload: unknown) => void;

export interface CoreDeps {
  storage: AppStorage;
  json: JsonStore;
  shell: AppShell;
  background: BackgroundTasks;
  log: CoreLogger;
  adapters: Map<string, import('../shared/types.js').StoreAdapter>;
  emit?: CoreEventSink;
  /**
   * Закрыть браузеры сетей (Пятёрка, Чижик, Перекрёсток).
   *
   * Зачем: после прогона каждый открытый браузер — это отдельный процесс Firefox
   * с своим профилем и сотнями мегабайт памяти. Держать их до выхода из
   * приложения нельзя: сессии нужны только на время прогона, а следующий может
   * быть через шесть часов. Закрытие после прогона означает, что браузер
   * поднимется заново — это минута прогрева, но её и так платит первый заход.
   */
  closeBrowsers?: () => Promise<void>;
}

export function memoryStorage(): AppStorage & {
  dump(): Uint8Array | null;
  backups(): number;
  backupDump(): Uint8Array | null;
} {
  let bytes: Uint8Array | null = null;
  let backups = 0;
  let lastBackup: Uint8Array | null = null;
  return {
    readDb: () => bytes,
    writeDb: (b) => {
      bytes = b;
    },
    backupDb: (b) => {
      // Копия хранится ОТДЕЛЬНО: подмена содержимого базы на исходный файл
      // выдала бы в dump() старый файл вместо мигрированного, и проверка
      // «перенос состоялся» читала бы ровно то, что было до переноса.
      backups += 1;
      lastBackup = b;
    },
    dump: () => bytes,
    backups: () => backups,
    backupDump: () => lastBackup,
  };
}

export function memoryJsonStore(): JsonStore & { dump(): Record<string, string> } {
  const files = new Map<string, string>();
  return {
    read: (name) => files.get(name) ?? null,
    write: (name, text) => {
      files.set(name, text);
    },
    dump: () => Object.fromEntries(files),
  };
}

export const consoleLogger: CoreLogger = {
  error: (...args) => console.error(...args),
  warn: (...args) => console.warn(...args),
  info: (...args) => console.log(...args),
};

/**
 * Единственное место в ядре, где допустимо чтение окружения. В Android
 * `process` не существует, поэтому читаем его как опциональный глобал и
 * молча берём дефолт. Флаг — только для отладки/экспериментов
 * (PA5KA_HEADFUL=1, PA5KA_TRANSPORT=fetch), в рантайме приложения они не нужны.
 *
 * Кроме переменных окружения здесь же живёт опознание оболочки. Хендлы чужих
 * глобалов (`Capacitor`, его плагины) — не чтение окружения, они остаются в
 * модулях, которым они нужны.
 */
export function readEnvFlag(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

/**
 * Признак нативной оболочки Android. Мост `androidBridge` подставляет
 * Capacitor, и он есть всегда, когда приложение собрано под Android, — в отличие
 * от `Capacitor.Plugins`, который зависит ещё и от того, импортирован ли
 * `@capacitor/core`. Проверять надо именно мост: в веб-сборке Capacitor тоже
 * есть, но там его сетевой плагин — обычная обёртка над `fetch`, и наши
 * таймауты через него не проходят.
 */
export function isNativeShell(): boolean {
  return typeof (globalThis as { androidBridge?: unknown }).androidBridge !== 'undefined';
}
