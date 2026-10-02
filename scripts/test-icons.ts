// Система иконок проверяется, а не обещается в комментарии CategoryIcon.tsx.
//
// Раньше там было написано «сетка 24×24, содержимое живёт в поле 3..21 с
// центром 12,12» — и ничего этого не проверялось. Набор разъехался: у
// «колбасы» контур вылезал за поле (x от 2), а центры bbox стояли с 10,7 до
// 15,2 вместо 12,12, и колонка полок «прыгала» тем заметнее, чем мельче рендер.
//
// Разбор путей живёт в `icon-geometry.ts` — единственная копия. Две копии
// разбора уже стоили нам порченного рисунка, когда инструмент починки считал
// bbox «на глаз».
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { OUR_CATEGORIES } from '../src/shared/taxonomy.js';
import { CENTER, CENTER_TOL, FIELD_MAX, FIELD_MIN, parseIcons } from './icon-geometry.js';

const SRC = fs.readFileSync(path.resolve(import.meta.dirname, '../src/renderer/CategoryIcon.tsx'), 'utf8');
const icons = parseIcons(SRC);
const byStyle = (id: string, style: 'SOFT' | 'LINE' | 'FAINT'): number =>
  icons.find((i) => i.id === id)?.shapes.filter((s) => s.style === style).length ?? 0;

// 1) На каждую нашу категорию есть иконка, и лишних иконок нет.
const ids = icons.map((i) => i.id);
for (const c of OUR_CATEGORIES) {
  assert.ok(ids.includes(c.id), `нет иконки для категории «${c.id}»`);
}
for (const id of ids) {
  assert.ok(
    id === '__unassigned__' || OUR_CATEGORIES.some((c) => c.id === id),
    `иконка «${id}» не соответствует ни одной категории`,
  );
}
assert.ok(ids.includes('__unassigned__'), 'нужен fallback для товаров вне полок');

// 2) Геометрия: поле и центр — это и есть проверка «единой системы».
for (const { id, box } of icons) {
  assert.ok(
    box.minX >= FIELD_MIN && box.minY >= FIELD_MIN && box.maxX <= FIELD_MAX && box.maxY <= FIELD_MAX,
    `«${id}» выходит за поле ${FIELD_MIN}..${FIELD_MAX}: ` +
      `x ${box.minX.toFixed(2)}..${box.maxX.toFixed(2)}, y ${box.minY.toFixed(2)}..${box.maxY.toFixed(2)}`,
  );
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  assert.ok(
    Math.abs(cx - CENTER) <= CENTER_TOL && Math.abs(cy - CENTER) <= CENTER_TOL,
    `«${id}» смещена от центра ${CENTER},${CENTER}: центр ${cx.toFixed(2)},${cy.toFixed(2)}`,
  );
}

// 3) Толщина линий одна: иначе на мелком размере одна иконка «тяжелее».
const widths = [...SRC.matchAll(/strokeWidth:\s*([\d.]+)/g)].map((m) => m[1]);
assert.ok(widths.length > 0, 'не найдено ни одного strokeWidth');
assert.equal(new Set(widths).size, 1, `толщина линий разная: ${[...new Set(widths)].join(', ')}`);

// 4) Все три стиля объявлены: удаление FAINT оставило бы систему наполовину
//    рассыпанной, а тест молчал бы.
const styleDecl = (name: string): string => SRC.match(new RegExp(`const ${name} = \\{([^}]*)\\}`))?.[1] ?? '';
for (const style of ['SOFT', 'LINE', 'FAINT'] as const) {
  const decl = styleDecl(style);
  assert.ok(decl.length > 0, `стиль ${style} не объявлен`);
  assert.ok(/fill:/.test(decl), `в стиле ${style} нет fill — фигура отрендерится чёрной по умолчанию`);
}
assert.ok(/strokeWidth:/.test(styleDecl('SOFT')) && /strokeWidth:/.test(styleDecl('LINE')), 'у силуэта и детали должна быть обводка');

// 5) Разметка фигур: у каждой есть стиль. Фигура без стиля отрендерилась бы
//    дефолтной чёрной заливкой — силуэт чёрным на зелёном, и это проходилось.
for (const { id, shapes } of icons) {
  for (const s of shapes) {
    assert.ok(s.style, `у «${id}» фигура без стиля (SOFT/LINE/FAINT): ${s.raw.slice(0, 40)}…`);
  }
}

// 6) Детализация: у иконки есть и силуэт, и деталь. Проверка «хотя бы два
//    элемента» была слабой: у большинства иконок 3–4 элемента, и снятие
//    одной детали её не замечало.
//    Fallback «вне полок» — намеренно «голый» знак списка, без заливки: с
//    силуэтом он читался бы как ещё один товар.
for (const { id, elements, shapes } of icons) {
  assert.ok(elements >= 3, `у «${id}» всего ${elements} элемент(ов) — это почти силуэт`);
  // Деталь — это читаемый контур (LINE ≈ 3.8:1). FAINT (≈1.8:1) — «воздух»
  // и тень: он законен как фон, но не может считаться деталью, иначе проверка
  // прощала бы иконку без деталей.
  const details = shapes.filter((s) => s.style === 'LINE').length;
  assert.ok(details > 0, `у «${id}» нет ни одной читаемой детали (LINE)`);
  if (id !== '__unassigned__') {
    assert.ok(byStyle(id, 'SOFT') > 0, `у «${id}» нет залитого силуэта`);
  }
}

