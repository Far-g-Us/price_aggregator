// Геометрия иконок: единственный точный разбор путей.
//
// Раньше правило «поле 3..21, центр 12,12» было написано в комментарии
// CategoryIcon.tsx и не проверялось ничем. Набор разъехался: у «колбасы»
// контур вылезал за поле (x от 2), а центры bbox стояли с 10,7 до 15,2.
//
// Иконки набора — Font Awesome Free (CC BY 4.0), и сетка у них другая:
// 960 юнитов = 24 px, viewBox «0 −960 960 960». Правило то же самое, только
// в юнитах набора: глиф не выходит за свою сетку и стоит по центру.
//
// Здесь разбор M L H V C S A Q T Z в обоих регистрах, с относительными
// дельтами и точным bbox дуг по параметризации endpoint → center, а
// квадратичных — по экстремумам производной. Его использует `test-icons.ts`.
// Дублировать разбор нельзя: из-за двух копий инструмент починки считал
// bbox «на глаз» и портил рисунок — такой инструмент удалён, а числа в
// иконках зафиксированы тестом.

/** Квадрат иконки: 24×24 — как у самого приложения (h-8 w-8 и крупнее). */
export const FIELD = 24;
/**
 * Большая сторона ЧЕРНИЛ иконки в юнитах квадрата: 20 из 24, то есть поля по 2
 * юнита с каждой стороны.
 *
 * Общая СЕТКА не даёт общей оптики: в шрифтовом наборе высота чернил гуляет
 * (у Font Awesome — от 514 до 880 юнитов исходника, в 1,7 раза), и часть
 * иконок читалась бы как «крупный знак», часть — как «мелкий значок в пустом
 * квадрате». Это та же «прыгающая колонка», ради которой набор и брался.
 *
 * Что она НЕ даёт — одинаковой ПЛОТНОСТИ чернил: у «ножки» это две тонкие
 * палки, у «зерна» — восемь залитых точек. Плотность выровнять можно было бы
 * по площади, но это правка самих глифов, а не раскладки: набор Font Awesome
 * сбалансирован по плотности, и ломать его своей нормализацией не стоит.
 */
export const INK_TARGET = 20;
/**
 * Нижняя кромка чернил в юнитах квадрата: одинаковая у всех.
 *
 * В плитке полки под иконкой подпись, и зритель цепляется за НИЗ чернил — если
 * он гуляет (у набора от −40 до −280 юнитов исходника, то есть 6,7 px в сетке
 * полок), иконка «провисает» к подписи.
 */
export const INK_BOTTOM = 22;
/** Центр по горизонтали: одинаковый у всех. */
export const INK_CENTER_X = 12;

/** Масштаб и сдвиг, приводящие глиф к общей оптике набора. */
export interface GlyphFit {
  s: number;
  dx: number;
  dy: number;
}

/** Нормализация глифа: общий вес, общая нижняя кромка, центр по горизонтали. */
export function normalizeGlyph(box: Box): GlyphFit {
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  const max = Math.max(w, h);
  const s = max > 0 ? INK_TARGET / max : 1;
  const cx = (box.minX + box.maxX) / 2;
  return { s, dx: INK_CENTER_X - s * cx, dy: INK_BOTTOM - s * box.maxY };
}

/** Bbox глифа после нормализации — то, что реально видно. */
export function normalizedBox(box: Box, fit: GlyphFit): Box {
  return {
    minX: fit.dx + fit.s * box.minX,
    minY: fit.dy + fit.s * box.minY,
    maxX: fit.dx + fit.s * box.maxX,
    maxY: fit.dy + fit.s * box.maxY,
  };
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface IconShape {
  /** Разобранный путь глифа. */
  d: string;
  /** Bbox после нормализации оптики — то, что видно на экране. */
  box: Box;
}

export interface IconGeometry {
  id: string;
  /** Имя иконки в наборе (для отчёта и проверки, что набор один). */
  name: string;
  /** Объявленная нормализация оптики (её проверяет тест). */
  fit: GlyphFit;
  /** Исходный bbox глифа, до нормализации. */
  raw: Box;
  /** Bbox после нормализации — то, что видно на экране. */
  box: Box;
  shapes: IconShape[];
}

const emptyBox = (): Box => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

function add(box: Box, x: number, y: number): void {
  if (x < box.minX) box.minX = x;
  if (x > box.maxX) box.maxX = x;
  if (y < box.minY) box.minY = y;
  if (y > box.maxY) box.maxY = y;
}

function sampleCubic(
  box: Box,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
): void {
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const u = 1 - t;
    add(
      box,
      u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    );
  }
}

