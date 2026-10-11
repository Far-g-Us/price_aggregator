/**
 * Ошибки адаптера, которые НЕ являются отказом сети.
 *
 * Разница принципиальная для планировщика: сетевой отказ (401, таймаут, смена
 * формата ответа) говорит «сеть лежит» и после двух подряд таких отказов
 * выключает магазин на паузу. А «товар не найден» или «у товара нет названия» —
 * это про конкретный товар: сеть жива и отвечает. Если считать такое отказом
 * сети, то два переименованных товара подряд выключат всю сеть до конца
 * прохода, а пользователь увидит «ошибок 2» вместо «не нашлось двух товаров».
 */
export class ProductLookupError extends Error {
  readonly productId: string;

  constructor(message: string, productId: string) {
    super(message);
    this.name = 'ProductLookupError';
    this.productId = productId;
  }
}

/**
 * Отказ отдельной точки при живой сети: сеть перестала обновлять прайс этого
 * магазина (у Светофора так бывает — точка протухла на два года).
 *
 * Отдельный класс нужен потому, что такой отказ не должен выключать сеть: сеть
 * отвечает, и живой магазин другого города с той же сетью работает. Если
 * считать это сетевым отказом, то две протухшие позиции подряд (а `prices_history`
 * читается без `ORDER BY`, так что позиции одного магазина идут подряд) поставят
 * на паузу всю сеть вместе с живым магазином, и после кулдауна картина
 * повторится.
 */
export class StaleStoreError extends Error {
  readonly storeKey: string;

  constructor(message: string, storeKey: string) {
    super(message);
    this.name = 'StaleStoreError';
    this.storeKey = storeKey;
  }
}

export function isProductLookupError(err: unknown): err is ProductLookupError {
  // Проверка по имени, а не instanceof: класс может оказаться в другом графе
  // модулей (worker, второй bundle), и instanceof перестал бы видеть его —
  // планировщик молча продолжил бы растить strikes, то есть откатился бы к
  // отключению сети на «не нашли».
  return err instanceof Error && err.name === 'ProductLookupError';
}

/** Отказ отдельной точки при живой сети. См. `StaleStoreError`. */
export function isStaleStoreError(err: unknown): err is StaleStoreError {
  return err instanceof Error && err.name === 'StaleStoreError';
}
