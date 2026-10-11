import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScrapedProduct, StoreAdapter } from '../src/shared/types.js';
import { CITY_STORES } from '../src/shared/catalog.js';
import { closeDb, getLastRun, getPriceHistory, openDb } from '../src/core/db/db.js';
import { fileStorageAt } from '../electron/node-files.js';
import { pollOnce } from '../src/core/scheduler.js';
import { StaleStoreError } from '../src/core/adapter-errors.js';
import { consoleLogger } from '../src/core/platform.js';
// печатает ошибки — в тестах это шум, мешающий прочитать результат.

const magnitMoscow = CITY_STORES.moscow?.find((s) => s.storeId === 'magnit')?.externalStoreId ?? '';

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
  `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('magnit-1', 'magnit', 'moscow', 100)`,
);

const r1 = await pollOnce(db, new Map([['magnit', fake]]), { delayMs: 0 });
assert.deepEqual(r1, { inserted: 0, skipped: 1, failed: 0, notReady: 0, failedStores: [], staleStores: [], interrupted: false, remaining: 0 });

price = 120;
const r2 = await pollOnce(db, new Map([['magnit', fake]]), { delayMs: 0 });
assert.deepEqual(r2, { inserted: 1, skipped: 0, failed: 0, notReady: 0, failedStores: [], staleStores: [], interrupted: false, remaining: 0 });

const hist = getPriceHistory(db, { canonicalId: 'magnit-1', storeId: 'magnit', city: 'moscow' });
assert.equal(hist.length, 2);
assert.equal(hist[0]?.price, 100);
assert.equal(hist[1]?.price, 120);
assert.ok(fs.existsSync(file), 'persisted after poll');

// Опрос бьёт только по выбранному городу. Цена привязана к магазину города,
// поэтому обход всех городов одной кнопкой — это запросы туда, куда
// пользователь не смотрел (и лишние обращения к сети).
{
  const magnitUlyanovsk = CITY_STORES.ulyanovsk?.find((s) => s.storeId === 'magnit')?.externalStoreId ?? '';
  db.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('magnit-uly', 'magnit', 'ulyanovsk', 500)`,
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
    `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('magnit-2', 'magnit', 'moscow', 300)`,
  );
  db.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('pyat-1', 'pyaterochka', 'moscow', 100)`,
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
    storeIds: ['magnit'],
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
    storeIds: [],
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
    db.run(`INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('svt-1', 'svetofor', 'moscow', 100)`);
    db.run(`INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('svt-2', 'svetofor', 'moscow', 100)`);
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
      storeIds: ['svetofor'],
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
    db.run(`INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('svt-3', 'svetofor', 'moscow', 100)`);
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
  `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('magnit-2', 'magnit', 'moscow', 120)`,
);
db.run(
  `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('x-1', 'nostore', 'moscow', 5)`,
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
    `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('svt-1', 'svetofor', 'moscow', 100)`,
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
    `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('svt-2', 'svetofor', 'moscow', 100)`,
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
    db.run(`INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES (?, 'magnit', 'moscow', 100)`, [id]);
  }
  const asked: string[] = [];
  const flaky: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string) {
      asked.push(canonicalId);
      // Один товар всегда падает: он обязан остаться в целях навсегда.
      if (canonicalId === 'a3') throw new Error('сеть молчит');
      const p: ScrapedProduct = {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
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
    `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('b1', 'magnit', 'moscow', 100)`,
  );
  const asked: string[] = [];
  const spy: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string) {
      asked.push(canonicalId);
      const p: ScrapedProduct = {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
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
    `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('nr1', 'pyaterochka', 'moscow', 100)`,
  );
  // Третий успешный товар нужен, чтобы отмена сработала: проверка идёт ПЕРЕД
  // товаром, а на двух последний закрывает цикл — и прерывания не будет.
  for (const id of ['ok1', 'ok2', 'ok3']) {
    db.run(
      `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES (?, 'magnit', 'moscow', 100)`,
      [id],
    );
  }
  let calls = 0;
  const spy: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string) {
      calls += 1;
      const p: ScrapedProduct = {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
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
    `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('s1', 'magnit', 'moscow', 100)`,
  );
  // Метка от прошлого полного прогона.
  db.run(`INSERT INTO poll_meta (city, last_run) VALUES ('moscow', '2026-10-01T00:00:00.000Z')`);
  const spy: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string) {
      const p: ScrapedProduct = {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
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
      `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES (?, 'magnit', 'moscow', 100)`,
      [id],
    );
  }
  const asked: string[] = [];
  const adapter: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string) {
      asked.push(canonicalId);
      if (canonicalId === 'e1') throw new Error('сеть молчит');
      const p: ScrapedProduct = {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
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
    `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('m1', 'magnit', 'moscow', 100)`,
  );
  const spy: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string) {
      const p: ScrapedProduct = {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
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
    `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('c1', 'magnit', 'moscow', 100)`,
  );
  const asked: string[] = [];
  const spy: StoreAdapter = {
    storeId: 'magnit',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string) {
      asked.push(canonicalId);
      const p: ScrapedProduct = {
        canonicalId,
        storeId: 'magnit',
        city: 'moscow',
        name: 'Тест',
        price: 100,
        collectedAt: new Date().toISOString(),
      };
      return p;
    },
  };
  // Помечаем товар проверенным так, будто прошлый прогон его закрыл.
  db.run(`INSERT INTO poll_checklist (city, store_id, canonical_id) VALUES ('moscow', 'magnit', 'c1')`);
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
    `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('z1', 'magnit', 'moscow', 100)`,
  );
  db.run(`INSERT INTO poll_checklist (city, store_id, canonical_id) VALUES ('moscow', 'magnit', 'z1')`);
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
    `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('prog-m', 'magnit', 'moscow', 100)`,
  );
  db2.run(
    `INSERT INTO prices_history (canonical_id, store_id, city, price) VALUES ('prog-l', 'lenta', 'moscow', 200)`,
  );
  const lentaFake: StoreAdapter = {
    storeId: 'lenta',
    async search() {
      return [];
    },
    async fetchProduct(canonicalId: string, ctx: { city: string }) {
      const p: ScrapedProduct = {
        canonicalId,
        storeId: 'lenta',
        city: ctx.city,
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

console.log('scheduler: ALL GREEN');
