import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UNKNOWN_STORE_CODE } from '../src/shared/types.js';
import type { ScrapedProduct, StoreAdapter } from '../src/shared/types.js';
import { CITY_STORES, pointKey, storesForCity } from '../src/shared/catalog.js';
import { closeDb, getLastRun, getPriceHistory, openDb } from '../src/core/db/db.js';
import { fileStorageAt } from '../electron/node-files.js';
import { pollOnce } from '../src/core/scheduler.js';
import { StaleStoreError } from '../src/core/adapter-errors.js';
import { consoleLogger } from '../src/core/platform.js';
// печатает ошибки — в тестах это шум, мешающий прочитать результат.

const magnitMoscow = storesForCity('moscow', 'magnit')[0]?.externalStoreId ?? '';

let price = 100;
const fake: StoreAdapter = {
  storeId: 'magnit',
  async search() {
    return [];
  },
  async fetchProduct(canonicalId: string, ctx: { city: string; externalStoreId: string }) {
    assert.equal(ctx.externalStoreId, magnitMoscow);
    const p: ScrapedProduct = {
      canonicalId,
      storeId: 'magnit',
      city: ctx.city,
      storeCode: ctx.externalStoreId,
      name: 'Тест',
      price,
      promoPrice: null,
      oldPrice: null,
      collectedAt: new Date().toISOString(),
    };
    return p;
  },
};

// Пустая база и опрос без фильтра по городу: в лог уходит сообщение без
// «в городе …», а не с пустым хвостом от неиспользованного города. Проверяем
// первым делом: openDb держит одну базу на процесс и вторую не откроет.
{
  const emptyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sch-empty-')), 'e.db');
  const emptyDb = await openDb(fileStorageAt(emptyFile));
  const lines: string[] = [];
  const empty = await pollOnce(emptyDb, new Map([['magnit', fake]]), {
    delayMs: 0,
    log: { ...consoleLogger, info: (m: string) => void lines.push(m) },
  });
  assert.deepEqual(
    empty,
    { inserted: 0, skipped: 0, failed: 0, notReady: 0, failedStores: [], staleStores: [], interrupted: false, remaining: 0 },
    'пустая база — пустой отчёт',
  );
  assert.deepEqual(lines, ['опрос: нет отслеживаемых товаров'], 'и сообщение без города, а не с висящим хвостом');
  closeDb();
}

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sch-')), 't.db');
const db = await openDb(fileStorageAt(file));
db.run(
  `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price)
   VALUES ('magnit-1', 'magnit', 'moscow', '${magnitMoscow}', 100)`,
);

const r1 = await pollOnce(db, new Map([['magnit', fake]]), { delayMs: 0 });
assert.deepEqual(r1, { inserted: 0, skipped: 1, failed: 0, notReady: 0, failedStores: [], staleStores: [], interrupted: false, remaining: 0 });

price = 120;
const r2 = await pollOnce(db, new Map([['magnit', fake]]), { delayMs: 0 });
assert.deepEqual(r2, { inserted: 1, skipped: 0, failed: 0, notReady: 0, failedStores: [], staleStores: [], interrupted: false, remaining: 0 });

const hist = getPriceHistory(db, {
  canonicalId: 'magnit-1',
  storeId: 'magnit',
  city: 'moscow',
  storeCode: magnitMoscow,
});
assert.equal(hist.length, 2);
assert.equal(hist[0]?.price, 100);
assert.equal(hist[1]?.price, 120);
assert.ok(fs.existsSync(file), 'persisted after poll');

// Инвариант кода точки в опросе: подтверждение сети не затирается эхом
// справочника. Ответ за чужую точку — громкий отказ без записи, sentinel «не
// подтвердила» — запись по запрошенной точке.
{
  const lying: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string, ctx: { externalStoreId: string }): Promise<ScrapedProduct> {
      return {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
        storeCode: '777777',
        name: 'Тест',
        price: 999,
        promoPrice: null,
        oldPrice: null,
        collectedAt: new Date().toISOString(),
      };
    },
  };
  const before = getPriceHistory(db, {
    canonicalId: 'magnit-1',
    storeId: 'magnit',
    city: 'moscow',
    storeCode: magnitMoscow,
  }).length;
  const foreign = await pollOnce(db, new Map([['magnit', lying]]), { delayMs: 0 });
  assert.equal(foreign.failed, 1, 'ответ за чужую точку — неудача, а не запись');
  assert.equal(foreign.inserted, 0, 'и ничего не записано');
  assert.equal(
    getPriceHistory(db, {
      canonicalId: 'magnit-1',
      storeId: 'magnit',
      city: 'moscow',
      storeCode: magnitMoscow,
    }).length,
    before,
    'в историю нашей точки чужая цена не попала',
  );

  const noCode: StoreAdapter = {
    ...lying,
    async fetchProduct(canonicalId: string): Promise<ScrapedProduct> {
      return {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
        storeCode: UNKNOWN_STORE_CODE,
        name: 'Тест',
        price: 555,
        promoPrice: null,
        oldPrice: null,
        collectedAt: new Date().toISOString(),
      };
    },
  };
  const unconfirmed = await pollOnce(db, new Map([['magnit', noCode]]), { delayMs: 0 });
  assert.equal(unconfirmed.inserted, 1, 'сентинел «не подтвердила» — запись по запрошенной точке');
  assert.equal(
    getPriceHistory(db, {
      canonicalId: 'magnit-1',
      storeId: 'magnit',
      city: 'moscow',
      storeCode: magnitMoscow,
    }).length,
    before + 1,
    'и она легла в ключ нашей точки, а не в чужой',
  );
}

