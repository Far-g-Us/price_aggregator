// Проверки src/core/http.ts: на десктопе поведение прежнее, на нативной Android
// среде запрос идёт через плагин с настоящими таймаутами, обрыв нативного слоя
// не превращается во второй запрос без таймаута, а натив без плагина падает
// внятно вместо молчаливой деградации.

import assert from 'node:assert/strict';
import { httpFetch } from '../src/core/http.js';

type Bridge = { Plugins?: Record<string, unknown> | undefined };
type Scope = {
  Capacitor?: Bridge | undefined;
  androidBridge?: unknown;
};

const scope = globalThis as Scope;

type Call = { options: Record<string, unknown> };
type Reply = { data: unknown; status: number; headers?: Record<string, string>; url?: string };

const URL = 'https://lenta.com/api-gateway/v1/x';
let calls: Call[] = [];
let reply: Reply = { data: '{"ok":1}', status: 200 };
let nativeFailure: Error | null = null;

function installPlugin(): void {
  scope.Capacitor = {
    Plugins: {
      CapacitorHttp: {
        request: (options: Record<string, unknown>) => {
          calls.push({ options });
          if (nativeFailure) return Promise.reject(nativeFailure);
          return Promise.resolve(reply);
        },
      },
    },
  };
  scope.androidBridge = {};
}

/** Нативная среда, в которой плагина нет: так бывает без импорта @capacitor/core. */
function installNativeWithoutPlugin(bridge: Bridge): void {
  scope.Capacitor = bridge;
  scope.androidBridge = {};
}

function clearNative(): void {
  scope.Capacitor = undefined;
  scope.androidBridge = undefined;
}

async function withWebFetch<T>(
  stub: (url: string, init: Record<string, unknown>) => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = saved;
  }
}

