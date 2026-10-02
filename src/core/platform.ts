// Порты платформы: что ядру нужно от оболочки. Реализации —
// electron/node-platform.ts (fs, app, Notification, setInterval) и, позже,
// нативные для Android. В ядре не остаётся ни одного импорта Electron/node:fs,
// поэтому оно запускается и под тестом, и во второй оболочке.

/** Хранилище бинарника БД. Ядро не знает, файл это или файл в андроидных prefs. */
export interface AppStorage {
  readDb(): Uint8Array | null;
  writeDb(bytes: Uint8Array): void;
}

/** Текстовые файлы ядра (сейчас — кэш витринных категорий). */
export interface JsonStore {
  read(name: string): string | null;
  write(name: string, text: string): void;
}

/** То, что умеет только оболочка: версия, уведомление, внешняя ссылка. */
export interface AppShell {
  version(): string;
  notify(text: string): void;
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
}

export function memoryStorage(): AppStorage & { dump(): Uint8Array | null } {
  let bytes: Uint8Array | null = null;
  return {
    readDb: () => bytes,
    writeDb: (b) => {
      bytes = b;
    },
    dump: () => bytes,
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
 */
export function readEnvFlag(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}
