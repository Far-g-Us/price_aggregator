/**
 * Порт «читалки страниц»: оболочка открывает адрес КАК СТРАНИЦУ и отдаёт текст
 * тела. Нужен Пятёрке на Android: нативный HTTP X5 режет WAF'ом даже с
 * браузерными куками (Измерение 5, .agent/gecko/evidence.md), а страница,
 * открытая в WebView, выполняется в настоящем браузерном контексте — тот же
 * приём «открыть адрес и прочитать», что у десктопного транспорта
 * (`5ka-browser.ts`), только вместо перехвата ответа — DOM.
 *
 * Почему загрузчик регистрирует ОБОЛОЧКА, а не этот файл: единственная живая
 * реализация — Java-плагин поверх скрытого WebView, и она есть только в
 * Android-мосте (`src/renderer/android/bootstrap.ts`). Electron этот порт не
 * регистрирует: там транспорт страниц не нужен, браузеры поднимаются через
 * `playwright-port.ts`. Незарегистрированный порт обязан падать громко и
 * объяснять причину: «сеть молчит» и «транспорта нет в этой сборке» для
 * пользователя — разные вещи (см. playwright-port).
 */

export interface PageReader {
  /** Живый мост без страницы: дешёвый вызов для регистрации адаптера. */
  probe(): Promise<string>;
  /**
   * Текст тела страницы. Для адресов API это сам JSON: навигацию делает
   * WebView (свои куки, свои подписи антифрода), мы только читаем DOM.
   */
  readPage(opts: { url: string }): Promise<string>;
  /**
   * `#__NEXT_DATA__` со страницы и найденный в нём товар по plu.
   * Ответ — JSON-строка {ok, reason?, codes, product?}: SPA дописывает стор
   * ПОСЛЕ открытия документа, поэтому ожидание живёт внутри реализации
   * порта (поллинг DOM, сеть это не трогает), а не в адаптере.
   */
  readNextData(opts: { url: string; plu: string }): Promise<string>;
  /**
   * Навигация на адрес сети: ставит антибот-куки в общий браузерный jar.
   * Успех = страница загрузилась (WAF-челлендж сам перезагружается).
   */
  warmup(opts: { url: string }): Promise<void>;
  /**
   * POST/GET из контекста страницы-донора (Фаза 7г: Перекрёсток, фолбэк
   * Чижика). Страница оседает только настоящей (порог длины), in-page JS
   * сам читает креды и стреляет подписанный fetch того же происхождения.
   * Реализация есть ТОЛЬКО у Android-моста: запрос через этот порт в
   * Electron — деградация, и ростер обязан проверять наличие метода.
   */
  post?(opts: {
    pageUrl: string;
    apiUrl: string;
    bodyJson?: string;
    httpMethod?: string;
  }): Promise<{ status: number; body: string; href?: string }>;
}

let injected: PageReader | null = null;
let loader: (() => Promise<PageReader>) | null = null;

/** Подмена для тестов; побеждает загрузчик (см. playwright-port). */
export function __setPageReaderForTests(reader: PageReader | null): void {
  injected = reader;
}

export function injectedPageReader(): PageReader | null {
  return injected;
}

/**
 * Регистрация настоящего моста. Зовёт ТОЛЬКО Android-оболочка; Electron этого
 * не делает намеренно — «страница-читалка» там не транспорт, а дубль Playwright.
 */
export function setPageReaderLoader(fn: (() => Promise<PageReader>) | null): void {
  loader = fn;
}

export async function loadPageReader(): Promise<PageReader> {
  if (injected !== null) return injected;
  if (loader === null) {
    throw new Error(
      'чтение страниц недоступно в этой сборке: транспорт страниц есть только на Android, где Пятёрка читается из скрытого WebView',
    );
  }
  try {
    return await loader();
  } catch (err) {
    throw new Error(`не удалось поднять чтение страниц: ${String(err).slice(0, 120)}`);
  }
}
