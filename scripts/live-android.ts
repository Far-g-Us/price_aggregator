// Живая проверка Android-оболочки через CDP-мост WebView (verify Фазы 7в).
//
//   npx tsx scripts/live-android.ts [запрос] [город]
//
// Эмулятор должен быть запущен, свежий APK установлен и приложение открыто.
// Скрипт не тыкает в UI: он подключается к мосту отладки WebView (в debug-сборке
// Capacitor включает его сам) и зовёт window.api теми же вызовами, что и
// интерфейс приложения. Живая сеть, штатный UA, прод-плагин — именно то, что
// roadmap требует от verify и что юнит-тесты на моках покрыть не могут.
//
// Go-Playwright был отвергнут: его connectOverCDP включает браузерное
// управление контекстами, которое Android WebView не поддерживает
// («Browser context management is not supported»). Здесь CDP говорит
// напрямую: цель page + Runtime.evaluate через нативный WebSocket Node 22.
//
// Что печатает: живость моста (probe), списка сетей сборки, доступность
// wasm-ассета, каждый блок выдачи (готовность, товары, первая цена, ошибка,
// время). Код возврата 1 — Пятёрки нет в сборке (мост PageReader не ответил)
// либо Пятёрка не отдала живую выдачу: это и есть цель verify, остальные
// сети — просто отчёт.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ADB = join(
  process.env['LOCALAPPDATA'] ?? '',
  'Android',
  'Sdk',
  'platform-tools',
  'adb.exe',
);

const query = process.argv[2] ?? 'молоко';
const city = process.argv[3] ?? 'moscow';

const adb = (args: string[]): string => execFileSync(ADB, args, { encoding: 'utf8' });

