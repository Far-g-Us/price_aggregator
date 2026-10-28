// Иконки наших категорий — Font Awesome Free (Solid), набор зафиксирован
// зависимостью `@fortawesome/fontawesome-free` в package.json, поэтому
// пересборка не зависит от сети.
//
//   npm run icons:fetch
//
// Скрипт берёт SVG из node_modules, нормализует оптику (общий вес и общая
// нижняя кромка в квадрате 24×24) и пересобирает:
//   • блок ICONS в src/renderer/CategoryIcon.tsx;
//   • те же иконки в шапке README (assets/readme/hero.svg).
//
// Почему Font Awesome, а не шрифтовой набор с тонкими контурами: пиктограммы
// еды в таких наборах абстрактны («у молока коробка», «у масла окно»,
// «у сыров рыба») — в колонке полок они не читались. Здесь каждая полка
// названа своим предметом: сыр, ножка, бекон, морковь, яблоко.
//
// Лицензия иконок — CC BY 4.0 (атрибуция в README и NOTICE), текст —
// assets/icons/LICENSE.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeGlyph, pathBox } from './icon-geometry.js';

/** Наша полка → иконка Font Awesome (solid). */
const MAPPING: [id: string, fa: string][] = [
  // Мясо и птица — корова; курица и индейка — ножка с костью; колбаса —
  // сосиска в булке (у FA нет пиктограммы колбасы, а «мясной шарик в облаке»
  // читался непонятно, а бекон — не про всю полку); масло — банка.
  ['meat', 'cow'],
  ['meat-chicken', 'drumstick-bite'],
  ['sausage', 'hotdog'],
  // Молоко — бутылка с каплей; кефир и йогурты — стакан; сыры — кусок сыра;
  // масло — банка (у масла нет отдельной пиктограммы, банка читается верно).
  ['dairy', 'egg'],
  ['dairy-milk', 'bottle-droplet'],
  ['dairy-fermented', 'glass-water'],
  ['dairy-cheese', 'cheese'],
  ['dairy-butter', 'jar'],
  // Хлеб и выпечка — колос; хлеб и батоны — ломтик хлеба (наоборот было
  // неудобно: уточнение про хлеб показывало колос, а корень — ломтик).
  ['bakery', 'wheat-awn'],
  ['bakery-bread', 'bread-slice'],
  ['groceries-flour', 'building-wheat'],
  // Овощи — морковь; фрукты — яблоко; бакалея — корзинка; напитки — чашка;
  // быт и химия — канистра с чистящим; вне полок — строки списка.
  ['vegetables', 'carrot'],
  ['fruit', 'apple-whole'],
  ['groceries', 'basket-shopping'],
  ['drinks', 'mug-hot'],
  ['household', 'jug-detergent'],
  ['__unassigned__', 'list'],
];

const ROOT = resolve(import.meta.dirname, '..');
const FA_DIR = resolve(ROOT, 'node_modules', '@fortawesome', 'fontawesome-free', 'svgs', 'solid');
const ICONS_DIR = resolve(ROOT, 'assets', 'icons');
const TARGET = resolve(ROOT, 'src', 'renderer', 'CategoryIcon.tsx');
const HERO = resolve(ROOT, 'assets', 'readme', 'hero.svg');

if (!existsSync(FA_DIR)) {
  console.error('icons: нет @fortawesome/fontawesome-free в node_modules — поставь зависимость');
  process.exit(1);
}
mkdirSync(ICONS_DIR, { recursive: true });

const entries: { id: string; fa: string; d: string; s: number; dx: number; dy: number }[] = [];
for (const [id, fa] of MAPPING) {
  const src = resolve(FA_DIR, `${fa}.svg`);
  if (!existsSync(src)) {
    console.error(`icons: нет иконки ${fa}.svg в наборе Font Awesome`);
    process.exit(1);
  }
  const svg = readFileSync(src, 'utf8');
  const paths = [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1] ?? '');
  // Набор односоставный: у глифа должен быть РОВНО один path. Многослойная
  // иконка (несколько path) молча потеряла бы остальные слои при вставке —
  // значит, в приложении был бы не тот рисунок.
  if (paths.length !== 1) {
    console.error(`icons: у ${fa}.svg ${paths.length} path(ов), а нужен ровно один`);
    process.exit(1);
  }
  const d = paths[0] ?? '';
  if (!d) {
    console.error(`icons: у ${fa}.svg нет path d`);
    process.exit(1);
  }
  const fit = normalizeGlyph(pathBox(d));
  copyFileSync(src, resolve(ICONS_DIR, `${fa}.svg`));
  entries.push({ id, fa, d, ...fit });
  console.log(`  ${id.padEnd(18)} ${fa.padEnd(18)} s=${fit.s.toFixed(4)} dx=${fit.dx.toFixed(1)} dy=${fit.dy.toFixed(1)}`);
}

const block = entries
  .map(
    (e) =>
      `  '${e.id}': { name: '${e.fa}', d: '${e.d}', s: ${e.s.toFixed(5)}, dx: ${e.dx.toFixed(2)}, dy: ${e.dy.toFixed(2)} },`,
  )
  .join('\n');
const src = readFileSync(TARGET, 'utf8');
const FROM = '// >>> icons:fetch';
const TO = '// <<< icons:fetch';
const from = src.indexOf(FROM);
const to = src.indexOf(TO);
if (from < 0 || to < 0 || to <= from) {
  console.error('icons: в CategoryIcon.tsx нет маркеров блока ICONS');
  process.exit(1);
}
const next = `${src.slice(0, from)}${FROM}\nconst ICONS: Record<string, { name: string; d: string; s: number; dx: number; dy: number }> = {\n${block}\n};\n${src.slice(to)}`;
writeFileSync(TARGET, next, 'utf8');
console.log('icons: пересобрано иконок', entries.length, '→', TARGET);

// ── Шапка README ──────────────────────────────────────────────────────────
// Те же иконки в квадрате 24×24, в шапке они 32 px: масштаб 32/24 = 1.3333.
// Позиция — оптический центр строки (baseline − 0.35·fontsize) минус центр
// чернил иконки (12 юнитов).
const SCALE = 1.3333;
const FONT = 20;
const rows: [id: string, baseline: number][] = [
  ['dairy', 184],
  ['bakery', 234],
  ['meat', 284],
  ['vegetables', 334],
];
let hero = readFileSync(HERO, 'utf8');
let replaced = 0;
hero = hero.replace(
  /<g transform="translate\(640,[\d.]+\) scale\([\d.]+\)"[^>]*>[\s\S]*?<\/g>\s*<\/g>/g,
  () => {
    const row = rows[replaced];
    if (!row) return '';
    replaced += 1;
    const icon = entries.find((e) => e.id === row[0]);
    if (!icon) throw new Error(`icons: нет иконки «${row[0]}» для шапки README`);
    const ty = Math.round((row[1] - 0.35 * FONT - 12 * SCALE) * 100) / 100;
    return (
      `<g transform="translate(640,${ty}) scale(${SCALE})">\n` +
      `      <g transform="translate(${icon.dx} ${icon.dy}) scale(${icon.s.toFixed(5)})">` +
      `<path d="${icon.d}" fill="#059669"/></g>\n    </g>`
    );
  },
);
if (replaced !== rows.length) {
  console.error(`icons: в hero.svg заменено ${replaced} иконок, ожидалось ${rows.length}`);
  process.exit(1);
}
writeFileSync(HERO, hero, 'utf8');
console.log('icons: пересобрана шапка README (', replaced, 'иконки) →', HERO);


