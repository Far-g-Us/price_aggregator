// Бэкап локальных знаний проекта.
//
//   npm run backup:notes
//
// Что бэкапится: CHANGELOG.md и доменный скилл `.opencode/skills/` — они
// НАМЕРЕННО лежат в .gitignore (правило проекта: AI-конфиг живёт только
// локально), то есть в репозиторий не попадают и в форке их не будет. При
// пересоздании машины или смене репозитория они пропадают вместе с
// рабочим деревом, а восстановить их неоткуда.
//
// Куда: %APPDATA%\price-aggregator\notes\ (вне репозитория и вне git).
// Копия оттуда восстанавливается в рабочее дерево простым копированием.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TARGET = join(process.env.APPDATA ?? resolve(ROOT, '.appdata'), 'price-aggregator', 'notes');

const ITEMS = [
  { from: 'CHANGELOG.md', to: 'CHANGELOG.md' },
  { from: '.opencode/skills', to: 'opencode-skills' },
  { from: '.claude/skills', to: 'claude-skills' },
];

mkdirSync(TARGET, { recursive: true });
const copied: string[] = [];
const missing: string[] = [];
for (const item of ITEMS) {
  const src = resolve(ROOT, item.from);
  if (!existsSync(src)) {
    missing.push(item.from);
    continue;
  }
  const dst = join(TARGET, item.to);
  // Копируем во временный каталог и переносим на место только после успеха:
  // при сбое копирования (нет места, нет прав) в бэкапе осталась бы прежняя
  // копия, а не пустой каталог. Старое содержимое тоже вычищается — иначе в
  // бэкапе остались бы файлы скиллов, которых в проекте уже нет.
  const tmp = join(TARGET, `.tmp-${item.to}`);
  rmSync(tmp, { recursive: true, force: true });
  cpSync(src, tmp, { recursive: true });
  rmSync(dst, { recursive: true, force: true });
  renameSync(tmp, dst);
  copied.push(item.to);
}
const sizeOf = (path: string): string => {
  const st = statSync(path);
  if (!st.isDirectory()) return `${Math.round(st.size / 1024)} КБ`;
  let total = 0;
  let count = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        total += statSync(p).size;
        count += 1;
      }
    }
  };
  walk(path);
  return `${Math.round(total / 1024)} КБ, файлов ${count}`;
};
const stamp = new Date().toISOString();
writeFileSync(
  join(TARGET, 'README.txt'),
  `Бэкап локальных знаний проекта.\nСделан: ${stamp}\n\nСкопировано:\n${copied.map((c) => `  ${c}`).join('\n')}\n${
    missing.length ? `\nНе найдено (не копировал):\n${missing.map((c) => `  ${c}`).join('\n')}\n` : ''
  }\nВосстановление: скопировать файлы обратно в корень репозитория.\n`,
);
process.stdout.write(`notes: скопировано в ${TARGET}: ${copied.join(', ') || '(ничего)'}\n`);
for (const name of copied) {
  process.stdout.write(`  ${name}: ${sizeOf(join(TARGET, name))}\n`);
}
for (const name of missing) {
  process.stdout.write(`  ВНИМАНИЕ: ${name} не найден(а) — не копировал(а)\n`);
}