const results: { name: string; ok: boolean }[] = [];
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`  ok  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.error(`  FAIL ${name}: ${(error as Error).message}`);
  } finally {
    clearNative();
  }
}

await test('нативный POST уходит в плагин с connectTimeout и readTimeout', async () => {
  calls = [];
  nativeFailure = null;
  reply = { data: { ok: 1 }, status: 200 };
  installPlugin();

  const res = await httpFetch(URL, {
    method: 'POST',
    headers: { 'X-Query-Host': 'lenta.com' },
    body: '{"a":1}',
    timeoutMs: 25000,
  });

  assert.equal(calls.length, 1, 'плагин должен позваться ровно один раз');
  const options = calls[0]!.options;
  assert.equal(options['url'], URL);
  assert.equal(options['method'], 'POST');
  assert.deepEqual(options['headers'], { 'X-Query-Host': 'lenta.com' });
  assert.equal(options['data'], '{"a":1}');
  assert.equal(options['connectTimeout'], 25000, 'без connectTimeout POST висит вечно');
  assert.equal(options['readTimeout'], 25000, 'без readTimeout провисшее соединение не рвётся');
  assert.equal(options['disableRedirects'], false, 'десктоп шлёт redirect: follow, натив должен так же');
  assert.equal(options['responseType'], 'text', 'JSON разбирает адаптер, как на десктопе');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"ok":1}', 'нативный JSON обязан вернуться строкой');
});

await test('GET без тела не передаёт data нативному слою', async () => {
  calls = [];
  nativeFailure = null;
  reply = { data: '<html>ok</html>', status: 200 };
  installPlugin();

  // Без явного метода — так вызывают Магнит и Светофор.
  const res = await httpFetch(URL, { headers: { Cookie: 'a=b' }, timeoutMs: 25000 });

  const options = calls[0]!.options;
  assert.equal(options['method'], 'GET', 'без метода должен быть GET, как в fetch');
  assert.equal('data' in options, false, 'пустое тело не должно уходить в нативный запрос');
  assert.equal(await res.text(), '<html>ok</html>');
});

await test('статус и заголовки нативного ответа доезжают', async () => {
  calls = [];
  nativeFailure = null;
  reply = { data: 'нет', status: 409, headers: { 'content-type': 'text/plain' }, url: URL };
  installPlugin();

  const res = await httpFetch(URL, { method: 'POST', headers: {}, body: '{}', timeoutMs: 25000 });

  assert.equal(res.status, 409);
  assert.equal(res.ok, false);
  assert.equal(res.headers.get('content-type'), 'text/plain', 'заголовки доезжают: по ним выбирается разбор');
  assert.equal(res.url, 'https://lenta.com/api-gateway/v1/x', 'адрес ответа нужен сверке магазина');
  assert.equal(await res.text(), 'нет');
});

await test('нативный ответ без адреса не ломает чтение', async () => {
  calls = [];
  nativeFailure = null;
  reply = { data: 'ok', status: 200, headers: {} };
  installPlugin();

  const res = await httpFetch(URL, { method: 'GET', headers: {}, timeoutMs: 25000 });

  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

await test('ответ без тела не ломает чтение текста', async () => {
  calls = [];
  nativeFailure = null;
  reply = { data: null, status: 204 };
  installPlugin();
  const empty = await httpFetch(URL, { method: 'POST', headers: {}, body: '{}', timeoutMs: 25000 });

  assert.equal(empty.status, 204);
  assert.equal(empty.ok, true);
  assert.equal(await empty.text(), '', '204 без тела обязан читаться как пустая строка');

  calls = [];
  reply = { data: null, status: 200 };
  installPlugin();
  const blank = await httpFetch(URL, { method: 'GET', headers: {}, timeoutMs: 25000 });

  assert.equal(blank.status, 200);
  assert.equal(await blank.text(), '', 'пустой ответ при обычном статусе тоже должен читаться');

  for (const status of [205, 304]) {
    calls = [];
    reply = { data: null, status };
    installPlugin();
    const noBody = await httpFetch(URL, { method: 'GET', headers: {}, timeoutMs: 25000 });
    assert.equal(noBody.status, status);
    assert.equal(await noBody.text(), '', `${status} запрещает тело и обязан читаться пустым`);
  }
});

await test('обрыв нативного слоя пробрасывается без второго запроса', async () => {
  calls = [];
  nativeFailure = new Error('SocketTimeoutException: Read timed out');
  installPlugin();

  await assert.rejects(
    () => httpFetch(URL, { method: 'POST', headers: {}, body: '{}', timeoutMs: 25000 }),
    /Read timed out/,
    'ошибка натива обязана дойти до защиты сети',
  );
  assert.equal(calls.length, 1, 'второй запрос без таймаута уходить не должен');

  let webUsed = false;
  await withWebFetch(
    async () => {
      webUsed = true;
      return new Response('нет', { status: 200 });
    },
    async () => {
      await assert.rejects(() =>
        httpFetch(URL, { method: 'POST', headers: {}, body: '{}', timeoutMs: 25000 }),
      );
    },
  );
  assert.equal(webUsed, false, 'на нативе откат на web-fetch запрещён: там таймаут теряется');
});

await test('натив без плагина падает внятно, а не уходит в fetch без таймаута', async () => {
  calls = [];
  let webUsed = false;
  for (const bridge of [{}, { Plugins: {} }]) {
    installNativeWithoutPlugin(bridge as Bridge);
    await withWebFetch(
      async () => {
        webUsed = true;
        return new Response('тихо ушло', { status: 200 });
      },
      async () => {
        await assert.rejects(
          () => httpFetch(URL, { method: 'POST', headers: {}, body: '{}', timeoutMs: 25000 }),
          /CapacitorHttp/,
          'без плагина на Android запрос обязан падать с подсказкой про конфиг',
        );
      },
    );
  }
  assert.equal(webUsed, false, 'тихо уходить в патченный fetch нельзя');
});

await test('без моста идёт обычный fetch с нашим таймаутом', async () => {
  clearNative();
  const seen: { url: string; init: Record<string, unknown> }[] = [];
  await withWebFetch(
    async (url: string, init: Record<string, unknown>) => {
      seen.push({ url, init });
      return new Response('десктоп', { status: 200 });
    },
    async () => {
      const res = await httpFetch(URL, { method: 'GET', headers: { A: 'b' }, timeoutMs: 12000 });
      assert.equal(await res.text(), 'десктоп');
      const post = await httpFetch(URL, {
        method: 'POST',
        headers: { A: 'b' },
        body: '{"x":1}',
        timeoutMs: 12000,
      });
      assert.equal(await post.text(), 'десктоп');
    },
  );

  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.url, URL);
  assert.equal(seen[0]!.init['signal'] instanceof AbortSignal, true);
  assert.equal(seen[0]!.init['redirect'], 'follow');
  assert.equal('body' in seen[0]!.init, false, 'GET без тела не должен тащить body');
  assert.equal(seen[1]!.init['method'], 'POST');
  assert.equal(seen[1]!.init['body'], '{"x":1}');
});

await test('в браузере сетевой плагин CapacitorHttp не используется', async () => {
  // Так выглядит браузер с установленным Capacitor: его сетевой плагин
    // зарегистрирован, но это обёртка над fetch, которая наши таймауты не
    // передаёт. Путь обязан остаться обычным fetch с AbortSignal.
    calls = [];
    let webUsed = false;
    scope.Capacitor = { Plugins: { CapacitorHttp: { request: () => Promise.reject(new Error('плагин веба звать нельзя')) } } };
    await withWebFetch(
      async () => {
        webUsed = true;
        return new Response('из web-fetch', { status: 200 });
      },
      async () => {
        const res = await httpFetch(URL, { headers: {}, timeoutMs: 25000 });
        assert.equal(await res.text(), 'из web-fetch');
      },
    );

    assert.equal(webUsed, true, 'в браузере плагин CapacitorHttp оборачивает fetch и таймауты съедает');
    assert.equal(calls.length, 0);
});

await test('потолок на запрос целиком, а не только на чтение', async () => {
  // Сервер, отдающий байт каждые 20 секунд, держит connectTimeout и readTimeout
  // в покое. Значит нужен общий потолок, как AbortSignal на десктопе.
  calls = [];
  scope.Capacitor = { Plugins: { CapacitorHttp: { request: () => new Promise(() => {}) } } };
  scope.androidBridge = {};

  const started = Date.now();
  await assert.rejects(
    () => httpFetch(URL, { method: 'POST', headers: {}, body: '{}', timeoutMs: 120 }),
    /превышено время запроса/,
    'зависший нативный запрос обязан упасть по общему потолку',
  );
  assert.ok(Date.now() - started < 3000, 'потолок должен сработать, а не ждать ответа сервера');
});

const failed = results.filter((r) => !r.ok);
console.log(`\n  http: ${results.length - failed.length}/${results.length}`);
if (failed.length > 0) process.exit(1);
