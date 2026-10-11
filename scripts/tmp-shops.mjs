import { writeFileSync } from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0' };
const res = await fetch('https://svetoforonline.ru/shops', { headers: UA });
const html = new TextDecoder('windows-1251').decode(new Uint8Array(await res.arrayBuffer()));

const out = [];
out.push(`статус: ${res.status}, длина: ${html.length}`);

// Региональные домены со страницы магазинов
const domains = [...new Set((html.match(/[a-z0-9-]+\.svetoforonline\.ru/gi) ?? []).map((d) => d.toLowerCase()))];
out.push(`доменов на странице: ${domains.length}`);
out.push(domains.join('\n'));

// Названия городов: ищем кириллические заголовки рядом с доменами
const blocks = html.match(/[а-яё][а-яё\-. ]{2,28}/gi) ?? [];
const names = [...new Set(blocks.map((s) => s.trim()).filter((s) => s.length > 3))];
out.push(`\nкириллических фрагментов: ${names.length}`);
out.push(names.slice(0, 120).join(' | '));

// Прямое упоминание городов сети
const probes = ['Ульянов', 'Пермь', 'Казан', 'Новосибир', 'Екатеринбург', 'Барнаул', 'Кемеров', 'Омск', 'Иркутск', 'Краснояр', 'Челябин', 'Нижний', 'Тверь', 'Калуг', 'Тул', 'Рязан', 'Ярослав', 'Владимир', 'Иванов', 'Кострома', 'Смоленск', 'Псков', 'Калининград', 'Мурманск', 'Архангельск'];
out.push('\n--- упоминания городов на /shops ---');
for (const p of probes) out.push(`${p}: ${html.includes(p) ? 'ДА' : 'нет'}`);

writeFileSync('scripts/tmp-shops-report.txt', out.join('\n'), 'utf8');
console.log('отчёт записан');