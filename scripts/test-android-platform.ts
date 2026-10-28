// Порты Android-оболочки, которые лежат под гейтом покрытия (`src/core`), и
// один параметр хранилища, который иначе остался бы непроверенным.
//
// Что здесь ловится:
//  1. `loadPlaywright()` без зарегистрированного загрузчика — это ровно тот
//     случай, который происходит на Android: сеть Пятёрки/Чижика/Перекрёстка
//     пытается поднять браузер, которого в сборке нет. Ошибка обязана быть
//     громкой и объяснять причину, иначе «сеть молчит» и «сети здесь нет»
//     выглядели бы для пользователя одинаково.
//  2. Тот же порт с загрузчиком возвращает именно его модуль.
//  3. `openDb` с заданным `wasmUrl` — иначе ветка `initSqlJs({ locateFile })`
//     не выполнялась бы никогда, а на Android wasm лежит по этому пути.

import assert from 'node:assert';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  __setPlaywrightForTests,
  injectedPlaywright,
  loadPlaywright,
  setPlaywrightLoader,
} from '../src/core/adapters/playwright-port.js';
import { openDb, closeDb } from '../src/core/db/db.js';
import { memoryStorage } from '../src/core/platform.js';

// ─── 1. Браузера в сборке нет: громко и с причиной ───────────────────────────
setPlaywrightLoader(null);
await assert.rejects(
  () => loadPlaywright(),
  /браузер недоступен в этой сборке/,
  'без загрузчика падает не «неизвестная ошибка», а объяснение, что браузера нет',
);
await assert.rejects(
  () => loadPlaywright(),
  /Пятёрка, Чижик и Перекрёсток/,
  'и названо, какие сети это затрагивает',
);

// ─── 2. С загрузчиком возвращается его модуль ──────────────────────────────
const fake = { chromium: { launch: async () => ({}) } } as unknown as Awaited<
  ReturnType<typeof loadPlaywright>
>;
setPlaywrightLoader(async () => fake);
assert.equal(await loadPlaywright(), fake, 'загрузчик оболочки отдаёт свой модуль');

// Второй вызов берёт тот же модуль: оболочка не должна поднимать вторую копию
// браузера на каждый запрос.
assert.equal(await loadPlaywright(), fake, 'повторный вызов не пересоздаёт модуль');
setPlaywrightLoader(null);

// ─── 3. Отказ загрузчика превращается в понятный текст ─────────────────────
// На Electron это битая сборка (лечится переустановкой), и по голому
// «Cannot find module» пользователь и разработчик этого не видят.
setPlaywrightLoader(async () => {
  throw new Error("Cannot find module 'playwright'");
});
await assert.rejects(
  () => loadPlaywright(),
  /установлено повреждённо/,
  'отказ импорта пересказан: пользователю нужен переустановка, а не стек',
);
let importFailure = '';
try {
  await loadPlaywright();
} catch (err) {
  importFailure = String(err);
}
assert.match(importFailure, /Cannot find module/, 'и причина сохранена — по ней видно, чего не хватило');

// ─── 3b. Подмена для тестов побеждает загрузчик оболочки ───────────────────
// Иначе тесту пришлось бы ставить подмену И загрузчик, и ветка «подмены нет»
// осталась бы непокрытой в каждом адаптере.
const injected = { firefox: {} } as unknown as Awaited<ReturnType<typeof loadPlaywright>>;
__setPlaywrightForTests(injected);
assert.equal(injectedPlaywright(), injected, 'подмена для тестов видна');
assert.equal(await loadPlaywright(), injected, 'и берётся вместо загрузчика оболочки');
__setPlaywrightForTests(null);
assert.equal(injectedPlaywright(), null, 'подмена снята');
setPlaywrightLoader(null);

// ─── 4. Путь к wasm доходит до sql.js ──────────────────────────────────────
// Здесь нужен НАСТОЯЩИЙ файл wasm: проверяется ровно то, что `locateFile`
// подставляет путь, который загрузчик действительно открывает. На устройстве
// это ассет рядом с документом, в Node — тот же файл из node_modules, но под
// file:// (иначе sql.js ищет его как путь в рабочем каталоге).
const store = memoryStorage();
const wasmFile = pathToFileURL(resolve(import.meta.dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')).href;
store.wasmUrl = wasmFile;
const database = await openDb(store);
assert.ok(database, 'база открылась по переданному пути к wasm');
closeDb();

console.log('android ports: ALL GREEN — порт браузера, отказ без него, путь к wasm');