// Опрос бьёт только по выбранному городу. Цена привязана к магазину города,
// поэтому обход всех городов одной кнопкой — это запросы туда, куда
// пользователь не смотрел (и лишние обращения к сети).
{
  const magnitUlyanovsk = storesForCity('ulyanovsk', 'magnit')[0]?.externalStoreId ?? '';
  db.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price)
     VALUES ('magnit-uly', 'magnit', 'ulyanovsk', '${magnitUlyanovsk}', 500)`,
  );
  const asked: string[] = [];
  const spy: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string, ctx: { city: string; externalStoreId: string }) {
      asked.push(`${canonicalId}@${ctx.city}`);
      return {
        canonicalId,
        storeId: 'magnit',
        city: ctx.city,
         storeCode: ctx.externalStoreId,
        name: 'Тест',
        price: 777,
        promoPrice: null,
        oldPrice: null,
        collectedAt: new Date().toISOString(),
      };
    },
  };
  assert.equal(magnitUlyanovsk, '730159', 'эталонный код Ульяновска на месте');

  const onlyMoscow = await pollOnce(db, new Map([['magnit', spy]]), { delayMs: 0, city: 'moscow' });
  assert.ok(
    asked.every((a) => a.endsWith('@moscow')),
    `опрос ограничен городом, а видел: ${asked.join(', ')}`,
  );
  assert.ok(onlyMoscow.skipped + onlyMoscow.inserted > 0, 'цели Москвы обработаны');

  asked.length = 0;
  const onlyUlyanovsk = await pollOnce(db, new Map([['magnit', spy]]), { delayMs: 0, city: 'ulyanovsk' });
  assert.ok(
    asked.every((a) => a.endsWith('@ulyanovsk')),
    `опрос ограничен городом, а видел: ${asked.join(', ')}`,
  );
  assert.equal(onlyUlyanovsk.inserted, 1, 'цена Ульяновска обновилась');

  // Пустой город: целей нет — опрос ничего не делает, а не считает чужие.
  asked.length = 0;
  const none = await pollOnce(db, new Map([['magnit', spy]]), { delayMs: 0, city: 'kazan' });
  assert.deepEqual(
    none,
    { inserted: 0, skipped: 0, failed: 0, notReady: 0, failedStores: [], staleStores: [], interrupted: false, remaining: 0 },
    'город без целей — пустой отчёт',
  );
  assert.equal(asked.length, 0, 'сеть не дёргалась ради города без целей');

  // Без фильтра — все города (прежнее поведение, нужно ручному запуску).
  asked.length = 0;
  await pollOnce(db, new Map([['magnit', spy]]), { delayMs: 0 });
  assert.ok(asked.length >= 2, `без фильтра опрошены все города, видел: ${asked.join(', ')}`);

  // Фильтр по ВЫБРАННЫМ сетям — это обещание галочки в шапке. Без него при одном
  // выбранном магазине счётчик обещал обход всех сетей города («28 из 445») и ходил
  // в выключенные сети тоже.
  db.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('magnit-2', 'magnit', 'moscow', '303857', 300)`,
  );
  db.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('pyat-1', 'pyaterochka', 'moscow', '35XY', 100)`,
  );
  const magnitSpy: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string, ctx: { city: string; externalStoreId: string }) {
      asked.push(`${canonicalId}@${ctx.city}`);
      return {
        canonicalId,
        storeId: 'magnit',
        city: ctx.city,
         storeCode: ctx.externalStoreId,
        name: 'Тест',
        price: 777,
        promoPrice: null,
        oldPrice: null,
        collectedAt: new Date().toISOString(),
      };
    },
  };
  const pyatSpy: StoreAdapter = {
    ...magnitSpy,
    storeId: 'pyaterochka',
    async fetchProduct(canonicalId: string, ctx: { city: string; externalStoreId: string }) {
      asked.push(`${canonicalId}@${ctx.city}`);
      return {
        canonicalId,
        storeId: 'pyaterochka',
        city: ctx.city,
         storeCode: ctx.externalStoreId,
        name: 'Тест',
        price: 555,
        promoPrice: null,
        oldPrice: null,
        collectedAt: new Date().toISOString(),
      };
    },
  };
  asked.length = 0;
  let total = 0;
  await pollOnce(db, new Map([['magnit', magnitSpy], ['pyaterochka', pyatSpy]]), {
    delayMs: 0,
    city: 'moscow',
    pointKeys: [pointKey('magnit', magnitMoscow)],
    onProgress: (_d, t) => {
      total = t;
    },
  });
  assert.ok(asked.every((a) => a.startsWith('magnit-')), `опросил только выбранную сеть, видел: ${asked.join(', ')}`);
  assert.equal(total, asked.length, `знаменатель счётчика считает только выбранные сети: ${total} против ${asked.length}`);
  // Пустой выбор — «ни одной сети», а не «все»: иначе снятие всех галочек тихо
  // включало бы опрос всего города.
  asked.length = 0;
  const none2 = await pollOnce(db, new Map([['magnit', magnitSpy], ['pyaterochka', pyatSpy]]), {
    delayMs: 0,
    city: 'moscow',
    pointKeys: [],
  });
  assert.equal(none2.inserted + none2.skipped + none2.failed + none2.notReady, 0, 'пустой выбор — ничего не опрашиваем');
  assert.equal(asked.length, 0, 'сети не дёргались при пустом выборе');
  db.run(`DELETE FROM prices_history WHERE canonical_id = 'magnit-2'`);
  db.run(`DELETE FROM prices_history WHERE canonical_id = 'pyat-1'`);

  // Сети без паузы: у Светофора товар лежит в кэшированном файле выгрузки, за
  // него в сеть не уходит НИ ОДНОГО запроса, поэтому ожидание после каждого
  // товара отнимало бы у пользователя по секунде впустую. У Пятёрки наоборот —
  // там запрос на каждый товар, и пауза обязательна.
  {
    db.run(`INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('svt-1', 'svetofor', 'moscow', '820', 100)`);
    db.run(`INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('svt-2', 'svetofor', 'moscow', '820', 100)`);
    const svetSpy: StoreAdapter = {
      storeId: 'svetofor',
      async search() {
        return [];
      },
      async fetchProduct(canonicalId: string, ctx: { city: string; externalStoreId: string }) {
        asked.push(`${canonicalId}@${ctx.city}`);
        return {
          canonicalId,
          storeId: 'svetofor',
          city: ctx.city,
           storeCode: ctx.externalStoreId,
          name: 'Тест',
          price: 100,
          promoPrice: null,
          oldPrice: null,
          collectedAt: new Date().toISOString(),
        };
      },
    };
    const fastStart = Date.now();
    const fast = await pollOnce(db, new Map([['svetofor', svetSpy]]), {
      delayMs: 400,
      city: 'moscow',
      pointKeys: [pointKey('svetofor', storesForCity('moscow', 'svetofor')[0]?.externalStoreId ?? '')],
    });
    const fastElapsed = Date.now() - fastStart;
    assert.ok(fast.skipped + fast.inserted >= 2, 'позиции Светофора обработаны');
    assert.ok(
      fastElapsed < 400,
      `у Светофора паузы между товарами нет: прошло ${fastElapsed} мс при delayMs 400`,
    );
    // Пауза есть у сети, которая смотрит в сеть на каждый товар, и только между
    // товарами ОДНОЙ сети: переход к другой сети — другая точка со своими
    // лимитами, ждать после её последнего товара незачем.
    db.run(`INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('svt-3', 'svetofor', 'moscow', '820', 100)`);
    asked.length = 0;
    const bothStart = Date.now();
    await pollOnce(db, new Map([['svetofor', svetSpy], ['magnit', magnitSpy]]), {
      delayMs: 300,
      city: 'moscow',
    });
    const bothElapsed = Date.now() - bothStart;
    // Магнит даёт паузу на своих товарах, Светофор — нет; если бы пауза была и на
    // стыке сетей, обход заметно замедлился бы.
    assert.ok(asked.includes('svt-3@moscow'), 'товар Светофора тоже обработан');
    assert.ok(bothElapsed < 900, `пауза не ставится ни на Светофоре, ни на стыке сетей: ${bothElapsed} мс`);
    db.run(`DELETE FROM prices_history WHERE canonical_id = 'svt-3'`);
    db.run(`DELETE FROM prices_history WHERE canonical_id = 'svt-1'`);
    db.run(`DELETE FROM prices_history WHERE canonical_id = 'svt-2'`);
  }

  // Убираем добавленную цель: дальше идут тесты с адаптером, который
  // утверждает, что внешний код МОСКОВСКИЙ, и чужая строка его бы уронила.
  db.run(`DELETE FROM prices_history WHERE canonical_id = 'magnit-uly'`);
}

const failing: StoreAdapter = {
  storeId: 'magnit',
  async search() {
    return [];
  },
  async fetchProduct(canonicalId: string, ctx: { city: string; externalStoreId: string }) {
    if (canonicalId === 'magnit-1') throw new Error('boom');
    return fake.fetchProduct(canonicalId, ctx);
  },
};
db.run(
  `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('magnit-2', 'magnit', 'moscow', '303857', 120)`,
);
db.run(
  `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('x-1', 'nostore', 'moscow', '?', 5)`,
);
const r3 = await pollOnce(db, new Map([['magnit', failing]]), { delayMs: 0 });
assert.equal(r3.failed, 1, 'one item error isolated');
assert.equal(r3.notReady, 1, 'unknown store counted as notReady');
assert.equal(r3.skipped, 1, 'rest of batch processed');


// Неготовая сеть (нет адаптера) обязана двигать прогресс: иначе кнопка опроса
// на 76 позиций с одной сломанной сетью зависает намертво, пока пользователь
// ждёт цифру, которая не придёт.
{
  const progress: Array<[number, number]> = [];
  const withProgress = await pollOnce(db, new Map([['magnit', fake]]), {
    delayMs: 0,
    onProgress: (done, total) => void progress.push([done, total]),
  });
  assert.equal(withProgress.notReady, 1, 'товар без сети посчитан неготовым');
  assert.ok(
    progress.some(([done, total]) => done < total),
    `прогресс дошёл до конца, минуя неготовый товар: ${JSON.stringify(progress)}`,
  );
}

// Первый прогресс уходит ДО первого товара. У браузерных сетей первый запрос
// включает прогрев сессии и занимает минуты: без события 0/N интерфейс молчал всё
// это время и выглядел зависшим (жалоба: «Опрашиваю… 4/112» появлялся не всегда).
// Заодно при смене сети подпись «Сейчас: …» должна меняться сразу, а не после
// первого товара следующей сети.
// Отказ отдельной точки при живой сети (протухший прайс магазина) обязан НЕ
// растить strikes и НЕ ставить сети паузу: сеть отвечает, живой магазин другого
// города работает, а две протухшие позиции подряд (позиции одного магазина в
// `prices_history` идут подряд) выключили бы всю сеть целиком.
{
  db.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('svt-1', 'svetofor', 'moscow', '820', 100)`,
  );
  const staleAdapter: StoreAdapter = {
    storeId: 'svetofor',
    async search() {
      return [];
    },
    async fetchProduct() {
      throw new StaleStoreError('прайс магазина 376 протух', 'svetofor:376');
    },
  };
  const staleProgress: Array<[number, number]> = [];
  const first = await pollOnce(db, new Map([['svetofor', staleAdapter]]), {
    delayMs: 0,
    onProgress: (done, total) => void staleProgress.push([done, total]),
  });
  assert.equal(first.failed, 1, 'отказ точки посчитан отказом');
  assert.deepEqual(first.staleStores, ['svetofor:376'], 'точка названа в отчёте');
  assert.deepEqual(first.failedStores, ['svetofor'], 'сеть тоже помечена, но по своей причине');
  db.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('svt-2', 'svetofor', 'moscow', '820', 100)`,
  );
  const second = await pollOnce(db, new Map([['svetofor', staleAdapter]]), { delayMs: 0 });
  assert.equal(second.failed, 2, 'вторая позиция тоже обработана');
  assert.ok(
    staleProgress.some(([done, total]) => done < total),
    'прогресс двигается и на отказе протухшей точки',
  );
  assert.equal(
    db.exec(`SELECT COUNT(*) FROM prices_history WHERE store_id = 'svetofor'`)?.[0]?.values[0]?.[0],
    2,
    'цены не переписаны мусором: протухшая точка ничего не пишет в историю',
  );
}

// --- Чек-лист цикла: повторный прогон берёт только неповеренное и ошибочное ---
// Запрос пользователя: «при прогоне составляется список опрошенных, при повторном
// нажатии опрашиваются только не опрошенные и с ошибками, а когда прогон прошёл
// полностью — снова все».
{
  // openDb держит одну базу на процесс, поэтому предыдущую закрываем.
  closeDb();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sch-list-')), 'c.db');
  const db = await openDb(fileStorageAt(file));
  for (const id of ['a1', 'a2', 'a3']) {
    db.run(`INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES (?, 'magnit', 'moscow', '303857', 100)`, [id]);
  }
  const asked: string[] = [];
  const flaky: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string, ctx: { externalStoreId: string }) {
      asked.push(canonicalId);
      // Один товар всегда падает: он обязан остаться в целях навсегда.
      if (canonicalId === 'a3') throw new Error('сеть молчит');
      const p: ScrapedProduct = {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
        storeCode: ctx.externalStoreId,
        name: 'Тест',
        price: 100,
        collectedAt: new Date().toISOString(),
      };
      return p;
    },
  };
  const runs = new Map([['magnit', flaky]]);
  const opts = { delayMs: 0, city: 'moscow', resume: true };

  const first = await pollOnce(db, runs, opts);
  assert.equal(first.interrupted, false, 'первый прогон не прерван');
  assert.equal(asked.length, 3, 'первый прогон спрашивает всё');
  assert.equal(first.remaining, 0, 'полный прогон закрывает цикл');

  // Полный цикл прошёл — по требованию пользователя следующий прогон снова всё.
  asked.length = 0;
  const afterFull = await pollOnce(db, runs, opts);
  assert.equal(asked.length, 3, 'после полного прохода чек-лист обнулён, прогон идёт по всем');

  // Прерываем на середине: остаток уходит в следующий прогон.
  asked.length = 0;
  const askedFirstHalf = 1;
  const interrupted = await pollOnce(db, runs, { ...opts, isCancelled: () => asked.length >= askedFirstHalf });
  assert.equal(interrupted.interrupted, true, 'прогон помечен прерванным');
  assert.equal(asked.length, askedFirstHalf, `прерван после ${askedFirstHalf} товара`);
  assert.equal(interrupted.remaining, 3 - askedFirstHalf, 'сводка говорит, сколько осталось');

  // Вот ради чего всё затевалось: повторное нажатие спрашивает НЕ всё, а остаток.
  asked.length = 0;
  const resumed = await pollOnce(db, runs, opts);
  assert.equal(resumed.interrupted, false, 'докачка дошла до конца');
  assert.equal(asked.length, 3 - askedFirstHalf, 'докачивается ровно остаток, а не все заново');
  closeDb();
}

// --- Прерывание до первого товара: чек-лист не тронут ------------------------
// Отмена сразу: прогон должен выйти, ничего не спросив и не записав.
{
  // openDb держит одну базу на процесс, поэтому предыдущую закрываем.
  closeDb();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sch-cancel-')), 'd.db');
  const db = await openDb(fileStorageAt(file));
  db.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('b1', 'magnit', 'moscow', '303857', 100)`,
  );
  const asked: string[] = [];
  const spy: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string, ctx: { externalStoreId: string }) {
      asked.push(canonicalId);
      const p: ScrapedProduct = {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
        storeCode: ctx.externalStoreId,
        name: 'Тест',
        price: 100,
        collectedAt: new Date().toISOString(),
      };
      return p;
    },
  };
  const out = await pollOnce(db, new Map([['magnit', spy]]), {
    delayMs: 0,
    city: 'moscow',
    resume: true,
    isCancelled: () => true,
  });
  assert.equal(asked.length, 0, 'отменённый прогось не ходит в сеть');
  assert.equal(out.interrupted, true, 'помечен прерванным');
  assert.equal(out.remaining, 1, 'осталось всё, что не проверено');
  // Чек-лист не тронут: следующий запуск берёт тот же товар.
  asked.length = 0;
  await pollOnce(db, new Map([['magnit', spy]]), { delayMs: 0, city: 'moscow', resume: true });
  assert.deepEqual(asked, ['b1'], 'после отмены товар остался не проверенным');
  closeDb();
}

