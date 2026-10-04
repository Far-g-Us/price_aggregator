// Отказы при открытии базы и откаты транзакций.
//
// Отдельный файл, а не блок в test-db: `openDb` — синглтон на процесс, и
// «база не открывается» проверяется только до первого успешного openDb. Здесь
// он до этого момента и не доводится.
//
// Сценарии не выдуманы: таблица с именем индекса — это ровно то, что останется
// в файле, если база была создана более новой версией схемы; откат
// транзакции — это нарушение внешнего ключа, то есть ровно то, что произойдёт,
// если товар удалили из products, пока висела правка полок.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { closeDb, openDb, saveFavorite, saveNotifiedPrices, setProductShelves } from '../src/core/db/db.js';
import { createCore } from '../src/core/services.js';
import { fileStorageAt } from '../electron/node-files.js';
import type { AppStorage } from '../src/core/platform.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-open-'));

// ─── 1. База, которую нельзя привести к схеме: openDb падает целиком ──────
{
  const SQL = await initSqlJs();
  const broken = new SQL.Database();
  // Имя индекса занято таблицей — `CREATE INDEX` из схемы на этом ляжет.
  broken.run('CREATE TABLE idx_prices_lookup (x TEXT)');
  const file = path.join(dir, 'broken.db');
  fs.writeFileSync(file, Buffer.from(broken.export()));
  broken.close();

  let caught: unknown = null;
  try {
    await openDb(fileStorageAt(file));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught !== null, 'база, которую не чинит даже CREATE INDEX IF NOT EXISTS, не открывается');
  // И главное: не остаётся «полуоткрытой» базы без таблиц — ровно тот баг,
  // который закрывался в openDb присваиванием только после успеха.
  const again = await (async () => {
    try {
      await openDb(fileStorageAt(file));
      return null;
    } catch (err) {
      return err;
    }
  })();
  assert.ok(again !== null, 'повторный openDb тоже падает, а не отдаёт базу без таблиц');
}

// ─── 2. Сломанное хранилище при первом чтении: понятная ошибка, а не пустота ─
{
  const broken: AppStorage = {
    readDb: () => {
      throw new Error('диск недоступен');
    },
    writeDb: () => {},
  };
  await assert.rejects(
    openDb(broken),
    /диск недоступен/,
    'нечитаемое хранилище честно падает: товар не показать, лучше не начать',
  );
}

// ─── 3. Нарушение внешнего ключа откатывает правку целиком ─────────────────
{
  const fresh = fileStorageAt(path.join(dir, 'fk.db'));
  const db = await openDb(fresh);
  const ghost = { canonicalId: 'нет-такого', storeId: 'magnit', city: 'moscow' };
  const real = { canonicalId: 'есть-такой', storeId: 'magnit', city: 'moscow' };
  db.run("INSERT INTO products (id, name, unit) VALUES ('есть-такой', 'Товар', '1 шт')");

  // Первая полка записывается нормально.
  setProductShelves(db, real, ['dairy-milk']);
  const shelfCount = (): number =>
    Number(db.exec("SELECT COUNT(*) AS n FROM product_categories WHERE canonical_id = 'есть-такой'")[0]?.values[0]?.[0] ?? 0);
  assert.equal(shelfCount(), 1, 'полка записалась');

  // Теперь роняем вставку: полка есть в наших категориях, а вторая — нет.
  assert.throws(
    () => setProductShelves(db, real, ['dairy-milk', 'нет-такой-полки']),
    /FOREIGN KEY|constraint/i,
    'ссылка на несуществующую полку отвергается',
  );
  assert.equal(shelfCount(), 1, 'откат вернул ровно то, что было до правки, а не половину');
  saveFavorite(db, real, 200);
  saveNotifiedPrices(db, [{ ...real, price: 200 }]);
  const notifiedOf = (): number | null =>
    (db.exec("SELECT notified_price FROM favorites WHERE canonical_id = 'есть-такой'")[0]?.values[0]?.[0] as number | null) ?? null;
  assert.equal(notifiedOf(), 200, 'отметка об уведомлении записалась');

  // Роняем обновление значением, которое не умеет bind: строкой SQLite не
  // считает ошибкой, а вот undefined — да.
  assert.throws(
    () => saveNotifiedPrices(db, [{ ...real, price: undefined as unknown as number }]),
    /bind|unsupported type/i,
    'запись с непринимаемым значением падает',
  );
  assert.equal(notifiedOf(), 200, 'и откат оставил прежнюю отметку, а не стёр её');
  closeDb();
}

// ─── 4. Старт планировщика при нечитаемой базе: без unhandled rejection ────
{
  // Именно этот сценарий ловит падение в main: startScheduler зовёт эту задачу
  // через void, то есть без await, и без catch падение ушло бы в main.
  const logs: string[] = [];
  // Ждём именно лог, а не «прошло 30 мс»: на медленной машине таймер солгал бы.
  let noteLogged: () => void = () => {};
  const logged = new Promise<void>((resolve) => {
    noteLogged = resolve;
  });
  const broken: AppStorage = {
    readDb: () => {
      throw new Error('диск недоступен');
    },
    writeDb: () => {},
  };
  const afterTasks: (() => void)[] = [];
  const core = createCore({
    storage: broken,
    json: { read: () => null, write: () => {} },
    shell: { version: () => '1.2.1', notify: () => {}, openExternal: async () => {} },
    background: {
      every: () => {},
      after: (_ms, task) => void afterTasks.push(task as () => void),
    },
    log: {
      error: (...a) => {
        logs.push(a.map(String).join(' '));
        noteLogged();
      },
      warn: () => {},
      info: () => {},
    },
    adapters: new Map(),
  });
  core.startScheduler();
  assert.ok(afterTasks.length > 0, 'планировщик поставил разовую задачу на чтение метки');
  for (const task of afterTasks) task();
  await logged;
  assert.ok(
    logs.some((l) => l.includes('не удалось прочитать метку')),
    'нечитаемая база при старте залогирована, а не уронила main',
  );
  assert.equal(core.schedulerStatus().running, false, 'и планировщик при этом не считает себя занятым');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('db open errors: ALL GREEN — битая база, нечитаемое хранилище, откаты, старт планировщика');