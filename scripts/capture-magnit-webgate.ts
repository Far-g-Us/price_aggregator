// Снимает живой ответ webgate/v2/goods/search и кладёт урезанную фикстуру в
// tests/fixtures/magnit-webgate-search.json (форма ответа — контракт, который
// держит классификацию ошибок fetchProduct: pagination.totalCount).
//
// Рядом кладётся ФОРМА ответа (tests/fixtures/magnit-webgate-shape.json): пути
// ключей и типы значений, БЕЗ самих значений. Сравнивать живые данные в
// ночной проверке бессмысленно: цены, остатки, порядок товаров и счётчики
// меняются каждый день, и «форма поехала» не отличить от «цена изменилась».
//
// Тело запроса берётся из адаптера (buildSearchBody), а не пишется руками:
// своя копия правила однажды уже разъехалась с адаптером.
//
// Режим `--check`: ничего не писать, а только СРАВНИТЬ форму с эталоном
// (tests/fixtures/magnit-webgate-shape.json) и выйти с 1, если форма поехала.
// Так прогон не затирает закоммиченные фикстуры (юнит-тесты assert'ят живые
// значения оттуда) и умеет краснеть.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSearchBody } from '../src/core/adapters/magnit-webgate.js';

const SHOP = '473996';
const CHECK_ONLY = process.argv.includes('--check');

/**
 * Форма ответа — КОНТРАКТ, на который завязан парсер: имена полей верхнего
 * уровня с типами и множество типов полей товара.
 *
 * Почему не «слить типы по каждому полю топ-3»: у топ-3 товаров ежедневно
 * меняются необязательные поля (`promotion.oldPrice` null↔число, `badges`, число
 * картинок), и такая «форма» краснела бы на живых данных, а не на смене формы
 * ответа. Имена полей и типы меняются только когда сеть действительно поменяла
 * ответ.
 *
 * `null` в типах товара НЕ учитывается: пустое поле у одного товара сегодня и
 * непустое завтра — это данные, а не форма.
 */
function shapeOf(raw: unknown, items: unknown[]): { top: Record<string, string>; item: Record<string, string[]> } {
  const record = (raw ?? {}) as Record<string, unknown>;
  const top: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    if (key === '_note') continue;
    const value = record[key];
    if (key === 'items') top[key] = 'array';
    else if (value !== null && typeof value === 'object') top[key] = 'object';
    else top[key] = typeof value;
  }
  const itemTypes = new Map<string, Set<string>>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (value === null) continue;
      const set = itemTypes.get(key) ?? new Set<string>();
      set.add(typeof value);
      itemTypes.set(key, set);
    }
  }
  const item: Record<string, string[]> = {};
  for (const key of [...itemTypes.keys()].sort()) {
    item[key] = [...(itemTypes.get(key) as Set<string>)].sort();
  }
  return { top, item };
}

/**
 * Сравнение формы с эталоном: ловим смену формы (новое/пропавшее поле,
 * смена типа), а НЕ ежедневные колебания данных. Возвращает список
 * расхождений (пустой = совпало).
 */
function shapeDiff(expected: { top: Record<string, string>; item: Record<string, string[]> }, actual: typeof expected): string[] {
  const problems: string[] = [];
  for (const [key, type] of Object.entries(expected.top)) {
    if (!(key in actual.top)) problems.push(`пропал верхний уровень: ${key}`);
    else if (actual.top[key] !== type) problems.push(`сменился тип ${key}: ${type} → ${actual.top[key]}`);
  }
  for (const key of Object.keys(actual.top)) {
    if (!(key in expected.top)) problems.push(`появился верхний уровень: ${key}`);
  }
  for (const [key, types] of Object.entries(expected.item)) {
    const now = actual.item[key];
    if (!now) {
      problems.push(`пропалло поле товара: ${key}`);
      continue;
    }
    for (const t of now) {
      if (!types.includes(t)) problems.push(`новый тип поля ${key}: ${t}`);
    }
  }
  for (const key of Object.keys(actual.item)) {
    if (!(key in expected.item)) problems.push(`появилось поле товара: ${key}`);
  }
  return problems;
}

const res = await fetch('https://magnit.ru/webgate/v2/goods/search', {
  method: 'POST',
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
    Accept: 'application/json',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'Content-Type': 'application/json',
    Referer: 'https://magnit.ru/',
    Origin: 'https://magnit.ru',
    Cookie: `shopCode="${SHOP}"`,
  },
  body: buildSearchBody('молоко', SHOP),
  signal: AbortSignal.timeout(20000),
}).catch((e) => {
  // Сеть не ответила — это НЕ «форма уехала»: у Магнита 503/504 на этом
  // адресе — зафиксированное состояние сети. Ночная проверка не должна
  // краснеть из-за мигания, поэтому выходим с 2 («не проверено»).
  console.warn(`capture: сеть не ответила (${String(e).slice(0, 80)}) — проверка неубедительна`);
  process.exit(2);
});
console.log('HTTP', res.status);
if (!res.ok) {
  console.warn(`capture: сеть ответила HTTP ${res.status} — проверка неубедительна`);
  process.exit(2);
}
const raw = (await res.json()) as { items?: unknown[]; pagination?: unknown };
const items = Array.isArray(raw.items) ? raw.items : [];
console.log('товаров:', items.length, 'pagination:', JSON.stringify(raw.pagination));

// Три товара: разделённый по смыслу пример (обычный, с промо, без остатка).
const picked = items.slice(0, 3);
const target = resolve(import.meta.dirname, '..', 'tests', 'fixtures', 'magnit-webgate-search.json');
const shapeTarget = resolve(import.meta.dirname, '..', 'tests', 'fixtures', 'magnit-webgate-shape.json');
const shape = shapeOf(raw, items);

if (CHECK_ONLY) {
  // Сравниваем ФОРМУ (контракт парсера), а не живые значения: цены, остатки
  // и порядок товаров меняются ежедневно, и «форма уехала» было бы не
  // отличить от «цена изменилась». Сравнение — по РАЗОБРАННОМУ JSON, а не
  // побайтово: в репозитории переводы строк CRLF, и побайтовое сравнение
  // краснело бы на свежом клоне.
  if (!existsSync(shapeTarget)) {
    console.error(`capture: эталона формы нет (${shapeTarget}) — сними его: npm run magnit:fixture`);
    process.exit(1);
  }
  let expected: { top: Record<string, string>; item: Record<string, string[]> };
  try {
    expected = JSON.parse(readFileSync(shapeTarget, 'utf8'));
  } catch (e) {
    console.error(`capture: эталон формы не разбирается (${String(e).slice(0, 80)})`);
    process.exit(1);
  }
  const problems = shapeDiff(expected, shape);
  if (problems.length > 0) {
    console.error('capture: ФОРМА ответа изменилась — классификация ошибок может быть сломана');
    for (const p of problems) console.error(`  ${p}`);
    console.error('  посмотри diff: npm run magnit:fixture && git diff -- tests/fixtures/magnit-webgate-shape.json');
    process.exit(1);
  }
  console.log('capture: форма ответа совпала с эталоном');
  process.exit(0);
}

// Обычный режим: обновляем ТОЛЬКО эталон формы. Фикстуру с живыми данными
// (`magnit-webgate-search.json`) не трогаем: юнит-тесты assert'ят её значения
// (цена, остаток), и пересъёмка ломала бы их на ровном месте.
writeFileSync(shapeTarget, JSON.stringify(shape, null, 2) + '\n', 'utf8');
console.log('записано:', shapeTarget);
console.log(
  `  (фикстура с данными ${target} не перезаписана — её значения фиксируют тесты)`,
);
