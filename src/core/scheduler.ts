import type { Database } from 'sql.js';
import type { StoreAdapter } from '../shared/types.js';
import { CITY_STORES } from '../shared/catalog.js';
import { consoleLogger, type CoreLogger } from './platform.js';
import { isProductLookupError, isStaleStoreError } from './adapter-errors.js';
import {
  listTrackedProducts,
  type TrackedProduct,
  persistDb,
  savePriceIfChanged,
  toPriceInput,
  loadPollChecklist,
  markPollChecked,
  clearPollChecklist,
} from './db/db.js';

export interface PollCounts {
  inserted: number;
  skipped: number;
  failed: number;
  notReady: number;
  /** Сети, где что-то отвалилось: «ошибок 1» без имени сети бесполезно. */
  failedStores: string[];
  /**
   * Магазины, которые сеть перестала обновлять (протухший прайс точки). Сеть
   * при этом жива, поэтому они отделены от `failedStores`: те точки смотрят на
   * сбой сети, эти — на свои собственные данные.
   */
  staleStores: string[];
  /**
   * Прогон остановлен по просьбе пользователя (снял галочку магазина или сменил
   * город). Отличать надо именно это от «проверили N из M» обычного прогона:
   * собранное за прогон сохранено, но цикл города НЕ завершён — следующий запуск
   * докачает остаток, а не начнёт с нуля.
   */
  interrupted: boolean;
  /**
   * Сколько целей осталось в этом цикле: отслеживаемые минус уже проверенные на
   * этот момент. Без него повторное нажатие обещало бы «проверить всё», а
   * докачивало бы 7 товаров — ровно та неясность, ради которой всё затевалось.
   */
  remaining: number;
}

