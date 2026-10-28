// Зонды Фазы 7г: прямые вызовы нативного PageReader через CDP-мост WebView —
// то же, что PA_ANDROID_PROBE-пробы live-android.ts, отдельным скриптом со
// своей семантикой кода выхода (live-скрипт семантически завязан на
// Пятёрочку, перегружать его нельзя — ROADMAP Фазы 7г).
//
//   npx tsx scripts/probe-android-page.ts chizhik-search HD87
//   npx tsx scripts/probe-android-page.ts chizhik-shop HD87
//   npx tsx scripts/probe-android-page.ts chizhik-shoppage HD87
//   npx tsx scripts/probe-android-page.ts perekrestok-catalog
//   npx tsx scripts/probe-android-page.ts perekrestok-cookies
//   npx tsx scripts/probe-android-page.ts perekrestok-spin
//   npx tsx scripts/probe-android-page.ts perekrestok-post
//
// Эмулятор/телефон запущены, свежий APK с allowlist 7г установлен,
// приложение открыто. Каждый шаг открывает ровно одну страницу, гэп 2с
// держит сам плагин; шаги звать с паузами, не «долбить» WAF.
//
// Токен и `_SPUID` в печать не идут: у значений — только названия и длины.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ADB = join(
  process.env['LOCALAPPDATA'] ?? '',
  'Android',
  'Sdk',
  'platform-tools',
  'adb.exe',
);

const CHIZHIK = 'https://app.chizhik.club';
const PEREKRESTOK = 'https://www.perekrestok.ru';

const step = process.argv[2] ?? '';
const storeCode = process.argv[3] ?? '';

const adb = (args: string[]): string => execFileSync(ADB, args, { encoding: 'utf8' });

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

