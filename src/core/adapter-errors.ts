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

export function isProductLookupError(err: unknown): err is ProductLookupError {
  // Проверка по имени, а не instanceof: класс может оказаться в другом графе
  // модулей (worker, второй bundle), и instanceof перестал бы видеть его —
  // планировщик молча продолжил бы растить strikes, то есть откатился бы к
  // отключению сети на «не нашли».
  return err instanceof Error && err.name === 'ProductLookupError';
}