// --- «Не проверенные» (notReady) остаются целями следующего прогона ---------
// Товар без готового магазина (5ka вне Москвы ready:false) не опрошён, но цикл
// считается полным. Если бы он попадал в чек-лист, такие товары замерзли бы
// навсегда, а пользователь об этом не узнал бы.
{
  // openDb держит одну базу на процесс, поэтому предыдущую закрываем.
  closeDb();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sch-nr-')), 'e.db');
  const db = await openDb(fileStorageAt(file));
  // Порядок вставки = порядок выдачи `SELECT DISTINCT` без сортировки, поэтому
  // notReady-товар идёт ПЕРВЫМ и гарантированно обрабатывается до отмены.
  db.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('nr1', 'pyaterochka', 'moscow', '35XY', 100)`,
  );
  // Третий успешный товар нужен, чтобы отмена сработала: проверка идёт ПЕРЕД
  // товаром, а на двух последний закрывает цикл — и прерывания не будет.
  for (const id of ['ok1', 'ok2', 'ok3']) {
    db.run(
      `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES (?, 'magnit', 'moscow', '303857', 100)`,
      [id],
    );
  }
  let calls = 0;
  const spy: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string, ctx: { externalStoreId: string }) {
      calls += 1;
      const p: ScrapedProduct = {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
        storeCode: ctx.externalStoreId,
        name: 'Тест',
        price: 100,
        collectedAt: new Date().toISOString(),
      };
      return p;
    },
  };
  // Прогон ПРЕРВАН после двух успешных товаров: полный проход всё равно чистит
  // чек-лист, и на нём проверка «notReady не отмечен» была бы вакуумной —
  // зелёной при любом коде.
  const off = await pollOnce(db, new Map([['magnit', spy]]), {
    delayMs: 0,
    city: 'moscow',
    resume: true,
    isCancelled: () => calls >= 2,
  });
  assert.equal(off.interrupted, true, 'прогон прерван, чек-лист не очищен — иначе проверка была бы вхолостую');
  assert.equal(off.notReady, 1, 'нет адаптера — это notReady, а не ошибка');
  assert.equal(
    db.exec(`SELECT COUNT(*) FROM poll_checklist WHERE canonical_id = 'nr1'`)?.[0]?.values[0]?.[0],
    0,
    'notReady в чек-лист не пишется: товар не проверен и обязан вернуться в целях',
  );
  assert.equal(
    db.exec(`SELECT COUNT(*) FROM poll_checklist WHERE canonical_id = 'ok1'`)?.[0]?.values[0]?.[0],
    1,
    'а проверенный — отмечен (значит проверка выше не проходит «за компанию»)',
  );
  closeDb();
}

// --- Прерванный прогон не пишет метку времени города ------------------------
// Иначе «проверяли час назад» отложило бы автозапуск на полный интервал, и
// остаток цикла ждал бы только ручного нажатия.
{
  closeDb();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sch-stamp-')), 'h.db');
  const db = await openDb(fileStorageAt(file));
  db.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('s1', 'magnit', 'moscow', '303857', 100)`,
  );
  // Метка от прошлого полного прогона.
  db.run(`INSERT INTO poll_meta (city, last_run) VALUES ('moscow', '2026-10-01T00:00:00.000Z')`);
  const spy: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string, ctx: { externalStoreId: string }) {
      const p: ScrapedProduct = {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
        storeCode: ctx.externalStoreId,
        name: 'Тест',
        price: 100,
        collectedAt: new Date().toISOString(),
      };
      return p;
    },
  };
  await pollOnce(db, new Map([['magnit', spy]]), {
    delayMs: 0,
    city: 'moscow',
    resume: true,
    isCancelled: () => true,
  });
  assert.equal(
    getLastRun(db, 'moscow'),
    '2026-10-01T00:00:00.000Z',
    'прерванный прогон не двигает метку города',
  );
  closeDb();
}