// 7) Баннер README. Отдельный файл, но рисуется теми же иконками и стоит
//    первым экраном репозитория, а tsc/vite/build его не читают вообще.
//    Ровно поэтому сюда попала проверка структуры: лишняя кавычка в
//    `scale(1.3333)""` не ломала ни один прогон, но делала standalone-SVG
//    невалидным XML — GitHub отдавал бы битую картинку вместо шапки.
//    Проверяем: атрибуты строго name="value", иконки стоят на сетке шага 54
//    по оптическому центру строки, а контраст текста на плашках держит AA.
let heroContrast = Infinity;
const heroPath = path.resolve(import.meta.dirname, '../assets/readme/hero.svg');
assert.ok(fs.existsSync(heroPath), 'нет assets/readme/hero.svg — шапка README пропала, а тест молчал бы');
{
  const hero = fs.readFileSync(heroPath, 'utf8');
  const TAG = /^<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s+[a-zA-Z][a-zA-Z0-9-]*="[^"<>]*")*\s*\/?>$/;
  for (const tag of hero.match(/<[a-zA-Z/][^<>]*>/g) ?? []) {
    assert.ok(TAG.test(tag), `в hero.svg битый тег — standalone-SVG не распарсится: ${tag.slice(0, 80)}`);
  }
  const bare = hero.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!bare.includes('&'), 'в hero.svg & без сущности — файл невалиден как XML');
  assert.ok(!bare.includes('--'), 'в hero.svg -- вне комментария — файл невалиден как XML');
  const iconGroups = [...hero.matchAll(/<g transform="translate\((\d+),(\d+)\) scale\(([\d.]+)\)"/g)];
  assert.equal(iconGroups.length, 4, `в hero.svg ожидалось 4 иконки полок, найдено ${iconGroups.length}`);
  // Строки баннера: [baseline, id полки]. Привязка по id, а не по номеру —
  // иначе вставка новой категории в CategoryIcon.tsx молча переспарила бы
  // строки и проверка выдала бы фантомное расхождение.
  const rows: [number, string][] = [[152, 'dairy'], [206, 'bakery'], [260, 'meat'], [314, 'vegetables']];
  iconGroups.forEach((m, i) => {
    const [, x, y, scale] = m;
    const [baseline, id] = rows[i] ?? [];
    const icon = icons.find((ic) => ic.id === id);
    assert.ok(icon && baseline !== undefined, `полка ${i + 1}: нет baseline или иконки «${id}»`);
    const centerY = (icon.box.minY + icon.box.maxY) / 2;
    const scaleN = Number(scale);
    const optical = baseline - 0.35 * 20;
    const got = Number(y) + centerY * scaleN;
    // Допуск 0.5, а не 1: у иконок с точным центром 12,0 сдвиг на юнит
    // давал ровно 1.0 и проходил. Реальные расхождения сейчас ≤ 0.4.
    assert.ok(
      Math.abs(got - optical) <= 0.5,
      `иконка полоки ${i + 1} («${icon.id}») стоит на ${got.toFixed(1)}, оптический центр строки ${optical}`,
    );
    assert.equal(Number(x), 640, `иконка полоки ${i + 1} должна стоять на x=640`);
  });
  // Контраст текста по WCAG, выведенный из самого файла, а не из списка пар:
  // захардкоженный список проверял бы уже несуществующие сочетания и молчал бы
  // после правки. Поверхность берётся по колонке: x ≥ 612 — белая карточка,
  // левее — кремовый фон.
  const lum = (hex: string): number => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  let worstContrast = Infinity;
  for (const tag of hero.match(/<text\b[^<>]*>[^<>]*<\/text>/g) ?? []) {
    const fill = /fill="(#[0-9a-f]{6})"/.exec(tag)?.[1];
    const xRaw = /x="(-?\d+)"/.exec(tag)?.[1];
    const size = Number(/font-size="([\d.]+)"/.exec(tag)?.[1] ?? '16');
    // Без fill или x текст молча выпал бы из проверки, а без x ещё и получил
    // бы кремовую поверхность вместо белой карточки. Оба атрибута обязательны.
    assert.ok(fill && xRaw, `в hero.svg <text> без ${fill ? 'x' : 'fill'} — он не проверяется на контраст: ${tag.slice(0, 70)}`);
    const x = Number(xRaw);
    const bg = x >= 612 ? '#ffffff' : '#ecfdf5';
    const bold = /font-weight="(6|7|bold)"/.test(tag);
    const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    const r = ratio(fill, bg);
    const label = (tag.match(/>([^<>]+)</)?.[1] ?? '').trim().slice(0, 22);
    assert.ok(
      r >= need,
      `контраст текста «${label}» (${size}px, ${fill} на ${bg}) = ${r.toFixed(2)}:1, ниже ${need}:1`,
    );
    worstContrast = Math.min(worstContrast, r);
  }
  assert.ok(worstContrast !== Infinity, 'в hero.svg не нашлось ни одного <text> для проверки контраста');
  heroContrast = worstContrast;
}

// Запас виден ДО того, как сработает проверка: иконка, едущая ровно на
// грани допуска, — это сигнал подтянуть её, а не «упереться и упасть».
const worst = icons
  .map((i) => ({
    id: i.id,
    dc: Math.max(Math.abs((i.box.minX + i.box.maxX) / 2 - CENTER), Math.abs((i.box.minY + i.box.maxY) / 2 - CENTER)),
  }))
  .sort((a, b) => b.dc - a.dc)[0];
console.log(
  `icons geometry: ALL GREEN — иконок ${icons.length}, поле ${FIELD_MIN}..${FIELD_MAX}, ` +
    `центр ${CENTER}±${CENTER_TOL}, обводка ${widths[0]}, худшее отклонение центра ` +
    `${worst?.id} ${(worst?.dc ?? 0).toFixed(2)}; hero.svg: 4 иконки по сетке, худший контраст текста ` +
    `${heroContrast.toFixed(2)}:1`,
);