function die(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const devices = adb(['devices', '-l']).split('\n');
const device = devices
  .map((line) => line.trim())
  .map((line) => /^(?<id>\S+)\s+device\b/.exec(line)?.groups?.['id'])
  .find((id) => typeof id === 'string');
if (!device) die('устройств нет: подними эмулятор (vktest) или подключи телефон по adb');

const unix = adb(['-s', device, 'shell', 'cat', '/proc/net/unix']);
const socket = unix
  .split('\n')
  .map((line) => line.trim().split(/\s+/).slice(-1)[0] ?? '')
  .map((name) => (name.startsWith('@') ? name.slice(1) : name))
  .find((name) => name.startsWith('webview_devtools_remote_'));
if (!socket) die('мост WebView не найден — приложение запущено?');
adb(['-s', device, 'forward', 'tcp:9222', `localabstract:${socket}`]);

let targets: Target[] = [];
try {
  targets = (await (await fetch('http://127.0.0.1:9222/json')).json()) as Target[];
} catch {
  die('список целей CDP не открылся');
}
const target = targets.find((t) => t.type === 'page' && !t.url.startsWith('about:'));
if (!target) die('страница приложения не видна через CDP');
console.log(`страница: ${target.url}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error('диалог с WebView не открылся'));
});

let sequence = 0;
const waiters = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
ws.onmessage = (event: MessageEvent) => {
  const msg = JSON.parse(String(event.data)) as {
    id?: number;
    result?: {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
  };
  if (msg.id === undefined) return;
  const waiter = waiters.get(msg.id);
  if (!waiter) return;
  waiters.delete(msg.id);
  const details = msg.result?.exceptionDetails;
  if (details) {
    const origin = details.exception?.description ?? '';
    waiter.reject(new Error(`${details.text ?? 'ошибка в WebView'} ${origin}`.trim()));
    return;
  }
  waiter.resolve(msg.result?.result?.value ?? null);
};
ws.onclose = () => {
  for (const waiter of waiters.values()) waiter.reject(new Error('диалог закрыт'));
  waiters.clear();
};

const call = <R>(expr: string, timeoutMs = 600000): Promise<R> => {
  const id = ++sequence;
  const expression =
    '(async () => { ' +
    'const api = window.api; ' +
    "if (!api) throw new Error('api не смонтирован'); " +
    `return await (${expr}); ` +
    '})()';
  ws.send(
    JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }),
  );
  return new Promise<R>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`cdp: «${expr.slice(0, 40)}» не ответил`));
    }, timeoutMs);
    waiters.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value as R);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
};

/** Хелпер времени для сюжета «readPage в фоне, target глянем пока жив». */
const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

interface PageReader {
  plugin(method: string, args: Record<string, string>): Promise<Record<string, unknown> | null>;
}

const reader: PageReader = {
  async plugin(method, args) {
    return call<Record<string, unknown> | null>(
      `window.Capacitor?.Plugins?.PageReader?.${method}(${JSON.stringify(args)})` +
        '.then((r) => (r ?? null))' +
        '.catch((e) => { throw new Error("плагин: " + String(e).slice(0, 160)); })',
    );
  },
};

function chizhikShopUrl(sap: string): string {
  return `${CHIZHIK}/shop/${sap}`;
}

function chizhikSearchUrl(sap: string): string {
  return (
    `${CHIZHIK}/delivery/api/catalog/v3/stores/${sap}` +
    `/search?mode=delivery&include_restrict=true&limit=48&q=${encodeURIComponent('молоко')}`
  );
}

function printTextBody(label: string, raw: string): void {
  console.log(`readPage ${label}: ${raw.length} символов`);
  console.log(`начало: ${raw.slice(0, 1400)}`);
}

function chizhikVerdict(raw: string): void {
  let productsLen = -1;
  try {
    const parsed = JSON.parse(raw) as { products?: unknown } | null;
    productsLen = Array.isArray(parsed?.products) ? parsed.products.length : -1;
  } catch {
    productsLen = -1;
  }
  if (productsLen >= 0) {
    console.log(`SUCCESS: JSON c массивом products на ${productsLen}`);
    return;
  }
  console.log('FAIL: тело не JSON c products (смотреть «начало» выше)');
}

async function runChizhikSearch(sap: string): Promise<void> {
  const result = await reader.plugin('readPage', { url: chizhikSearchUrl(sap) });
  const raw = typeof result?.text === 'string' ? result.text : '';
  printTextBody('search API', raw);
  chizhikVerdict(raw);
}

async function stepChizhikSearch(sap: string): Promise<void> {
  await runChizhikSearch(sap);
}

async function stepChizhikShop(sap: string): Promise<void> {
  await reader.plugin('warmup', { url: `${CHIZHIK}/shop/${sap}` });
  console.log(`warmup страницы магазина ${sap} закрылся`);
  await runChizhikSearch(sap);
}

/** Одиночная страница магазина (не warmup): тело печати — оседает ли WAF. */
async function stepChizhikShopPage(sap: string): Promise<void> {
  const result = await reader.plugin('readPage', { url: chizhikShopUrl(sap) });
  const raw = typeof result?.text === 'string' ? result.text : '';
  printTextBody('страница магазина', raw.slice(0, 2000));
  const stub = raw.includes('Проблемы со связью') || raw.includes('request id');
  const empty = raw.trim().length === 0;
  console.log(
    empty
      ? 'FAIL: тело пустое'
      : stub
        ? 'FAIL: заглушка X5 WAF на самой странице магазина'
        : `страница магазина осела как страничная DOM (${raw.length} символов)`,
  );
}

async function stepPerekrestokCatalog(): Promise<void> {
  const result = await reader.plugin('readPage', { url: `${PEREKRESTOK}/catalog/` });
  const raw = typeof result?.text === 'string' ? result.text : '';
  printTextBody('страница каталога', raw);
  console.log(
    raw.length === 0
      ? 'FAIL: тело пустое — проверить шаг ещё раз после паузы'
      : 'осело с непустым телом (детали — в «начале»)',
  );
}

/** Полный цикл пост-метода: донор (оседание страницы) + один POST в feed.
 * Второй аргумент — путь донора (по умолчанию /catalog/; «/» — другая
 * страница той же сети, если каталог под сульком антибота). */
async function stepPerekrestokPost(): Promise<void> {
  const donorPath = /^\//.test(storeCode) ? storeCode : '/catalog/';
  const started = Date.now();
  const result = await reader.plugin('post', {
    pageUrl: `${PEREKRESTOK}${donorPath}`,
    apiUrl:
      `${PEREKRESTOK}/api/customer/1.4.1.0/catalog/product/feed`,
    bodyJson: JSON.stringify({ page: 1, perPage: 100, filter: { textQuery: 'молоко' } }),
  });
  const elapsed = (Date.now() - started) / 1000;
  const status = typeof result?.status === 'number' ? result.status : -1;
  const body = typeof result?.body === 'string' ? result.body : '';
  const href = typeof result?.href === 'string' ? result.href : '';
  console.log(`полный цикл: ${elapsed.toFixed(1)} с, статус ${status}, тело ${body.length} символов`);
  console.log(`href донора: ${href}`);
  try {
    const parsed = JSON.parse(body) as { content?: { items?: unknown[]; sapId?: unknown } } | null;
    const items = parsed?.content?.items;
    if (Array.isArray(items)) {
      console.log(
        `SUCCESS: JSON c массивом items на ${items.length}, sapId ${JSON.stringify(parsed?.content?.sapId)}`,
      );
      return;
    }
    console.log(`FAIL: JSON без content.items (начало: ${body.slice(0, 600)})`);
  } catch {
    console.log(`FAIL: тело не JSON (начало: ${body.slice(0, 600)})`);
  }
}

async function stepPerekrestokCookies(): Promise<void> {
  const result = await reader.plugin('readCookies', { url: PEREKRESTOK });
  const raw = typeof result?.cookie === 'string' ? result.cookie : '';
  if (raw === '') {
    console.log('куки в jar нет вовсе (none)');
    return;
  }
  const names = raw
    .split(';')
    .map((piece) => piece.slice(0, Math.max(0, piece.indexOf('='))).trim())
    .filter((name) => name !== '');
  console.log(`куки в jar (только имена): ${names.join(', ')}`);
  const sessionPiece = raw
    .split(';')
    .map((piece) => piece.trim())
    .find((piece) => piece.startsWith('session='));
  if (!sessionPiece) {
    console.log('куки session в jar НЕТ');
    return;
  }
  const sessionValue = sessionPiece.slice('session='.length);
  let tokenLen = 0;
  let parses = false;
  try {
    const parsed = JSON.parse(decodeURIComponent(sessionValue)) as { accessToken?: unknown };
    parses = true;
    tokenLen = typeof parsed.accessToken === 'string' ? parsed.accessToken.length : 0;
  } catch {
    parses = false;
  }
  console.log(
    parses
      ? `кука session есть, JSON парсится, accessToken длиной ${tokenLen} (значение не печатается)`
      : `кука session есть, но JSON не парсится (raw длина ${sessionValue.length})`,
  );
}

/** Оценка открытой страницы изнутри: только имена кук и длины значений,
 * без самих значений. */
const DOC_STATE_JS =
  '(function(){var c=document.cookie||"";' +
  'var parts=c.length?c.split(";"):[];' +
  'var names=parts.map(function(s){var i=s.indexOf("=");return i<0?s.trim():s.slice(0,i).trim()});' +
  'var lens=parts.map(function(s){var i=s.indexOf("=");return i<0?0:Math.max(0,s.length-i-1)});' +
  'var sp=String((typeof localStorage!=="undefined"&&localStorage.getItem)?(localStorage.getItem("_SPUID")||""):"");' +
  'var b=document.body;var bl=b?(b.textContent||"").length:0;' +
  'return JSON.stringify({ready:document.readyState,href:location.href,cookieNames:names,cookieLens:lens,spuidLen:sp.length,documentSession:/(^|;\\s*)session=/.test(c),bodyLen:bl})})()';

interface CdpMsg {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  error?: { message?: string };
}

/** Долгая CDP-сессия с целью: периодический eval состояния + подписка
 * на консоль, статусы ответов и обрывы сети. Переживает навигацию
 * (челлендж перезагружает документ в том же target). */
class CdpSession {
  private ws: WebSocket;
  private seq = 0;
  private waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  private closed = false;
  readonly consoleLines: string[] = [];
  readonly badResponses: string[] = [];
  readonly failedRequests: string[] = [];

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ws.onmessage = (event: MessageEvent) => {
      const msg = JSON.parse(String(event.data)) as CdpMsg;
      if (msg.id !== undefined && this.waiting.has(msg.id)) {
        const entry = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (entry === undefined) return;
        if (msg.error) entry.fail(new Error(msg.error.message ?? 'cdp-ошибка'));
        else entry.ok(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const p = (msg.params ?? {}) as {
          type?: string;
          args?: { value?: unknown; description?: string }[];
        };
        const text = (p.args ?? [])
          .map((a) => String(a.value ?? a.description ?? ''))
          .join(' ');
        this.consoleLines.push(`${p.type ?? 'log'}: ${text.slice(0, 220)}`);
      } else if (msg.method === 'Log.entryAdded') {
        const p = (msg.params ?? {}) as { entry?: { level?: string; text?: string; url?: string } };
        const e = p.entry ?? {};
        const where = e.url ? ` (${e.url.slice(0, 120)})` : '';
        this.consoleLines.push(`${e.level ?? 'log'}: ${(e.text ?? '').slice(0, 220)}${where}`);
      } else if (msg.method === 'Network.responseReceived') {
        const p = (msg.params ?? {}) as {
          type?: string;
          response?: { status?: number; url?: string };
        };
        const r = p.response;
        if (r === undefined) return;
        if ((r.status ?? 0) >= 400 || p.type === 'Document') {
          this.badResponses.push(`HTTP ${r.status ?? '?'} ${p.type ?? '?'} ${(r.url ?? '').slice(0, 140)}`);
        }
      } else if (msg.method === 'Network.loadingFailed') {
        const p = (msg.params ?? {}) as { errorText?: string; type?: string };
        this.failedRequests.push(`обрыв ${p.type ?? '?'}: ${p.errorText ?? '?'}`);
      }
    };
    this.ws.onclose = () => {
      this.closed = true;
      for (const [, entry] of this.waiting) entry.fail(new Error('cdp-сессия закрыта'));
      this.waiting.clear();
    };
    this.ws.onerror = () => {
      this.closed = true;
    };
  }

  ready(): Promise<void> {
    return new Promise((ok, fail) => {
      if (this.ws.readyState === 1) {
        ok();
        return;
      }
      const timer = setTimeout(() => fail(new Error('cdp-сессия не открылась')), 10000);
      this.ws.onopen = () => {
        clearTimeout(timer);
        ok();
      };
      this.ws.onerror = () => {
        clearTimeout(timer);
        fail(new Error('cdp-сессия не открылась'));
      };
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed || this.ws.readyState !== 1) {
      return Promise.reject(new Error('cdp-сессия закрыта'));
    }
    const id = ++this.seq;
    return new Promise((ok, fail) => {
      this.waiting.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.has(id)) {
          this.waiting.delete(id);
          fail(new Error(`${method} не ответил`));
        }
      }, 15000);
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const result = (await this.send('Runtime.evaluate', { expression, returnByValue: true })) as
      | NonNullable<CdpMsg['result']>
      | undefined;
    if (result?.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.exception?.description?.slice(0, 120)
        ?? result.exceptionDetails.text ?? 'ошибка в документе');
    }
    return result?.result?.value as T;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* уже закрыта */
    }
  }
}

interface DocState {
  ready: string;
  href: string;
  cookieNames: string[];
  cookieLens: number[];
  spuidLen: number;
  documentSession: boolean;
  bodyLen: number;
}

/** Наблюдение за открытой страницей изнутри, пока readPage крутится в фоне:
 * оседает ли челлендж, меняется ли href, растёт ли тело. host — подстрока
 * адреса целевой страницы в списке CDP-таргетов. Хронология — снимок раз
 * в секунду, повторы схлопываются; CDP-сессия собирает консоль, ответы
 * со статусами и обрывы сети за весь цикл (включая перезагрузку челленджа). */
async function stepSpin(host: string, url: string): Promise<void> {
  const pending = reader
    .plugin('readPage', { url })
    .catch((err: unknown) => ({ text: `<<readPage отказ: ${String(err).slice(0, 140)}>>` }));
  const seen: string[] = [];
  let last: DocState | null = null;
  let session: CdpSession | null = null;
  for (let attempt = 0; attempt < 35; attempt += 1) {
    await sleep(1000);
    if (session === null) {
      let targets: Target[] = [];
      try {
        targets = (await (await fetch('http://127.0.0.1:9222/json')).json()) as Target[];
      } catch {
        continue;
      }
      const hit = targets.find(
        (candidate) => candidate.type === 'page' && candidate.url.includes(host),
      );
      if (!hit) continue;
      try {
        session = new CdpSession(hit.webSocketDebuggerUrl);
        await session.ready();
        await session.send('Runtime.enable');
        await session.send('Log.enable');
        await session.send('Network.enable');
      } catch (err: unknown) {
        const note = `cdp-сессия не открылась: ${String(err).slice(0, 100)}`;
        if (seen[seen.length - 1] !== note) seen.push(note);
        session = null;
      }
      continue;
    }
    try {
      const state = JSON.parse(await session.eval<string>(DOC_STATE_JS)) as DocState;
      last = state;
      const snapshot =
        `${state.ready} ${state.href} body=${state.bodyLen} ` +
        `куки=[${state.cookieNames.map((n, i) => `${n}:${state.cookieLens[i] ?? 0}`).join(',')}]`;
      if (seen[seen.length - 1] !== snapshot) seen.push(snapshot);
    } catch (err: unknown) {
      const note = `документ не отвечает: ${String(err).slice(0, 100)}`;
      if (seen[seen.length - 1] !== note) seen.push(note);
    }
  }
  const done = (await pending) as { text?: string } | null;
  for (const line of seen) console.log(`  ${line}`);
  if (session !== null) {
    if (session.badResponses.length > 0) {
      console.log('ответы (документы и статусы >= 400):');
      for (const line of session.badResponses.slice(0, 25)) console.log(`  ! ${line}`);
    }
    if (session.failedRequests.length > 0) {
      console.log('оборванные запросы:');
      for (const line of session.failedRequests.slice(0, 25)) console.log(`  ! ${line}`);
    }
    if (session.consoleLines.length > 0) {
      console.log('консоль/лог страницы:');
      for (const line of session.consoleLines.slice(0, 30)) console.log(`  ! ${line}`);
    }
    session.close();
  }
  if (last !== null) {
    console.log(
      `итог: ${last.ready}, ${last.href}; session в document.cookie: ` +
        `${last.documentSession ? 'ДА' : 'нет'}; _SPUID в localStorage: длина ${last.spuidLen}`,
    );
  } else {
    console.log('целевой target не появился — факт снимет пост-метод (in-page JS скажет сам)');
  }
  console.log(`readPage закрылась: ${done?.text?.length ?? 0} символов`);
}

async function stepPerekrestokSpin(): Promise<void> {
  await stepSpin('perekrestok.ru', `${PEREKRESTOK}/`);
}

async function stepChizhikSpin(sap: string): Promise<void> {
  await stepSpin('chizhik.club', `${CHIZHIK}/shop/${sap}`);
}

/** Отпечаток WebView изнутри любой открытой цели (localhost приложения):
 * UA, webdriver, WebGL-рендерер — то, что анти-бот движки фингерпринтят. */
const FINGERPRINT_JS =
  '(function(){' +
  'var out={ua:navigator.userAgent,webdriver:navigator.webdriver===true,' +
  'languages:(navigator.languages||[]).join(","),' +
  'plugins:(navigator.plugins&&navigator.plugins.length)||0};' +
  'try{var c=document.createElement("canvas");' +
  'var gl=c.getContext("webgl")||c.getContext("experimental-webgl");' +
  'if(gl){var dbg=gl.getExtension("WEBGL_debug_renderer_info");' +
  'out.glVendor=dbg?String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)):String(gl.getParameter(gl.VENDOR));' +
  'out.glRenderer=dbg?String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)):String(gl.getParameter(gl.RENDERER));}' +
  'else{out.glRenderer="нет webgl"}}catch(e){out.glRenderer="ошибка: "+String(e&&e.message)}' +
  'return JSON.stringify(out)})()';

async function stepFingerprint(): Promise<void> {
  const targets = (await (await fetch('http://127.0.0.1:9222/json')).json()) as Target[];
  const hit = targets.find((candidate) => candidate.type === 'page');
  if (!hit) {
    console.log('открытых целей нет');
    return;
  }
  const session = new CdpSession(hit.webSocketDebuggerUrl);
  await session.ready();
  const fp = JSON.parse(await session.eval<string>(FINGERPRINT_JS)) as Record<string, unknown>;
  console.log(`цель: ${hit.url}`);
  console.log(`UA: ${fp.ua}`);
  console.log(`webdriver: ${fp.webdriver}; languages: ${fp.languages}; plugins: ${fp.plugins}`);
  console.log(`WebGL vendor: ${fp.glVendor}; renderer: ${fp.glRenderer}`);
  session.close();
}

try {
  if (step === 'chizhik-search' && storeCode !== '') await stepChizhikSearch(storeCode);
  else if (step === 'chizhik-shop' && storeCode !== '') await stepChizhikShop(storeCode);
  else if (step === 'chizhik-shoppage' && storeCode !== '') await stepChizhikShopPage(storeCode);
  else if (step === 'perekrestok-catalog') await stepPerekrestokCatalog();
  else if (step === 'perekrestok-cookies') await stepPerekrestokCookies();
  else if (step === 'perekrestok-spin') await stepPerekrestokSpin();
  else if (step === 'chizhik-spin' && storeCode !== '') await stepChizhikSpin(storeCode);
  else if (step === 'perekrestok-post') await stepPerekrestokPost();
  else if (step === 'fingerprint') await stepFingerprint();
  else if (step === 'eval') {
    const expr = storeCode === '' ? '1+1' : storeCode;
    const result = await call<unknown>(expr, 600000);
    console.log(typeof result === 'string' ? result : JSON.stringify(result));
  }
  else {
    console.error(
      `неизвестный шаг «${step}»: chizhik-search/chizhik-shop/chizhik-shoppage/chizhik-spin <sap>, ` +
        'perekrestok-catalog, perekrestok-cookies, perekrestok-spin, perekrestok-post, ' +
        'fingerprint, eval <js>',
    );
    process.exit(2);
  }
  ws.close();
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