/**
 * Точный bbox квадратичной кривой: экстремумы по производной (плюс концы).
 * Нужна для путей набора — там кривые заданы командами `q`/`t`.
 */
function sampleQuadratic(
  box: Box,
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
): void {
  add(box, x0, y0);
  add(box, x1, y1);
  const extremum = (a: number, b: number, c: number): number | null => {
    const den = a - 2 * b + c;
    if (Math.abs(den) < 1e-9) return null;
    const t = (a - b) / den;
    return t > 0 && t < 1 ? t : null;
  };
  const tx = extremum(x0, cx, x1);
  if (tx !== null) {
    const u = 1 - tx;
    add(
      box,
      u * u * x0 + 2 * u * tx * cx + tx * tx * x1,
      u * u * y0 + 2 * u * tx * cy + tx * tx * y1,
    );
  }
  const ty = extremum(y0, cy, y1);
  if (ty !== null) {
    const u = 1 - ty;
    add(
      box,
      u * u * x0 + 2 * u * ty * cx + ty * ty * x1,
      u * u * y0 + 2 * u * ty * cy + ty * ty * y1,
    );
  }
}

/** Точный bbox эллиптической дуги SVG (параметризация endpoint → center). */
function sampleArc(
  box: Box,
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  largeArc: number,
  sweep: number,
  x2: number,
  y2: number,
): void {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
    add(box, x2, y2);
    return;
  }
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = dx2;
  const y1p = dy2;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const k = Math.sqrt(lambda);
    rx *= k;
    ry *= k;
  }
  const sign = largeArc === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cxp + (x1 + x2) / 2;
  const cy = cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (sweep === 0 && delta > 0) delta -= 2 * Math.PI;
  if (sweep === 1 && delta < 0) delta += 2 * Math.PI;
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const t = theta1 + (delta * i) / N;
    add(box, cx + rx * Math.cos(t), cy + ry * Math.sin(t));
  }
}