try {
  const devices = adb(['devices', '-l']).split('\n');
  const device = devices
    .map((line) => line.trim())
    .map((line) => /^(?<id>\S+)\s+device\b/.exec(line)?.groups?.['id'])
    .find((id) => typeof id === 'string');
  if (!device) {
    throw new Error('устройств нет: подними эмулятор (vktest) или подключи телефон по adb');
  }

  const unix = adb(['-s', device, 'shell', 'cat', '/proc/net/unix']);
  const socket = unix
    .split('\n')
    .map((line) => line.trim().split(/\s+/).slice(-1)[0] ?? '')
    .map((name) => (name.startsWith('@') ? name.slice(1) : name))
    .find((name) => name.startsWith('webview_devtools_remote_'));
  if (!socket) throw new Error('мост WebView не найден — приложение запущено?');
  adb(['-s', device, 'forward', 'tcp:9222', `localabstract:${socket}`]);

  interface Target {
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
  }
  const targets = (await (await fetch('http://127.0.0.1:9222/json')).json()) as Target[];
  const target = targets.find((t) => t.type === 'page' && !t.url.startsWith('about:'));
  if (!target) throw new Error('страница приложения не видна через CDP');
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

  const call = <R>(expr: string): Promise<R> => {
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
      }, 600000);
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

  const ping = await call<string>('api.ping()');
  const version = await call<string>('api.getVersion()');
  const networks = await call<string[]>('api.getSupportedNetworks()');
  console.log(`оболочка: ${ping}, версия: ${version}`);
  console.log(`сети сборки: ${networks.join(', ')}`);

  const asset = await call<{
    ok: boolean;
    status: number | null;
    type: string | null;
    len: number | null;
  }>(
    `fetch(new URL('sql-wasm.wasm', window.location.href).href)
       .then((r) => r.arrayBuffer().then((b) => ({ ok: r.ok, status: r.status, type: r.headers.get('content-type'), len: b.byteLength })))
       .catch((e) => ({ ok: false, status: null, type: String(e).slice(0, 80), len: null }))`,
  );
  console.log(`ассет wasm: HTTP ${asset.status ?? '—'}, тип ${asset.type ?? '—'}, байт ${asset.len ?? '—'}`);

  if (!networks.includes('pyaterochka')) {
    throw new Error(
      'Пятёрки нет в сборке: probePageReader не дал согласия — мост не жив или плагина нет',
    );
  }

  interface Block {
    storeId: string;
    storeCode: string;
    ready: boolean;
    items: Array<{
      canonicalId: string;
      storeCode: string;
      name: string;
      price: number;
      promoPrice?: number | null;
    }>;
    error?: string;
    cached?: boolean;
  }

  const started = Date.now();
  const blocks = await call<Block[]>(
    `api.getPrices({ city: ${JSON.stringify(city)}, query: ${JSON.stringify(query)} })`,
  );
  const elapsed = Date.now() - started;

  for (const block of blocks) {
    const first = block.items[0];
    const view = block.error
      ? `отказ: ${block.error}`
      : !block.ready
        ? 'не готов'
        : `${block.items.length} товаров` +
          (first !== undefined ? `, первый: «${first.name}» за ${first.price}` : '') +
          (block.cached ? ' (кэш)' : '');
    console.log(`${block.ready && !block.error ? 'OK  ' : 'FAIL '} ${block.storeId} ${block.storeCode}: ${view}`);
  }
  console.log(`выдача целиком: ${elapsed} мс`);

  const fiveK = blocks.find((b) => b.storeId === 'pyaterochka');
  if (!fiveK) {
    throw new Error(
      `блок Пятёрки не пришёл (сети в ответе: ${blocks.map((b) => b.storeId).join(', ')})`,
    );
  }
  // Пробники BEFORE Verdict: сырые тексты нужны при любом исходе Пятёрки —
  // ошибка адаптера без сырья объясняет только «что упало», а не «почему».
  if (process.env['PA_ANDROID_PROBE'] === '1') {
    const sap = fiveK.storeCode;
    const probeUrl =
      'https://5d.5ka.ru/api/catalog/v3/stores/' + sap +
      `/search?mode=store&include_restrict=true&q=${encodeURIComponent(query)}&limit=12`;
    const readProbe = async (label: string, url: string): Promise<void> => {
      const startedAt = Date.now();
      const raw = await call<string>(
        `window.Capacitor?.Plugins?.PageReader?.readPage({ url: ${JSON.stringify(url)} })
           .then((r) => r?.text ?? '')
           .catch((e) => '<<отказ: ' + String(e).slice(0, 140) + '>>')`,
      );
      const ms = Date.now() - startedAt;
      console.log(
        `проба ${label}: ${raw.length} символов за ${ms} мс — начало: ${raw.slice(0, 1400)}`,
      );
      const cookies = await call<{ cookie: string | null }>(
        `window.Capacitor?.Plugins?.PageReader?.readCookies({ url: ${JSON.stringify(url)} })
           .then((r) => r?.cookie ?? null)
           .catch((e) => '<<отказ: ' + String(e).slice(0, 140) + '>>')`,
      );
      console.log(`         куки ${label}: ${(cookies?.cookie ?? 'none').slice(0, 600)}`);
    };
    await readProbe('главная 5ka.ru', 'https://5ka.ru/');
    await readProbe('search API', probeUrl);
  }
  if (!fiveK.ready) throw new Error(`Пятёрка не ответила: ${fiveK.error}`);
  if (fiveK.error) throw new Error(`Пятёрка упала: ${fiveK.error}`);
  if (fiveK.items.length === 0) {
    throw new Error('Пятёрка отдала живую сеть с пустой выдачей');
  }
  const firstFive = fiveK.items[0];
  if (!firstFive) throw new Error('выдача без строк');
  if (firstFive.storeCode !== fiveK.storeCode) {
    throw new Error(`строка с чужим кодом точки: ${firstFive.storeCode} вместо ${fiveK.storeCode}`);
  }
  console.log(
    `ПЯТЁРКА ЖИВА НА ANDROID: ${fiveK.items.length} товаров, точка ${fiveK.storeCode}, запрос «${query}»`,
  );

  ws.close();
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