export interface PollOptions {
  /** Пауза между товарами: сеть враждебная, без пауз получишь блок. */
  delayMs?: number;
  onProgress?: (done: number, total: number, storeId?: string) => void;
  log?: CoreLogger;
  /**
   * Опрашивать только этот город. Опрос без фильтра бьёт по всем городам сразу,
   * а цены и наличие привязаны к магазину конкретного города: пользователь,
   * который смотрит Ульяновск, не запрашивал Москву. Пусто или undefined — все
   * города (прежнее поведение, нужно ручному запуску из консоли).
   */
  city?: string;
  /**
   * Опрашивать только эти сети. Выбор магазинов в шапке — это обещание
   * пользователю, а без фильтра прогресс обещал обход всех сетей города: при
   * одном выбранном магазине счётчик показывал «28/445», то есть обещал 445
   * позиций и ходил в выключенные сети тоже. Пустой массив — не «все», а
   * «нечего опрашивать»: пустой выбор пользователь выразить не может, поэтому
   * undefined — все сети (прежнее поведение, нужно ручному запуску из консоли).
   */
  storeIds?: string[];
  /**
   * Продолжать незаконченный цикл: пропускать то, что уже проверено в этом
   * цикле (см. `poll_checklist`). Товары с ошибками в чек-лист не попадают, то
   * есть «повторный опрос» берёт ровно «не проверенные и с ошибками».
   *
   * Выключено по умолчанию: выключено — поведение прежнее, обход всего подряд.
   */
  resume?: boolean;
  /**
   * Спросить «ещё не прерывали?» перед каждым товаром. Отмена кооперативная и
   * с точностью в один товар: уже начатый `fetchProduct` не дёргается, а у
   * браузерных сетей это до минуты, поэтому обещать мгновенную остановку нельзя.
   */
  isCancelled?: () => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Сети без ДОПОЛНИТЕЛЬНОЙ паузы между товарами.
 *
 * Обход идёт по очереди, и пауза ставится только между товарами ОДНОЙ сети:
 * переход к другой сети — это уже другая точка со своими лимитами, и ждать
 * после последнего товара сети незачем.
 *
 * Светофор: позиция лежит в кэшированном файле выгрузки, за неё в сеть не
 * уходит ни одного запроса, поэтому секунда ожидания отнимала у пользователя
 * время впустую.
 *
 * Ленты здесь НЕТ: её `fetchProduct` делает один-два запроса в сеть на товар, и
 * свой темп (2 с) она держит внутри адаптера. Убирать верхнюю секунду можно, но
 * причина тут не «запросов нет», а «пауза уже учтена» — и это важно, чтобы её
 * не сняли вместе с внутренней.
 */
const NO_DELAY_STORES = new Set(['svetofor']);

function pollDelayMs(storeId: string, base: number): number {
  return NO_DELAY_STORES.has(storeId) ? 0 : base;
}

/**
 * Пауза после позиции `i` — одна точка решения для ветвей с сетевым отказом и с
 * успешной обработкой. Раньше ветки отказа и протухшего прайса ждали мимо
 * правила, и даже Светофор платил по секунде на товар без единого запроса в сеть.
 * Ветки «не готов магазин» и «сеть на паузе» паузы не зовут сознательно: там
 * сетевого запроса не было вовсе, ждать нечего.
 */
function pauseBetween(targets: readonly TrackedProduct[], i: number, delayMs: number): Promise<void> | null {
  const current = targets[i];
  const next = targets[i + 1];
  if (current === undefined || next === undefined || next.storeId !== current.storeId) return null;
  const ms = pollDelayMs(current.storeId, delayMs);
  return ms > 0 ? sleep(ms) : null;
}

export async function pollOnce(
  database: Database,
  adapters: Map<string, StoreAdapter>,
  options: PollOptions = {},
): Promise<PollCounts> {
  const { delayMs = 1000, onProgress, log = consoleLogger, city, storeIds, resume, isCancelled } = options;
  const counts: PollCounts = {
    inserted: 0,
    skipped: 0,
    failed: 0,
    notReady: 0,
    failedStores: [],
    staleStores: [],
    interrupted: false,
    remaining: 0,
  };
  // Фильтр по городу И выбранным сетям ДО счётчика total: иначе прогресс
  // «3 из 76» обещает обход всей базы, а проходим мы 15 позиций своего города,
  // и «28 из 445» при одном магазине обещает обход сетей, которые выключены.
  //
  // Порядок СПЕЦИАЛЬНО без сортировки, и это не недосмотр: обход намеренно
  // чередует города, чтобы не закрывать и прогревать браузер на каждом переходе
  // (у Пятёрки и Чижика это минута прогрева НА КАЖДЫЙ товар). Сортировка по
  // городу здесь уронила бы эти сети в разы. Поэтому и «повторный прогон» не
  // переупорядочивает список — он просто выкидывает уже проверенное.
  const tracked = listTrackedProducts(database).filter(
    (t) => (!city || t.city === city) && (storeIds === undefined || storeIds.includes(t.storeId)),
  );
  // Чек-лист — вспомогательная структура: цены лежат в prices_history, и потеря
  // чек-листа не должна ронять прогон. Поэтому и чтение, и запись, и очистка
  // идут через безопасные обёртки: упавшее чтение даёт пустой список (опросит
  // всё — то есть поведение «как раньше»), упавшая запись оставляет товар
  // неотмеченным (он переспросится), упавшая очистка просто оставит цикл
  // незакрытым до следующего прогона.
  const readChecklist = (): Set<string> => {
    if (!resume || city === undefined) return new Set<string>();
    try {
      return loadPollChecklist(database, city);
    } catch (err) {
      log.warn(`poll checklist: не удалось прочитать отметки города ${city}`, err);
      return new Set<string>();
    }
  };
  const clearChecklistSafe = (): void => {
    if (!resume || city === undefined) return;
    try {
      clearPollChecklist(database, city);
    } catch (err) {
      log.warn(`poll checklist: не удалось очистить отметки города ${city}`, err);
    }
  };
  const checked = readChecklist();
  const targets = tracked.filter((t) => !checked.has(`${t.storeId}\u0000${t.canonicalId}`));
  if (targets.length === 0) {
    log.info(
      tracked.length > 0
        ? `опрос: все ${tracked.length} товаров города уже проверены в этом цикле`
        : `опрос: нет отслеживаемых товаров${city ? ` в городе ${city}` : ''}`,
    );
    counts.remaining = tracked.length;
    // Цикл фактически завершён: незакрытых целей не осталось. Чек-лист чистим,
    // иначе следующий запуск увидит «всё проверено» навсегда.
    //
    // persistDb тут обязателен: чистка это DELETE, а без записи он остался бы
    // только в памяти процесса до следующего полного прохода — то есть
    // перезапуск приложения вернул бы «всё проверено» обратно.
    clearChecklistSafe();
    try {
      persistDb(database);
    } catch (err) {
      log.error('poll persist failed', err);
      counts.failed += 1;
      if (!counts.failedStores.includes('база данных')) counts.failedStores.push('база данных');
    }
    return counts;
  }
  const startedAt = Date.now();
  // Сеть, которая только что упала по таймауту, почти наверняка упадёт и
  // снова: у Пятёрки это значит ещё 60 секунд на КАЖДЫЙ оставшийся товар, и
  // опрос на 76 позиций не заканчивается никогда. После двух отказов подряд
  // сеть выбывает, но НЕ навсегда: через RETRY_COOLDOWN_MS её пробуют снова,
  // потому что сеть могла отдохнуть (капча, кратковременный 429, смена IP).
  // Следующий плановый опрос стартует с чистого листа в любом случае.
  const STRIKE_LIMIT = 2;
  const RETRY_COOLDOWN_MS = 120_000;
  const strikes = new Map<string, number>();
  const disabledUntil = new Map<string, number>();
  let done = 0;
  // Отметка «проверено» не должна ронять прогон: ошибка записи ушла бы в catch
  // сервисов, и уже собранные за прогон цены не дошли бы до `persistDb`.
  // Худшее при потере отметки — товар переспросится в следующем цикле.
  const markSafe = (t: TrackedProduct): void => {
    if (!resume || city === undefined) return;
    try {
      markPollChecked(database, city, t.storeId, t.canonicalId);
    } catch (err) {
      log.warn(`poll checklist: не удалось отметить ${t.storeId} ${t.canonicalId}`, err);
    }
  };
  // Первый прогресс уходит ДО первого товара, а не после него: у браузерных
  // сетей первый запрос включает прогрев сессии и занимает минуты, и без этого
  // события интерфейс молчал всё это время — выглядело как зависший опрос.
  if (onProgress && targets.length > 0) {
    onProgress(0, targets.length, targets[0]?.storeId);
  }
  for (const t of targets) {
    // Отмена кооперативная и с точностью в один товар: уже начатый запрос у
    // браузерных сетей доживает сам, поэтому мгновенной остановки не обещаем.
    if (isCancelled?.() === true) {
      counts.interrupted = true;
      counts.remaining = targets.length - done;
      log.info(`опрос прерван пользователем: проверено ${done} из ${targets.length}, осталось ${counts.remaining}`);
      break;
    }
    const i = done;
    done += 1;
    // Смена сети объявляется сразу, а не после первого товара следующей сети:
    // иначе подпись «Сейчас: …» на минуты оставалась от прошлой сети, и по ней
    // нельзя было понять, где именно опрос застрял.
    if (onProgress && i > 0 && targets[i - 1]?.storeId !== t.storeId) {
      onProgress(i, targets.length, t.storeId);
    }
    const store = CITY_STORES[t.city]?.find((s) => s.storeId === t.storeId);
    const adapter = adapters.get(t.storeId);
    if (!store?.ready || !adapter) {
      counts.notReady += 1;
      if (onProgress) onProgress(i + 1, targets.length, t.storeId);
      continue;
    }
    const blockedUntil = disabledUntil.get(t.storeId) ?? 0;
    if (blockedUntil > Date.now()) {
      counts.notReady += 1;
      if (onProgress) onProgress(i + 1, targets.length, t.storeId);
      continue;
    }
    const itemStart = Date.now();
    try {
      const p = await adapter.fetchProduct(t.canonicalId, {
        city: t.city,
        externalStoreId: store.externalStoreId,
        name: t.name,
      });
      const r = savePriceIfChanged(database, {
        ...toPriceInput(p),
        canonicalId: t.canonicalId,
        storeId: t.storeId,
        city: t.city,
      });
      counts[r === 'inserted' ? 'inserted' : 'skipped'] += 1;
      // Отметка ставится и на «без изменений» (skipped): товар проверен, сеть
      // ответила, цена та же. Только успех кладёт товар в чек-лист — упавшие и
      // «не проверенные по сети» намеренно остаются целями следующего прогона.
      markSafe(t);
      strikes.set(t.storeId, 0);
      if (Date.now() - itemStart > 10_000) {
        log.info(`опрос: ${t.storeId} ${t.canonicalId} ${Date.now() - itemStart}мс`);
      }
    } catch (err) {
      // «Товар не найден» — не отказ сети: сеть ответила, просто товара нет.
      // Считаем его в failed (пользователь должен видеть), но strikes не
      // растим, иначе два переименованных товара выключат магазин целиком.
      if (isProductLookupError(err)) {
        counts.failed += 1;
        if (!counts.failedStores.includes(t.storeId)) counts.failedStores.push(t.storeId);
        log.warn(`poll: ${t.storeId} ${t.canonicalId} — ${err.message}`);
        if (onProgress) onProgress(i + 1, targets.length, t.storeId);
        await pauseBetween(targets, i, delayMs);
        continue;
      }
      // Отказ одной точки при живой сети (протухший прайс магазина): сеть
      // отвечает, поэтому ни strikes, ни пауза сети тут не растут — иначе две
      // такие позиции подряд выключили бы сеть вместе с живым магазином
      // другого города. Помечаем магазин в отчёте, чтобы это было видно.
      if (isStaleStoreError(err)) {
        counts.failed += 1;
        if (!counts.failedStores.includes(t.storeId)) counts.failedStores.push(t.storeId);
        if (!counts.staleStores.includes(err.storeKey)) counts.staleStores.push(err.storeKey);
        log.warn(`poll: ${t.storeId} ${t.canonicalId} — ${err.message}`);
        if (onProgress) onProgress(i + 1, targets.length, t.storeId);
        await pauseBetween(targets, i, delayMs);
        continue;
      }
      const fails = (strikes.get(t.storeId) ?? 0) + 1;
      strikes.set(t.storeId, fails);
      log.error(
        `poll item failed ${t.storeId} ${t.canonicalId} за ${Date.now() - itemStart}мс (${fails}-й подряд)`,
        err,
      );
      counts.failed += 1;
      if (!counts.failedStores.includes(t.storeId)) counts.failedStores.push(t.storeId);
      if (fails >= STRIKE_LIMIT) {
        disabledUntil.set(t.storeId, Date.now() + RETRY_COOLDOWN_MS);
        log.warn(
          `опрос: ${t.storeId} поставлена на паузу на ${Math.round(RETRY_COOLDOWN_MS / 1000)}с после ` +
            `${fails} отказов подряд — её товары до конца паузы остаются без проверки`,
        );
      }
    }
    if (onProgress) onProgress(i + 1, targets.length, t.storeId);
    // Пауза — между товарами ОДНОЙ сети и по правилу `pauseBetween` (тем же,
    // что и в ветках отказа): иначе успешный проход платил бы лишнюю секунду там,
    // где другие ветки её не платят, и дрейф повторился бы снова.
    await pauseBetween(targets, i, delayMs);
  }
  // Цикл дошёл до конца БЕЗ прерывания — значит взятый на себя объём сделан и
  // следующий прогон должен снова обойти всё (так просил пользователь: «когда
  // опрос прошёл полностью… будет опрашивать снова все»). Товары с ошибками в
  // чек-лист не попали, но полный проход это не мешает: цикл завершён целиком.
  // `remaining` при прерывании уже посчитан точным числом, а здесь — ноль.
  if (!counts.interrupted) {
    clearChecklistSafe();
    counts.remaining = 0;
  }
  try {
    persistDb(database);
  } catch (err) {
    // Молча терять запись нельзя: цены останутся только в памяти и исчезнут
    // при выходе. Считаем провалом опроса и пишем в лог.
    log.error('poll persist failed', err);
    counts.failed += 1;
    if (!counts.failedStores.includes('база данных')) counts.failedStores.push('база данных');
  }
  log.info(
    `опрос: ${targets.length} товаров за ${Math.round((Date.now() - startedAt) / 1000)}с — ` +
      `добавлено ${counts.inserted}, без изменений ${counts.skipped}, ошибок ${counts.failed}, не проверено ${counts.notReady}` +
      (counts.failedStores.length ? `; с ошибками: ${counts.failedStores.join(', ')}` : '') +
      // Протухшие точки видны в сводке: без неё по логу не отличить «сеть лежит»
      // от «сеть жива, но этот магазин она не обновляет».
      (counts.staleStores.length ? `; протухшие точки: ${counts.staleStores.join(', ')}` : '') +
      // Прерванный прогон обязан сказать, сколько осталось: иначе следующее
      // нажатие снова выглядит как «опросил всё».
      (counts.interrupted ? `; прерван, осталось ${counts.remaining}` : ''),
  );
  return counts;
}
