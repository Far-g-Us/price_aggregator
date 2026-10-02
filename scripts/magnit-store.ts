// Диагностика магазина Магнита.
//   npm run magnit:store            -> какой магазин сайт отдаёт с этой сети
//   npm run magnit:store -- 010033  -> проверяет конкретный shopCode
// Магазин задаётся кукой shopCode, которую шлёт адаптер, поэтому проверка
// кода работает из любого города. Признак валидного кода: сайт принимает его
// и возвращает страницу ЭТОГО магазина; несуществующий код сайт отбрасывает
// и отдаёт магазин по умолчанию.
//
// Правило сверки берётся из адаптера (`shopCodesInProductLinks`), а не
// копируется сюда: своя копия regex уже однажды уехала индексом группы и
// начала объявлять живые коды несуществующими.
import { shopCodesInProductLinks } from '../src/core/adapters/magnit.js';

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  'Accept-Language': 'ru-RU,ru;q=0.9',
  Referer: 'https://magnit.ru/',
};

function pick(html: string, key: string): string {
  const m = html.match(new RegExp(`"?${key}"?\\s*:\\s*"([^"]*)"`));
  if (m?.[1]) return m[1];
  const u = html.match(new RegExp(`"?${key}"?\\s*:\\s*"\\\\u([0-9a-f]{4})`, 'i'));
  return u?.[1] ? String.fromCharCode(parseInt(u[1], 16)) : '';
}

const wanted = process.argv[2]?.replace(/^["']|["']$/g, '').replace(/^%22|%22$/g, '') || null;

const res = await fetch('https://magnit.ru/search?term=' + encodeURIComponent('молоко'), {
  headers: wanted ? { ...HEADERS, Cookie: `shopCode="${wanted}"` } : HEADERS,
  redirect: 'follow',
});
const html = (await res.text()).replace(/\\"/g, '"');
const codes = shopCodesInProductLinks(html);
const shopType = res.headers
  .getSetCookie()
  .map((c) => c.split(';')[0] ?? '')
  .find((c) => c.startsWith('x_shop_type='));

console.log('Статус:', res.status);
console.log('Коды магазинов в ответе:', codes.join(', ') || '(нет)');
if (shopType) console.log('Формат точки (x_shop_type):', shopType.split('=')[1]);
console.log('Адрес по умолчанию для IP:', pick(html, 'address') || '-');

if (!wanted) {
  console.log('\nЭто магазин по умолчанию для твоей сети, не для города.');
  console.log('Код вписывается в src/shared/catalog.ts, если нужен этот город.');
} else if (codes.includes(wanted)) {
  console.log(`\nКод ${wanted} принят сайтом: это существующий магазин.`);
  console.log('Код вписывается в src/shared/catalog.ts для нужного города.');
} else {
  console.log(`\nКод ${wanted} отброшен: такого магазина нет или он не отдаёт витрину.`);
  process.exitCode = 1;
}