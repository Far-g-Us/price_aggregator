// Геометрия иконок: единственный точный разбор путей.
//
// Раньше правило «поле 3..21, центр 12,12» было написано в комментарии
// CategoryIcon.tsx и не проверялось ничем. Набор разъехался: у «колбасы»
// контур вылезал за поле (x от 2), а центры bbox стояли с 10,7 до 15,2.
//
// Здесь разбор M L H V C S A Z в обоих регистрах, с относительными дельтами
// и точным bbox дуг по параметризации endpoint → center. Его использует
// `test-icons.ts`. Дублировать разбор нельзя: из-за двух копий инструмент
// починки считал bbox «на глаз» и портил рисунок — такой инструмент удалён,
// а числа в иконках выправлены вручную и зафиксированы тестом.
export const FIELD_MIN = 3;
export const FIELD_MAX = 21;
export const CENTER = 12;
/** Допуск центра bbox: пол-юнита незаметно, юнит — уже «прыгающая» колонка. */
export const CENTER_TOL = 0.6;

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface IconShape {
  /** Исходная геометрия: `d="…"` либо `<circle cx cy r>`. */
  raw: string;
  /** Позиция фигуры внутри тела иконки — фигуры идут в порядке документа. */
  at: number;
  /** Стиль фигуры. Отсутствует = фигура не размечена (тест должен поймать). */
  style: 'SOFT' | 'LINE' | 'FAINT' | undefined;
  /** Разобранные числа для переноса/масштаба (null для circle — см. circle). */
  kind: 'path' | 'circle';
  d?: string;
  cx?: number;
  cy?: number;
  r?: number;
  box: Box;
}

export interface IconGeometry {
  id: string;
  box: Box;
  elements: number;
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
  const tokens = d.match(/[MLHVCAZSmlhvcazs]|-?\d*\.?\d+/g) ?? [];
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
  const isCmd = (t: string | undefined): boolean => !!t && /^[MLHVCAZSmlhvcazs]$/.test(t);
  let lastCtrl: { x: number; y: number } | null = null;
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
        add(box, x, y);
        break;
      }
      case 'L': {
        const dx = num();
        const dy = num();
        x = rel ? x + dx : dx;
        y = rel ? y + dy : dy;
        lastCtrl = null;
        add(box, x, y);
        break;
      }
      case 'H': {
        const dx = num();
        x = rel ? x + dx : dx;
        lastCtrl = null;
        add(box, x, y);
        break;
      }
      case 'V': {
        const dy = num();
        y = rel ? y + dy : dy;
        lastCtrl = null;
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
        x = x3;
        y = y3;
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
        x = x2;
        y = y2;
        break;
      }
      case 'Z':
        break;
      default:
        throw new Error(`CategoryIcon: команда «${cmd}» не поддержана`);
    }
  }
  return box;
}

const merge = (into: Box, b: Box): void => {
  into.minX = Math.min(into.minX, b.minX);
  into.minY = Math.min(into.minY, b.minY);
  into.maxX = Math.max(into.maxX, b.maxX);
  into.maxY = Math.max(into.maxY, b.maxY);
};

/**
 * Какой стиль стоит сразу после фигуры — «{...SOFT}», «{...LINE}», «{...FAINT}».
 *
 * Ищем ВНУТРИ своего тега JSX: поиск по всему оставшемуся телу подхватывал
 * стиль СЛЕДУЮЩЕЙ фигуры, и снятие `{...LINE}` с кружка проходило тест
 * незамеченным. Граница тега — `/>`.
 */
function styleAfter(body: string, at: number): 'SOFT' | 'LINE' | 'FAINT' | undefined {
  const tagEnd = body.indexOf('/>', at);
  const tail = body.slice(at, tagEnd >= 0 ? tagEnd + 2 : at + 400);
  const m = tail.match(/\.\.\.(SOFT|LINE|FAINT)\b/);
  return m ? (m[1] as 'SOFT' | 'LINE' | 'FAINT') : undefined;
}

/** Разбирает весь блок PATHS файла иконок. */
export function parseIcons(src: string): IconGeometry[] {
  const from = src.indexOf('const PATHS');
  const to = src.indexOf('export function CategoryIcon');
  if (from < 0 || to < 0 || to <= from) {
    throw new Error('CategoryIcon.tsx: не найден блок PATHS или граница блока');
  }
  const block = src.slice(from, to);
  const out: IconGeometry[] = [];
  const entryRe = /^\s{2}'?([a-z0-9_-]+)'?:\s*\(([\s\S]*?)\n  \),/gm;
  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(block)) !== null) {
    const id = match[1] ?? '';
    const body = match[2] ?? '';
    const box = emptyBox();
    const shapes: IconShape[] = [];
    for (const d of body.matchAll(/\bd="([^"]+)"/g)) {
      const raw = d[0];
      const value = d[1] ?? '';
      const b = pathBox(value);
      merge(box, b);
      shapes.push({ kind: 'path', raw, d: value, box: b, at: d.index, style: styleAfter(body, d.index) });
    }
    for (const c of body.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)) {
      const cx = Number(c[1]);
      const cy = Number(c[2]);
      const r = Number(c[3]);
      const b: Box = { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
      merge(box, b);
      shapes.push({ kind: 'circle', raw: c[0], cx, cy, r, box: b, at: c.index, style: styleAfter(body, c.index) });
    }
    // Порядок документа важен для починки: замена идёт по позициям внутри тела.
    shapes.sort((a, b) => a.at - b.at);
    out.push({ id, box, elements: shapes.length, shapes });
  }
  return out;
}