/** Разбор `d` в bbox. Понимает абсолютные и относительные команды. */
export function pathBox(d: string): Box {
  const box = emptyBox();
  const tokens = d.match(/[MLHVCAZSQTLmlhvcazsqtl]|-?\d*\.?\d+/g) ?? [];
  let i = 0;
  let x = 0;
  let y = 0;
  let cmd = '';
  const num = (): number => {
    const v = Number(tokens[i]);
    i += 1;
    if (!Number.isFinite(v)) throw new Error(`CategoryIcon: не число в пути «${d}» (токен ${i} из ${tokens.length})`);
    return v;
  };
  const isCmd = (t: string | undefined): boolean => !!t && /^[MLHVCAZSQTLmlhvcazsqtl]$/.test(t);
  let lastCtrl: { x: number; y: number } | null = null;
  // Контрольная точка последней квадратичной кривой: нужна команде `t`, где
  // она отражается от предыдущей (в пути набора это `T`/`t`).
  let lastQuadCtrl: { x: number; y: number } | null = null;
  while (i < tokens.length) {
    if (isCmd(tokens[i])) {
      cmd = String(tokens[i]);
      i += 1;
    }
    const rel = cmd >= 'a' && cmd <= 'z';
    switch (cmd.toUpperCase()) {
      case 'M': {
        const dx = num();
        const dy = num();
        x = rel ? x + dx : dx;
        y = rel ? y + dy : dy;
        cmd = rel ? 'l' : 'L';
        lastCtrl = null;
        lastQuadCtrl = null;
        add(box, x, y);
        break;
      }
      case 'L': {
        const dx = num();
        const dy = num();
        x = rel ? x + dx : dx;
        y = rel ? y + dy : dy;
        lastCtrl = null;
        lastQuadCtrl = null;
        add(box, x, y);
        break;
      }
      case 'H': {
        const dx = num();
        x = rel ? x + dx : dx;
        lastCtrl = null;
        lastQuadCtrl = null;
        add(box, x, y);
        break;
      }
      case 'V': {
        const dy = num();
        y = rel ? y + dy : dy;
        lastCtrl = null;
        lastQuadCtrl = null;
        add(box, x, y);
        break;
      }
      case 'C': {
        const p1x = num();
        const p1y = num();
        const p2x = num();
        const p2y = num();
        const ex = num();
        const ey = num();
        const x1 = rel ? x + p1x : p1x;
        const y1 = rel ? y + p1y : p1y;
        const x2 = rel ? x + p2x : p2x;
        const y2 = rel ? y + p2y : p2y;
        const x3 = rel ? x + ex : ex;
        const y3 = rel ? y + ey : ey;
        sampleCubic(box, x, y, x1, y1, x2, y2, x3, y3);
        lastCtrl = { x: x2, y: y2 };
        lastQuadCtrl = null;
        x = x3;
        y = y3;
        break;
      }
      case 'S': {
        const p2x = num();
        const p2y = num();
        const ex = num();
        const ey = num();
        const x1 = lastCtrl ? 2 * x - lastCtrl.x : x;
        const y1 = lastCtrl ? 2 * y - lastCtrl.y : y;
        const x2 = rel ? x + p2x : p2x;
        const y2 = rel ? y + p2y : p2y;
        const x3 = rel ? x + ex : ex;
        const y3 = rel ? y + ey : ey;
        sampleCubic(box, x, y, x1, y1, x2, y2, x3, y3);
        lastCtrl = { x: x2, y: y2 };
        lastQuadCtrl = null;
        x = x3;
        y = y3;
        break;
      }
      case 'Q': {
        const p1x = num();
        const p1y = num();
        const ex = num();
        const ey = num();
        const x1 = rel ? x + p1x : p1x;
        const y1 = rel ? y + p1y : p1y;
        const x2 = rel ? x + ex : ex;
        const y2 = rel ? y + ey : ey;
        sampleQuadratic(box, x, y, x1, y1, x2, y2);
        lastQuadCtrl = { x: x1, y: y1 };
        lastCtrl = null;
        x = x2;
        y = y2;
        break;
      }
      case 'T': {
        const ex = num();
        const ey = num();
        const x2 = rel ? x + ex : ex;
        const y2 = rel ? y + ey : ey;
        const x1: number = lastQuadCtrl ? 2 * x - lastQuadCtrl.x : x;
        const y1: number = lastQuadCtrl ? 2 * y - lastQuadCtrl.y : y;
        sampleQuadratic(box, x, y, x1, y1, x2, y2);
        lastQuadCtrl = { x: x1, y: y1 };
        lastCtrl = null;
        x = x2;
        y = y2;
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const rot = num();
        if (rot !== 0) throw new Error(`CategoryIcon: поворот дуги ${rot} тест не считает`);
        const largeArc = num();
        const sweep = num();
        const ex = num();
        const ey = num();
        const x2 = rel ? x + ex : ex;
        const y2 = rel ? y + ey : ey;
        sampleArc(box, x, y, rx, ry, largeArc, sweep, x2, y2);
        lastCtrl = null;
        lastQuadCtrl = null;
        x = x2;
        y = y2;
        break;
      }
      case 'Z':
        lastCtrl = null;
        lastQuadCtrl = null;
        break;
      default:
        throw new Error(`CategoryIcon: команда «${cmd}» не поддержана`);
    }
  }
  return box;
}

/**
 * Разбирает блок ICONS файла иконок: записи вида
 * `id: { name: '…', d: '…', s: …, dx: …, dy: … }`.
 */
export function parseIcons(src: string): IconGeometry[] {
  const from = src.indexOf('const ICONS');
  const to = src.indexOf('export function CategoryIcon');
  if (from < 0 || to < 0 || to <= from) {
    throw new Error('CategoryIcon.tsx: не найден блок ICONS или граница блока');
  }
  const block = src.slice(from, to);
  const out: IconGeometry[] = [];
  const entryRe =
    /^\s{2}'?([a-z0-9_-]+)'?:\s*\{\s*name:\s*'([^']+)',\s*d:\s*'([^']+)',\s*s:\s*([\d.]+),\s*dx:\s*(-?[\d.]+),\s*dy:\s*(-?[\d.]+)\s*\},/gm;
  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(block)) !== null) {
    const id = match[1] ?? '';
    const name = match[2] ?? '';
    const d = match[3] ?? '';
    const fit: GlyphFit = { s: Number(match[4]), dx: Number(match[5]), dy: Number(match[6]) };
    const raw = pathBox(d);
    const b = normalizedBox(raw, fit);
    const shapes: IconShape[] = [{ d, box: b }];
    out.push({ id, name, fit, raw, box: b, shapes });
  }
  return out;
}