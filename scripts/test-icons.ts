// Система иконок проверяется, а не обещается в комментарии CategoryIcon.tsx.
//
// Раньше там было написано «сетка 24×24, содержимое живёт в поле 3..21 с
// центром 12,12» — и ничего этого не проверялось. Набор разъехался: у
// «колбасы» контур вылезал за поле, а центры рисунка стояли с 10,7 до 15,2
// вместо 12,12, и колонка полок «прыгала» тем заметнее, чем мельче рендер.
//
// Теперь набор — Font Awesome Free (Solid), и проверяется то, что на самом
// деле держит колонку ровной:
//   • у каждой полки есть иконка, лишних нет;
//   • ОБЩИЙ ВЕС (большая сторона чернил) и ОБЩАЯ НИЖНЯЯ КРОМКА — это и есть
//     «единая оптика»: без них часть иконок читалась бы как «крупный знак»,
//     часть — как «мелкий значок в пустом квадрате»;
//   • путь в приложении — ТОТ ЖЕ, что в исходнике набора и в шапке README
//     (провенанс: «иконки в приложении и в шапке — одни и те же»);
//   • в файле один viewBox (24×24) и один способ заливки.
//
// Разбор путей живёт в `icon-geometry.ts` — единственная копия. Две копии
// разбора уже стоили нам порченного рисунка, когда инструмент починки считал
// bbox «на глаз».
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { OUR_CATEGORIES } from '../src/shared/taxonomy.js';
import {
  FIELD,
  INK_BOTTOM,
  INK_CENTER_X,
  INK_TARGET,
  normalizeGlyph,
  normalizedBox,
  parseIcons,
  pathBox,
} from './icon-geometry.js';

const SRC = fs.readFileSync(path.resolve(import.meta.dirname, '../src/renderer/CategoryIcon.tsx'), 'utf8');
const icons = parseIcons(SRC);

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

// 2) Общая оптика: одинаковый вес и одинаковая нижняя кромка. Это и есть
//    «единая система»: без этого колонка прыгает по вертикали.
for (const { id, raw, fit, box } of icons) {
  const expected = normalizeGlyph(raw);
  assert.ok(
    Math.abs(fit.s - expected.s) < 0.001 &&
      Math.abs(fit.dx - expected.dx) < 0.5 &&
      Math.abs(fit.dy - expected.dy) < 0.5,
    `у «${id}» нормализация оптики не совпадает с расчётной ` +
      `(s ${fit.s} против ${expected.s.toFixed(5)})`,
  );
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  const max = Math.max(w, h);
  assert.ok(
    Math.abs(max - INK_TARGET) <= 0.5,
    `у «${id}» вес ${max.toFixed(1)} юнитов, а у набора ${INK_TARGET} — иконка «прыгает»`,
  );
  assert.ok(
    Math.abs(box.maxY - INK_BOTTOM) <= 0.5,
    `у «${id}» нижняя кромка ${box.maxY.toFixed(1)}, а у набора ${INK_BOTTOM} — иконка провисает к подписи`,
  );
  const cx = (box.minX + box.maxX) / 2;
  assert.ok(
    Math.abs(cx - INK_CENTER_X) <= 0.5,
    `у «${id}» центр по горизонтали ${cx.toFixed(1)}, а у набора ${INK_CENTER_X}`,
  );
  // Глиф внутри своего квадрата.
  assert.ok(
    box.minX >= 0 && box.minY >= 0 && box.maxX <= FIELD && box.maxY <= FIELD,
    `у «${id}» глиф выходит за квадрат ${FIELD}×${FIELD}: ` +
      `x ${box.minX.toFixed(1)}..${box.maxX.toFixed(1)}, y ${box.minY.toFixed(1)}..${box.maxY.toFixed(1)}`,
  );
}

// 3) Один набор — один viewBox, и он ЗАДАНО: иконка с чужим viewBox съехала бы
//    по оптическому центру, и колонка снова «прыгала» бы.
const viewBoxes = [...SRC.matchAll(/viewBox="([^"]+)"/g)].map((m) => m[1]);
assert.ok(viewBoxes.length > 0, 'в CategoryIcon.tsx нет ни одного viewBox');
assert.equal(new Set(viewBoxes).size, 1, `viewBox'ы разные: ${[...new Set(viewBoxes)].join(', ')}`);
assert.equal(viewBoxes[0], '0 0 24 24', `viewBox набора изменён: ${viewBoxes[0]}`);

// 4) Цвет задаётся один раз через currentColor: иначе смена палитры (янтарный
//    акцент виртуальной полки) разъехалась бы с заливкой контуров.
assert.ok(/fill="currentColor"/.test(SRC), 'иконки заливаются не через currentColor');
assert.ok(/var\(--color-primary\)/.test(SRC), 'цвет иконки задан не из палитры приложения');
assert.ok(/var\(--color-warnline\)/.test(SRC), 'акцентный цвет иконки задан не из палитры приложения');

