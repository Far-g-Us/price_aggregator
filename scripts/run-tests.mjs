// Параллельный запуск тестовых скриптов.
//
// Зачем: скрипты независимы (у каждого свой процесс, своя временная база), но
// цепочкой они шли строго последовательно и суммарно занимали ~10 минут, из
// которых 6 минут — три самых медленных (браузерный транспорт и два http-теста
// с повторами). Ничего не меняя в самих тестах, параллельный запуск срезает
// ожидание до времени самого долгого скрипта.
//
// Чего этот скрипт НЕ делает: не меняет состав набора и не ослабляет гейт.
// Порядок вывода — по времени выполнения, чтобы было видно, что дорого.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

/**
 * Цепочка наборов. Источник — скрипт `test:all`: он перечисляет наборы
 * последовательно (так их видно в package.json), а `npm test` запускает их
 * параллельно. Раньше `npm test` был самой цепочкой — и наборы шли строго
 * по одному (10+ минут).
 */
function testList() {
  const chain = pkg.scripts['test:all'] ?? pkg.scripts.test;
  return [...chain.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
}

const skip = new Set([
  'test',
  'test:all',
  'test:seq',
  'test:fast',
  'test:quiet',
  'test:coverage',
  'test:coverage:check',
  'test:coverage:fast',
  'check',
]);
const all = testList();
// Отсутствующий ключ — это не «набор не нужен», а расхождение: именно так молча
// выпали test:http и test:filters, и быстрый гейт считал себя зелёным, не
// покрывая http.ts и фильтры вообще.
const missing = all.filter((name) => !skip.has(name) && !pkg.scripts[name]);
if (missing.length > 0) {
  process.stderr.write(`в цепочке npm test есть наборы без скрипта: ${missing.join(', ')}\n`);
  process.exit(1);
}
const list = all.filter((name) => !skip.has(name));
// Обратная проверка: каждый набор `test:*` должен попасть в цепочку, иначе
// новый набор молча не будет гоняться вовсе (и «зелёный» прогон ничего не
// проверял бы).
const inChain = new Set(all);
const orphans = Object.keys(pkg.scripts).filter(
  (name) => name.startsWith('test:') && !inChain.has(name) && !skip.has(name),
);
if (orphans.length > 0) {
  process.stderr.write(
    `наборы вне цепочки npm test (молча не проверялись бы): ${orphans.join(', ')}\n`,
  );
  process.exit(1);
}
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const queue = only.length > 0 ? list.filter((n) => only.some((o) => n.includes(o))) : list;
const cpu = (await import('node:os')).cpus().length ?? 4;
const limit = Math.max(2, Math.min(8, cpu - 1));
const quiet = process.argv.includes('--quiet');

const results = [];
let failed = 0;
let cursor = 0;

function runOne(name) {
  return new Promise((done) => {
    const started = Date.now();
    // Команду набора выполняем НАПРЯМУЮ (из package.json), а не через
    // `npm run <name>`: обёртка npm стоит почти секунду на набор, а наборов
    // 31 — это полминуты чистого ожидания запуска.
    const command = pkg.scripts[name] ?? `npm run ${name}`;
    const child = spawn(command, {
      stdio: quiet ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'pipe', 'inherit'],
      shell: true,
    });
    let tail = '';
    // При `inherit` поток stderr — null (он уходит в терминал), поэтому
    // подписка только когда он реально труба.
    child.stderr?.on('data', (b) => {
      tail = (tail + b).slice(-4000);
    });
    child.stdout?.on('data', (b) => {
      tail = (tail + b).slice(-4000);
    });
    child.on('close', (code) => {
      results.push({ name, ms: Date.now() - started, code });
      if (code !== 0) {
        failed += 1;
        process.stdout.write(`\n=== ${name} УПАЛ (код ${code}) ===\n${tail.trim()}\n`);
      }
      done();
    });
  });
}

async function worker() {
  while (cursor < queue.length) {
    const name = queue[cursor];
    cursor += 1;
    await runOne(name);
  }
}

process.stdout.write(`прогон ${queue.length} набора(ов), параллельно по ${limit}\n`);
const started = Date.now();
await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, () => worker()));
const wall = Date.now() - started;

results.sort((a, b) => b.ms - a.ms);
process.stdout.write('\nпо времени:\n');
for (const r of results) {
  process.stdout.write(`  ${(r.ms / 1000).toFixed(1).padStart(6)} с  ${r.name}${r.code ? '  ← УПАЛ' : ''}\n`);
}
const sum = results.reduce((a, r) => a + r.ms, 0);
process.stdout.write(
  `\nитого: ${(wall / 1000).toFixed(1)} с вместо ${(sum / 1000).toFixed(1)} с последовательно; ` +
    `упало ${failed}\n`,
);
process.exit(failed > 0 ? 1 : 0);