// --- Ошибочный товар остаётся целью ПРЕРВАННОГО цикла ----------------------
// Это и есть «не опрошенные и с ошибками» из требования: ошибка не должна
// попасть в чек-лист даже когда прогон оборвался на следующем товаре.
{
  closeDb();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sch-err-')), 'i.db');
  const db = await openDb(fileStorageAt(file));
  for (const id of ['e1', 'e2', 'e3']) {
    db.run(
      `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES (?, 'magnit', 'moscow', '303857', 100)`,
      [id],
    );
  }
  const asked: string[] = [];
  const adapter: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string, ctx: { externalStoreId: string }) {
      asked.push(canonicalId);
      if (canonicalId === 'e1') throw new Error('сеть молчит');
      const p: ScrapedProduct = {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
        storeCode: ctx.externalStoreId,
        name: 'Тест',
        price: 100,
        collectedAt: new Date().toISOString(),
      };
      return p;
    },
  };
  // Первым идёт e1 (порядок вставки) и он падает; отмена — на третьем товаре.
  const firstRun = await pollOnce(db, new Map([['magnit', adapter]]), {
    delayMs: 0,
    city: 'moscow',
    resume: true,
    isCancelled: () => asked.length >= 2,
  });
  assert.equal(firstRun.failed, 1, 'ошибка посчитана');
  assert.equal(firstRun.interrupted, true, 'прогон прерван');
  assert.equal(
    db.exec(`SELECT COUNT(*) FROM poll_checklist WHERE canonical_id = 'e1'`)?.[0]?.values[0]?.[0],
    0,
    'ошибочный товар не отмечен даже в прерванном цикле',
  );
  // Докачка возвращает ошибочный в цели.
  asked.length = 0;
  await pollOnce(db, new Map([['magnit', adapter]]), { delayMs: 0, city: 'moscow', resume: true });
  assert.ok(asked.includes('e1'), `ошибочный товар вернулся в цели докачки (спросили: ${asked.join(',')})`);
  closeDb();
}

