// Запрос с гарантированным таймаутом в любой оболочке.
//
// Зачем отдельный файл: на десктопе и в браузере достаточно `fetch` с
// `AbortSignal.timeout`, но на Android WebView патченный Capacitor `fetch`
// таймаут в нативный слой не передаёт. GET после патча уходит в
// `handleCapacitorHttpRequest`, где соединение собирается вообще без таймаутов
// (единственные 30 с в `WebViewLocalServer` стоят в `handleProxyRequest` —
// это прокси HTML для live-reload, он тут ни при чём), и упирается только на
// наш `AbortSignal`, который доезжает лишь потому, что патч передаёт исходные
// `options` в web-fetch. POST так не спасается: он уходит в нативный вызов
// `CapacitorHttp` вовсе без таймаутов, и провисшее соединение держится
// бесконечно — опрос на телефоне встанет вместо того, чтобы упасть.
//
// Откат на web-fetch на нативной среде тут недопустим: там `fetch` — тот же
// патченный, второй POST ушёл бы в сеть без таймаута и без возможности
// отмениться. Лучше честная ошибка, которую посчитает защита сети, чем запрос,
// который нельзя прервать.

import { isNativeShell } from './platform.js';

/** Ответ плагина на Android: распарсенный JSON либо строка. Нам всегда нужен
 * текст — JSON разбирает сам адаптер, ровно как на десктопе. */
type NativeHttpResponse = {
  data: unknown;
  status: number;
  headers: Record<string, string>;
  url?: string;
};

type CapacitorHttpPlugin = {
  request(options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    responseType: 'text';
    connectTimeout: number;
    readTimeout: number;
    disableRedirects: boolean;
    data?: string;
  }): Promise<NativeHttpResponse>;
};

type CapacitorBridge = {
  Plugins?: { CapacitorHttp?: CapacitorHttpPlugin };
};

type HttpRequest = {
  /** По умолчанию GET — как и в `fetch`, чтобы вызовы чтения не писали лишнего. */
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
};

/**
 * Нативный плагин либо есть, либо нет. Объявление cookie-jar на Android не
 * требуется: обработчик собирает соединение из наших заголовков
 * (`connection.setRequestHeaders`) и cookie-jar не ведёт, так что наш явный
 * `Cookie:` магазина остаётся неприкосновенным. Подставляет нативный слой ровно
 * одну вещь, `User-Agent`, и только если мы его не шлём, а шлём — и Лента, и
 * Магнит.
 */
function nativeHttp(): CapacitorHttpPlugin | null {
  const bridge = (globalThis as { Capacitor?: CapacitorBridge }).Capacitor;
  const plugin = bridge?.Plugins?.CapacitorHttp as CapacitorHttpPlugin | undefined;
  // Проверяем именно наличие метода: расхождение версий или частичная
  // регистрация дали бы `plugin.request is not a function` вместо внятной
  // подсказки про конфиг, ради которой этот модуль и написан.
  return plugin && typeof plugin.request === 'function' ? plugin : null;
}

/**
 * Статусы, для которых конструктор `Response` запрещает тело. Capacitor с этим
 * отдельно возится в патче, а мы собираем ответ сами — без этой проверки
 * `new Response('', { status: 204 })` бросает TypeError и роняет запрос.
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Текст для собственного `Response`: натив может вернуть уже разобранный объект. */
function nativeBody(data: unknown): string {
  if (data == null) return '';
  return typeof data === 'string' ? data : JSON.stringify(data);
}

async function nativeFetch(
  url: string,
  init: HttpRequest,
  plugin: CapacitorHttpPlugin,
): Promise<Response> {
  const response = await plugin.request({
    url,
    method: init.method ?? 'GET',
    headers: init.headers,
    responseType: 'text',
    connectTimeout: init.timeoutMs,
    readTimeout: init.timeoutMs,
    // Десктоп шлёт `redirect: 'follow'`, и задаём это же явно. Дефолт у Java и
    // так «следовать», но полагаться на него нельзя: смена версии плагина или
    // явный флаг снесут молча. Разница с fetch остаётся одна и её не закрыть:
    // HttpURLConnection не ходит между протоколами, то есть редирект http→https
    // на телефоне станет 3xx там, где на десктопе был ответ.
    disableRedirects: false,
    ...(init.body === undefined ? {} : { data: init.body }),
  });
  const built = new Response(
    NULL_BODY_STATUSES.has(response.status) ? null : nativeBody(response.data),
    { status: response.status, headers: response.headers },
  );
  // Адрес ответа натив не отдаёт в конструктор, а сверка «тот ли магазин» в
  // Магните идёт по нему (`magnit.ts`). Свойство у Response — геттер на
  // прототипе, поэтому переопределение на экземпляре допустимо; так же делает
  // и сам патч Capacitor.
  if (response.url) Object.defineProperty(built, 'url', { value: response.url });
  return built;
}

/**
 * Потолок на запрос целиком. `connectTimeout` и `readTimeout` — это потолки на
 * подключение и на *каждое* чтение, а не на весь запрос: сервер, отдающий байт
 * каждые 20 секунд, держал бы опрос открытым бесконечно. На десктопе такой
 * случай закрывал `AbortSignal.timeout`, и нативный путь обязан вести себя так
 * же. Само нативное соединение при этом не рвётся — освобождается только
 * вызывающий, ровно как при отменённом GET.
 *
 * Форма ошибки тут своя, а на десктопе падает `DOMException` с именем
 * `TimeoutError`. Сводить их не стали: на десктопе эту ошибку видят и
 * разбирают существующие адаптеры. Новым адаптерам стоит смотреть на текст, а не
 * на класс ошибки.
 */
async function withDeadline(promise: Promise<Response>, timeoutMs: number): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<Response>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`http: превышено время запроса (${timeoutMs} мс)`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Запрос с обязательным таймаутом. Возвращает `Response`, поэтому на десктопе
 * поведение ровно прежнее, а на Android ответ приходит из нативного слоя с
 * настоящим разрывом соединения по таймауту.
 *
 * Правило: всякий прямой запрос обязан идти через `httpFetch` с явным
 * `timeoutMs` — иначе на Android POST потеряет таймаут вместе с возможностью
 * отмены, а GET лишится `res.url`, по которому Магнит сверяет магазин.
 */
export async function httpFetch(url: string, init: HttpRequest): Promise<Response> {
  if (isNativeShell()) {
    const plugin = nativeHttp();
    if (!plugin) {
      // Нативная среда без плагина означает, что в приложении не импортирован
      // `@capacitor/core` — именно он регистрирует плагины в
      // `Capacitor.Plugins` — либо нативный проект не синхронизирован
      // (`npx cap sync`). Флаг `plugins.CapacitorHttp.enabled` тут ни при чём:
      // он включает патч `window.fetch`, а мы зовём плагин напрямую.
      throw new Error(
        'http: Android без плагина CapacitorHttp — нужен импорт @capacitor/core ' +
          `и npx cap sync (${url})`,
      );
    }
    return withDeadline(nativeFetch(url, init, plugin), init.timeoutMs);
  }
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    signal: AbortSignal.timeout(init.timeoutMs),
    redirect: 'follow',
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}