// 5) Провенанс: путь в приложении — ТОТ ЖЕ, что в исходнике набора.
for (const { id, name, shapes } of icons) {
  const srcPath = path.resolve(import.meta.dirname, '..', 'assets', 'icons', `${name}.svg`);
  assert.ok(fs.existsSync(srcPath), `нет исходника иконки ${name} (assets/icons/${name}.svg)`);
  const raw = fs.readFileSync(srcPath, 'utf8');
  assert.ok(raw.includes('<svg'), `исходник ${name} не SVG`);
  const source = /d="([^"]+)"/.exec(raw)?.[1] ?? '';
  assert.equal(shapes[0]?.d, source, `путь «${id}» в приложении разошёлся с исходником ${name}.svg`);
}

// 6) Баннер README. Отдельный файл, но рисуется теми же иконками и стоит
//    первым экраном репозитория, а tsc/vite/build его не читают вообще.
//    Ровно поэтому сюда попали проверки: лишняя кавычка в `scale(1.3333)""` не
//    ломала ни один прогон, но делала standalone-SVG невалидным XML — GitHub
//    отдавал бы страницу с ошибкой парсера вместо шапки.
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
  // Баланс тегов: лишний `</g>` ломал XML, и шапка показывалась как ошибка
  // парсера (такое уже было с лишними кавычками).
  const opens = (bare.match(/<g[\s>]/g) ?? []).length;
  const closes = (bare.match(/<\/g>/g) ?? []).length;
  assert.equal(opens, closes, `в hero.svg теги <g> и </g> не сбалансированы: ${opens} и ${closes}`);

  // Иконки полок: те же пути, что в приложении, и правильная позиция.
  const iconGroups = [
    ...hero.matchAll(
      /<g transform="translate\(640,([\d.]+)\) scale\(([\d.]+)\)">\s*<g transform="translate\((-?[\d.]+)[ ,](-?[\d.]+)\) scale\(([\d.]+)\)"><path d="([^"]+)"[^>]*\/><\/g>/g,
    ),
  ];
  assert.equal(iconGroups.length, 4, `в hero.svg ожидалось 4 иконки полок, найдено ${iconGroups.length}`);
  // Строки баннера: [baseline, id полки]. Порядок зашит по id, а не вычисляется
  // из самого файла: вычисление сделало бы проверку тождеством.
  const rows: [number, string][] = [
    [184, 'dairy'],
    [234, 'bakery'],
    [284, 'meat'],
    [334, 'vegetables'],
  ];
  iconGroups.forEach((m, i) => {
    const [, tyRaw, scaleRaw, dxRaw, dyRaw, sRaw, d] = m;
    const [baseline, id] = rows[i] ?? [];
    const icon = icons.find((ic) => ic.id === id);
    assert.ok(icon && baseline !== undefined, `полка ${i + 1}: нет baseline или иконки «${id}»`);
    // Тот же путь, что в приложении: иначе «одни и те же иконки» — только слова.
    assert.equal(d, icon!.shapes[0]?.d, `иконка полки ${i + 1} («${id}») в шапке — не та, что в приложении`);
    assert.ok(
      Math.abs(Number(dxRaw) - icon!.fit.dx) <= 0.5 &&
        Math.abs(Number(dyRaw) - icon!.fit.dy) <= 0.5 &&
        Math.abs(Number(sRaw) - icon!.fit.s) <= 0.001,
      `нормализация оптики иконки полки ${i + 1} («${id}») в шапке разошлась с приложением`,
    );
    // Позиция: оптический центр строки (baseline − 0.35·fontsize) минус центр
    // чернил иконки (12 юнитов) в масштабе шапки.
    const scale = Number(scaleRaw);
    const optical = baseline - 0.35 * 20;
    const got = Number(tyRaw) + 12 * scale;
    assert.ok(
      Math.abs(got - optical) <= 0.5,
      `иконка полки ${i + 1} («${id}») стоит на ${got.toFixed(1)}, оптический центр строки ${optical}`,
    );
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
    // Дробный x законен: подпись чипа сети центрируется и стоит на полупикселе
    // (903,5). Запрещать дробь значило бы запрещать text-anchor="middle" —
    // ради одного этого правила проверка молча выпала бы из контраста.
    const xRaw = /x="(-?\d+(?:\.\d+)?)"/.exec(tag)?.[1];
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

// Запас виден ДО того, как сработает проверка: иконка, едущая ровно на грани
// допуска, — это сигнал подтянуть её, а не «упереться и упасть».
const worst = icons
  .map((i) => ({
    id: i.id,
    dw:
      Math.abs(Math.max(i.box.maxX - i.box.minX, i.box.maxY - i.box.minY) - INK_TARGET) +
      Math.abs(i.box.maxY - INK_BOTTOM),
  }))
  .sort((a, b) => b.dw - a.dw)[0];
console.log(
  `icons geometry: ALL GREEN — иконок ${icons.length}, квадрат ${FIELD}×${FIELD}, вес ${INK_TARGET}±0.5, ` +
    `нижняя кромка ${INK_BOTTOM}±0.5, худшее отклонение ${worst?.id} ${(worst?.dw ?? 0).toFixed(2)}; ` +
    `hero.svg: 4 иконки по оптическому центру, худший контраст текста ${heroContrast.toFixed(2)}:1`,
);