// --- Отметка не должна ронять прогон ----------------------------------------
// Упавшая запись в чек-лист означала бы «scheduled poll failed» и потерю цен,
// уже собранных за прогон. Худшее — товар переспросится.
{
  // openDb держит одну базу на процесс, поэтому предыдущую закрываем.
  closeDb();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sch-mark-')), 'f.db');
  const db = await openDb(fileStorageAt(file));
  db.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('m1', 'magnit', 'moscow', '303857', 100)`,
  );
  const spy: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string, ctx: { externalStoreId: string }) {
      const p: ScrapedProduct = {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
        storeCode: ctx.externalStoreId,
        name: 'Тест',
        price: 100,
        collectedAt: new Date().toISOString(),
      };
      return p;
    },
  };
  // Ломаем таблицу чек-листа: любая запись в неё теперь падает.
  db.run('DROP TABLE poll_checklist');
  const warnings: string[] = [];
  const r = await pollOnce(db, new Map([['magnit', spy]]), {
    delayMs: 0,
    city: 'moscow',
    resume: true,
    log: { ...consoleLogger, warn: (m: string) => void warnings.push(m) },
  });
  assert.equal(r.skipped, 1, 'цена записана, прогон не упал');
  assert.ok(warnings.some((w) => w.includes('poll checklist')), 'ошибка отметки громкая, но не фатальная');
  assert.ok(fs.existsSync(file), 'база сохранена');
  closeDb();
}

// --- Цикл закрыт: повторный прогон не делает вид, что проверил всё ------------
// Сценарий: все цели отмечены (например, автопрогон закрыл цикл, а чек-лист
// остался с прошлого). Молчаливый пустой отчёт выглядел бы как «опросил и
// ничего не нашёл», поэтому нужен явный текст И обнуление чек-листа — иначе
// город остался бы «проверенным» навсегда.
{
  closeDb();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sch-done-')), 'g.db');
  const db = await openDb(fileStorageAt(file));
  db.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('c1', 'magnit', 'moscow', '303857', 100)`,
  );
  const asked: string[] = [];
  const spy: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string, ctx: { externalStoreId: string }) {
      asked.push(canonicalId);
      const p: ScrapedProduct = {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
        storeCode: ctx.externalStoreId,
        name: 'Тест',
        price: 100,
        collectedAt: new Date().toISOString(),
      };
      return p;
    },
  };
  // Помечаем товар проверенным так, будто прошлый прогон его закрыл.
  db.run(`INSERT INTO poll_checklist (city, store_id, store_code, canonical_id) VALUES ('moscow', 'magnit', '${magnitMoscow}', 'c1')`);
  const lines: string[] = [];
  const out = await pollOnce(db, new Map([['magnit', spy]]), {
    delayMs: 0,
    city: 'moscow',
    resume: true,
    log: { ...consoleLogger, info: (m: string) => void lines.push(m) },
  });
  assert.equal(asked.length, 0, 'в сеть не ходим: проверять нечего');
  assert.ok(
    lines.some((l) => l.includes('уже проверены')),
    `прямо сказано, что всё проверено (лог: ${lines.join(' | ')})`,
  );
  assert.equal(out.remaining, 1, 'отчёт показывает объём закрытого цикла');
  assert.equal(
    db.exec(`SELECT COUNT(*) FROM poll_checklist WHERE city = 'moscow'`)?.[0]?.values[0]?.[0],
    0,
    'чек-лист обнулён, иначе город остался бы «проверенным» навсегда',
  );
  // Следующий прогон снова всё опрашивает.
  await pollOnce(db, new Map([['magnit', spy]]), { delayMs: 0, city: 'moscow', resume: true });
  assert.deepEqual(asked, ['c1'], 'после закрытия цикла прогон идёт по всем заново');
  closeDb();
}

