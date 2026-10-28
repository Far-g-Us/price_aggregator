// Сводная живая проверка: всё, что можно узнать о сетях без тестовых
// фикстур, одним прогоном.
//
//   npm run check:live
//
// Зачем: юнит-тесты работают на СНЯТЫХ ответах, и потому молчат, когда сеть
// меняет ответ. Этот прогон бьёт по живым адресам и печатает, что именно
// сейчас отвечает каждая сеть. Перед релизом его стоит прогнать: он ловит
// и «точка перестала работать», и «сеть сменила форму ответа».
//
// Каждая проверка различает «сеть не ответила» (мигание, не поломка —
// жёлтый) и «ответ уехал» (поломка — красный). Код возврата 1 означает
// именно поломку.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** Прогон npm-скрипта: код возврата и вывод. */
function run(script: string, args: string[] = []): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn('npx', ['tsx', script, ...args], {
      cwd: ROOT,
      shell: process.platform === 'win32',
    });
    let out = '';
    child.stdout.on('data', (d: Buffer | string) => {
      out += String(d);
    });
    child.stderr.on('data', (d: Buffer | string) => {
      out += String(d);
    });
    child.on('exit', (code: number | null) => done({ code: code ?? 1, out }));
  });
}

const checks = [
  {
    title: 'Магнит: точка 303857 принимается сетью',
    script: 'scripts/magnit-store.ts',
    args: ['303857'],
  },
  {
    title: 'Магнит: карточка товара несёт JSON-LD с ценой',
    script: 'scripts/capture-magnit-card.ts',
    args: ['--check'],
  },
  {
    title: 'Магнит: форма ответа webgate совпадает с эталоном',
    script: 'scripts/capture-magnit-webgate.ts',
    args: ['--check'],
  },
];

let broken = 0;
let silent = 0;
for (const check of checks) {
  process.stdout.write(`\n=== ${check.title}\n`);
  const { code, out } = await run(check.script, check.args);
  for (const line of out.split(/\r?\n/)) {
    if (line.trim()) process.stdout.write(`    ${line}\n`);
  }
  // Коды зондов: 0 — всё хорошо; 1 — точка уехала (сеть жива, но показывает
  // чужую); 4 — сеть ответила, а ответ не такой, как ждали (форма уехала,
  // JSON-LD нет); 2 — сеть не ответила вовсе (мигание): ничего не проверено,
  // но и поломки не видно — красным это делать нельзя.
  if (code === 0) {
    process.stdout.write('    → зелёный\n');
  } else if (code === 1 || code === 4) {
    process.stdout.write('    → КРАСНЫЙ: сеть ответила, но не так, как ждали\n');
    broken += 1;
  } else if (code === 2) {
    process.stdout.write('    → сеть не ответила (мигание) — проверка неубедительна\n');
    silent += 1;
  } else {
    process.stdout.write(`    → непонятный код возврата ${code}\n`);
    silent += 1;
  }
}

process.stdout.write(
  `\nИтог: поломок ${broken}, неубедительных ${silent}. Проверка формы сравнивает её с эталоном tests/fixtures/magnit-webgate-shape.json и НЕ трогает фикстуры: переснять эталон — npm run magnit:fixture.\n`,
);
// Код 2 на «всё неубедительно»: ни одной сети не проверили — это не успех,
// и вызывающий должен знать, что сигнала нет (ночной прогон при этом не
// падает: поломки не было).
process.exit(broken > 0 ? 1 : silent > 0 ? 2 : 0);