// --- Упавшая запись базы при закрытии цикла — не тишина ----------------------
// Здесь persistDb вызывается на ветке «всё уже проверено». Молчаливый прогресс
// значил бы, что чистка чек-листа потерялась, а пользователь об этом не узнает.
{
closeDb();
  // Каталог под базой — обычный ФАЙЛ: `mkdirSync` в storage упрётся в ENOTDIR и
  // запись упадёт. База живёт в памяти (sql.js), поэтому открыть её можно.
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sch-persist-')), 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const file = path.join(blocker, 'j.db');
  const db = await openDb(fileStorageAt(file));
  db.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('z1', 'magnit', 'moscow', '303857', 100)`,
  );
  db.run(`INSERT INTO poll_checklist (city, store_id, store_code, canonical_id) VALUES ('moscow', 'magnit', '${magnitMoscow}', 'z1')`);
  const errors: string[] = [];
  const out = await pollOnce(db, new Map<string, StoreAdapter>(), {
    delayMs: 0,
    city: 'moscow',
    resume: true,
    log: { ...consoleLogger, error: (m: string) => void errors.push(m) },
  });
  assert.ok(errors.some((m) => m.includes('persist')), `падение записи базы громкое (лог: ${errors.join(' | ')})`);
  assert.equal(out.failed, 1, 'счётчик провалов вырос');
  assert.ok(out.failedStores.includes('база данных'), 'и виновата названа база, а не сеть');
  closeDb();
}

// Первый прогресс уходит ДО первого товара. У браузерных сетей первый запрос
// включает прогрев сессии и занимает минуты: без события 0/N интерфейс молчал всё
// это время и выглядел зависшим (жалоба: «Опрашиваю… 4/112» появлялся не всегда).
// Заодно при смене сети подпись «Сейчас: …» обязана меняться сразу, а не после
// первого товара следующей сети. Блок идёт последним: база переоткрыта на
// чистом файле, добавленные строки не могут задеть чужие счётчики выше.
{
  const file2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-prog-')), 't.db');
  const db2 = await openDb(fileStorageAt(file2));
  db2.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('prog-m', 'magnit', 'moscow', '303857', 100)`,
  );
  db2.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price) VALUES ('prog-l', 'lenta', 'moscow', '4161', 200)`,
  );
  const lentaFake: StoreAdapter = {
    storeId: 'lenta',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string, ctx: { city: string; externalStoreId: string }) {
      const p: ScrapedProduct = {
        canonicalId,
        storeId: 'lenta',
        city: ctx.city,
        storeCode: ctx.externalStoreId,
        name: 'Тест',
        price,
        promoPrice: null,
        oldPrice: null,
        collectedAt: new Date().toISOString(),
      };
      return p;
    },
  };
  const events: Array<[number, number, string | undefined]> = [];
  await pollOnce(db2, new Map([['magnit', fake], ['lenta', lentaFake]]), {
    delayMs: 0,
    onProgress: (done, total, storeId) => void events.push([done, total, storeId]),
  });
  assert.equal(events[0]?.[0], 0, 'счётчик стартует с нуля, а не с первого товара');
  assert.equal(events[0]?.[1], 2, 'в первом событии уже известен объём');
  const switchAt = events.findIndex((e, i) => i > 0 && e[2] !== events[0]?.[2]);
  assert.ok(switchAt > 0, `смена сети объявлена: ${JSON.stringify(events)}`);
  assert.equal(
    events[switchAt]?.[0],
    events[switchAt - 1]?.[0],
    `смена сети объявлена сразу, а не после её первого товара: ${JSON.stringify(events)}`,
  );
  closeDb();
  fs.rmSync(path.dirname(file2), { recursive: true, force: true });
}

// --- Шаг 7: опрос идёт по ТОЧКЕ, а не по сети -------------------------------
// У двух точек одной сети товар один и тот же (sku общий), и раньше опрос брал
// первую точку из справочника: цена второй точки вечно оставалась старой, а
// запрос к сети уходил с кодом чужого магазина.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sch-two-'));
  const db2 = await openDb(fileStorageAt(path.join(dir, 't.db')));
  const moscow = CITY_STORES['moscow'];
  const second = {
    storeId: 'magnit' as const,
    name: 'Магнит, Пушкинская',
    externalStoreId: '990001',
    ready: true,
  };
  moscow?.push(second);
  const added = [second.externalStoreId, '540999'];
  const first = storesForCity('moscow', 'magnit')[0]?.externalStoreId ?? '';
  try {
  db2.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price)
     VALUES ('magnit-two', 'magnit', 'moscow', ?, 100),
            ('magnit-two', 'magnit', 'moscow', ?, 200)`,
    [first, second.externalStoreId],
  );

  const asked: { code: string; at: number; id: string }[] = [];
  const spy: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string, ctx: { externalStoreId: string }): Promise<ScrapedProduct> {
      asked.push({ code: ctx.externalStoreId, at: Date.now(), id: canonicalId });
      return {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
        storeCode: ctx.externalStoreId,
        name: 'Тест',
        price: 300,
        collectedAt: new Date().toISOString(),
      };
    },
  };

  const counts = await pollOnce(db2, new Map([['magnit', spy]]), { delayMs: 40, city: 'moscow' });
  assert.equal(counts.inserted, 2, 'обе точки опрошены');
  assert.deepEqual(
    asked.map((a) => a.code).sort(),
    [first, second.externalStoreId].sort(),
    'опрос спросил каждую точку по её коду, а не обе по первой',
  );

  // Пауза между точками одной сети: два запроса в один домен подряд — ровно то,
  // за что сеть банит.
  const gap = Math.abs(asked[1]!.at - asked[0]!.at);
  assert.ok(gap >= 30, `между точками одной сети стоит пауза (разрыв ${gap} мс)`);

  // Выбор — по ТОЧКАМ: включена одна точка из двух, и вторая не опрашивается.
  // По сети это выглядело бы одинаково, то есть снять вторую точку было бы
  // невозможно — а пользователь именно этим и пользуется.
  asked.length = 0;
  const onePoint = await pollOnce(db2, new Map([['magnit', spy]]), {
    delayMs: 0,
    city: 'moscow',
    pointKeys: [pointKey('magnit', first)],
  });
  assert.equal(
    onePoint.inserted + onePoint.skipped,
    1,
    'при выборе одной точки опрошена ровно одна (цена не изменилась, поэтому skipped)',
  );
  assert.deepEqual(
    asked.map((a) => a.code),
    [first],
    'и это именно выбранная точка, а не первая в справочнике',
  );
  asked.length = 0;
  const otherPoint = await pollOnce(db2, new Map([['magnit', spy]]), {
    delayMs: 0,
    city: 'moscow',
    pointKeys: [pointKey('magnit', second.externalStoreId)],
  });
  assert.deepEqual(
    asked.map((a) => a.code),
    [second.externalStoreId],
    'выбор второй точки опрашивает вторую, а не первую',
  );
  assert.equal(
    otherPoint.inserted + otherPoint.skipped,
    1,
    'и при выборе второй точки опрошена тоже ровно она',
  );

  // Цена легла в ключ СВОЕЙ точки: обе записи обновились независимо.
  for (const code of [first, second.externalStoreId]) {
    const hist = getPriceHistory(db2, {
      canonicalId: 'magnit-two',
      storeId: 'magnit',
      city: 'moscow',
      storeCode: code,
    });
    assert.equal(hist[hist.length - 1]?.price, 300, `цена точки ${code} обновилась`);
  }

  // Отслеживание без точки (перенесённая запись, sentinel) опрашивается по
  // первой рабочей точке и материализуется в её ключ, а не теряется.
  db2.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price)
     VALUES ('magnit-nopoint', 'magnit', 'moscow', ?, 50)`,
    [UNKNOWN_STORE_CODE],
  );
  asked.length = 0;
  await pollOnce(db2, new Map([['magnit', spy]]), { delayMs: 0, city: 'moscow' });
  assert.deepEqual(
    asked.filter((a) => a.id === 'magnit-nopoint').map((a) => a.code),
    [first],
    'отслеживание без точки ушло по первой рабочей точке сети',
  );

  // И тут же НЕ превращается во вторую цель на тот же товар и ту же точку:
  // sentinel-строка остаётся в истории навсегда, и без фильтра каждый цикл
  // спрашивал бы сеть дважды на один товар. Обе цели дали бы ОДИН и тот же
  // код точки, поэтому считаем запросы, а не коды.
  asked.length = 0;
  await pollOnce(db2, new Map([['magnit', spy]]), { delayMs: 0, city: 'moscow' });
  assert.equal(
    asked.filter((a) => a.id === 'magnit-nopoint').length,
    1,
    'после материализации sentinel-цель не опрашивается второй раз',
  );

  // Если материализованной строки нет, sentinel-цель обязана вернуться: иначе
  // перенесённая запись тихо перестала бы обновляться.
  db2.run(
    `DELETE FROM prices_history WHERE canonical_id = 'magnit-nopoint' AND store_code = ?`,
    [first],
  );
  asked.length = 0;
  await pollOnce(db2, new Map([['magnit', spy]]), { delayMs: 0, city: 'moscow' });
  assert.equal(
    asked.filter((a) => a.id === 'magnit-nopoint').length,
    1,
    'без точки-замены sentinel-цель снова опрашивается',
  );

  // Пока ни одной реальной точки по этому товару нет, sentinel-цель остаётся
  // целью: иначе перенесённая запись тихо перестала бы обновляться.
  db2.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price)
     VALUES ('magnit-lonely', 'magnit', 'moscow', ?, 50)`,
    [UNKNOWN_STORE_CODE],
  );
  asked.length = 0;
  await pollOnce(db2, new Map([['magnit', spy]]), { delayMs: 0, city: 'moscow' });
  assert.deepEqual(
    asked.filter((a) => a.id === 'magnit-lonely').map((a) => a.code),
    [first],
    'sentinel-цель без точки-замены остаётся целью',
  );

  // Код точки вне справочника — вечная цель: ни запроса, ни отметки, но и не
  // тишина, а запись в лог с названием точки.
  const warns: string[] = [];
  db2.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price)
     VALUES ('magnit-ghost', 'magnit', 'moscow', '777777', 50)`,
  );
  asked.length = 0;
  const ghost = await pollOnce(db2, new Map([['magnit', spy]]), {
    delayMs: 0,
    city: 'moscow',
    log: { ...consoleLogger, warn: (m: string) => void warns.push(m), error: () => {}, info: () => {} },
  });
  assert.equal(ghost.notReady, 1, 'цель с кодом вне справочника не опрошена, а не потеряна');
  assert.deepEqual(
    asked.filter((a) => a.id === 'magnit-ghost'),
    [],
    'в сеть по несуществующей точке не ходим',
  );
  assert.ok(
    warns.some((w) => w.includes('777777')),
    `и пользователь видит причину в логе, а не только «не проверено 1»: ${warns.join(' | ').slice(0, 160)}`,
  );

  // Призрак (код вне справочника) НЕ считается точкой: иначе он подавил бы
  // sentinel-цель того же товара, и товар ушёл бы в вечный notReady вместо
  // одного нормального опроса по живой точке.
  db2.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price)
     VALUES ('magnit-ghost2', 'magnit', 'moscow', '?', 50),
            ('magnit-ghost2', 'magnit', 'moscow', '666666', 50)`,
  );
  asked.length = 0;
  const withGhost = await pollOnce(db2, new Map([['magnit', spy]]), { delayMs: 0, city: 'moscow' });
  assert.equal(
    asked.filter((a) => a.id === 'magnit-ghost2' && a.code === first).length,
    1,
    'sentinel-цель не подавилась строкой-призраком и опросила живую точку',
  );
  assert.equal(
    asked.filter((a) => a.id === 'magnit-ghost2' && a.code === '666666').length,
    0,
    'а по призраку в сеть не ходим',
  );
  assert.equal(
    withGhost.notReady,
    2,
    'призраки (777777 из прошлой проверки и 666666) посчитаны неготовыми, а sentinel ушёл в опрос',
  );

  // Точка есть в справочнике, но сеть её ещё не дотянула (ready: false): цель
  // ждёт, а не считается несуществующей — и предупреждения в лог не даёт.
  warns.length = 0;
  moscow?.push({
    storeId: 'pyaterochka' as const,
    name: 'Пятёрочка, тестовая',
    externalStoreId: '540999',
    ready: false,
  });
  db2.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price)
     VALUES ('pyat-not-ready', 'pyaterochka', 'moscow', '540999', 50)`,
  );
  asked.length = 0;
  const waiting = await pollOnce(
    db2,
    new Map<string, StoreAdapter>([
      ['magnit', spy],
      [
        'pyaterochka',
        {
          storeId: 'pyaterochka',
          async search() {
            return [];
          },
          async fetchProduct(canonicalId: string): Promise<ScrapedProduct> {
            throw new Error('сеть не должна вызываться: точка не готова');
          },
        },
      ],
    ]),
    {
      delayMs: 0,
      city: 'moscow',
      pointKeys: [pointKey('pyaterochka', '540999')],
      onProgress: () => {},
      log: { ...consoleLogger, warn: (m: string) => void warns.push(m), error: () => {}, info: () => {} },
    },
  );
  assert.equal(waiting.notReady, 1, 'точка, до которой сеть не дотянула, осталась неопрошенной');
  assert.deepEqual(warns, [], 'и это не «точка вне справочника»: предупреждения не должно быть');

  // Цель без точки у сети, у которой в городе нет ни одной готовой точки:
  // сказать «код ? не найден в справочнике» было бы враньём — кода-то нет.
  warns.length = 0;
  db2.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, store_code, price)
     VALUES ('pyat-nopoint', 'pyaterochka', 'ulyanovsk', ?, 50)`,
    [UNKNOWN_STORE_CODE],
  );
  const noReadyPoint = await pollOnce(
    db2,
    new Map<string, StoreAdapter>([
      [
        'pyaterochka',
        {
          storeId: 'pyaterochka',
          async search() {
            return [];
          },
          async fetchProduct(): Promise<ScrapedProduct> {
            throw new Error('сеть не должна вызываться: готовых точек нет');
          },
        },
      ],
    ]),
    {
      delayMs: 0,
      city: 'ulyanovsk',
      onProgress: () => {},
      log: { ...consoleLogger, warn: (m: string) => void warns.push(m), error: () => {}, info: () => {} },
    },
  );
  assert.equal(noReadyPoint.notReady, 1, 'цель без точки у сети без готовых точек не опрашивается');
  assert.ok(
    warns.some((w) => w.includes('нет готовой точки')),
    `и сообщение говорит про отсутствие точки, а не про несуществующий код: ${warns.join(' | ').slice(0, 160)}`,
  );
  } finally {
    // Справочник глобальный: тестовые точки снимаются по коду и даже при
    // упавшем ассерте, иначе они поехали бы дальше по этому же процессу.
    for (const code of added) {
      const at = moscow?.findIndex((s) => s.externalStoreId === code) ?? -1;
      if (at >= 0) moscow?.splice(at, 1);
    }
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('scheduler: ALL GREEN');