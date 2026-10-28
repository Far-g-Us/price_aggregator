// Диагностика магазина Магнита.
//   npm run magnit:store            -> какие коды точек сеть принимает сегодня
//   npm run magnit:store -- 010033  -> проверяет конкретный shopCode
// Магазин задаётся кодом точки в теле запроса (и кукой shopCode), поэтому
// проверка кода работает из любого города.
//
// Почему API, а не HTML (2026-10-18): сайт перешёл на клиентский рендер,
// `/search?term=` отдаёт ~40 КБ оболочки Nuxt без ссылок на товары. Старый
// зонд печатал «(нет)» и объявлял ЛЮБОЙ, включая живой, код несуществующим.
//
// БЕЗ кода webgate отвечает HTTP 400 (код обязателен), поэтому режим «без
// аргумента» — это перебор кодов из справочника точек: он и отвечает на
// вопрос «какая точка у меня живая».
//
// Пейлоад и сверка берутся ИЗ АДАПТЕРА (`buildSearchBody`, `parseWebgateSearch`,
// `readSearchItems`), а не копируются сюда: своя копия правила уже однажды
// уехала от адаптера и начала давать ложноотрицательные вердикты.
//
// Коды выхода:
//   0 — код принят сетью (выдача пришла и все товары с запрошенным кодом);
//   1 — код отброшен (сеть ответила, но отдала чужую точку);
//   2 — сеть не ответила вовсе (не-2xx, не-JSON, обрыв): ничего не проверено,
//       но и поломки не видно — ночная проверка не должна краснеть из-за мигания;
//   3 — аргумент не похож на код (ожидаются цифры);
//   4 — сеть ответила, а вердикта нет (выдача пуста или форма ответа ушла).
import {
  parseWebgateSearch,
  safeJsonParse,
  NOT_JSON,
  buildSearchBody,
  canonicalShopCode,
} from '../src/core/adapters/magnit-webgate.js';
import { CITY_STORES } from '../src/shared/catalog.js';

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  Accept: 'application/json',
  'Accept-Language': 'ru-RU,ru;q=0.9',
  'Content-Type': 'application/json',
  Referer: 'https://magnit.ru/',
  Origin: 'https://magnit.ru',
};

type Verdict = 'accepted' | 'rejected' | 'empty' | 'offline';

const wanted = process.argv[2]?.replace(/^["']|["']$/g, '').replace(/^%22|%22$/g, '') || null;
if (wanted !== null && !/^\d+$/.test(wanted)) {
  console.error(`Код магазина должен состоять из цифр, получено: ${wanted}`);
  console.error('Пример: npm run magnit:store -- 010033');
  process.exit(3);
}

/** Один запрос к сети: вердикт по коду + что именно ответила сеть. */
async function probe(code: string): Promise<{ verdict: Verdict; note: string }> {
  let res: Response;
  try {
    res = await fetch('https://magnit.ru/webgate/v2/goods/search', {
      method: 'POST',
      headers: { ...HEADERS, Cookie: `shopCode="${code}"` },
      body: buildSearchBody('молоко', code),
      redirect: 'follow',
      // Потолок, как у адаптера: зависший magnit.ru не должен держать зонд вечно.
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { verdict: 'offline', note: `сеть недоступна: ${String(e).slice(0, 80)}` };
  }
  if (!res.ok) {
    return { verdict: 'offline', note: `HTTP ${res.status} — сеть не ответила как надо` };
  }
  const raw = safeJsonParse(await res.text());
  if (raw === NOT_JSON) {
    return { verdict: 'offline', note: 'ответ не JSON (WAF-страница?)' };
  }
  try {
    const products = parseWebgateSearch(raw, code);
    if (products.length === 0) {
      return { verdict: 'empty', note: 'выдача пуста — сверять нечего' };
    }
    return { verdict: 'accepted', note: `товаров ${products.length}` };
  } catch (e) {
    if (/чужого магазина/.test(String(e))) {
      return { verdict: 'rejected', note: String(e).slice(0, 120) };
    }
    return { verdict: 'empty', note: String(e).slice(0, 120) };
  }
}

/** Коды точек Магнита из справочника — что вообще можно проверить. */
function magnitCodes(): { city: string; code: string }[] {
  const out: { city: string; code: string }[] = [];
  for (const [city, stores] of Object.entries(CITY_STORES)) {
    for (const s of stores) {
      if (s.storeId !== 'magnit') continue;
      out.push({ city, code: s.externalStoreId });
    }
  }
  return out;
}

if (wanted !== null) {
  console.log(`Проверяю код ${wanted} (канонический вид ${canonicalShopCode(wanted)}).`);
  const { verdict, note } = await probe(wanted);
  console.log('Ответ сети:', note);
  if (verdict === 'accepted') {
    console.log(`\nКод ${wanted} принят сетью.`);
    process.exit(0);
  }
  if (verdict === 'rejected') {
    console.log(`\nКод ${wanted} отброшен: сеть продолжает показывать чужую точку.`);
    process.exit(1);
  }
  if (verdict === 'offline') {
    // Сеть не ответила — это не «точка уехала», и краснить из-за мигания
    // сети нельзя: у Магнита 503/504 — его собственное зафиксированное
    // состояние. Вердикта нет, но и вывода «сломалось» тоже нет.
    console.warn('\nСеть не ответила как надо — код не проверен, но и поломки не видно.');
    process.exit(2);
  }
  console.error('\nСеть ответила, но вердикта нет (см. «Ответ сети») — это уже поломка формы.');
  process.exit(4);
}

console.log('Кода не указан — webgate его требует (без кода отдаёт HTTP 400),');
console.log('поэтому проверяю точки из справочника:\n');
// Пауза между запросами обязательна: без неё magnit.ru режет уже на третьем
// запросе подряд, и перебор выглядел бы как «сеть не приняла ни одного кода».
const PAUSE_MS = 1800;
let accepted = 0;
let unknownRun = 0;
for (const { city, code } of magnitCodes()) {
  if (unknownRun >= 2) {
    console.log('  … проверка остановлена: две подряд «нет вердикта» — сеть режет.');
    break;
  }
  const { verdict, note } = await probe(code);
  unknownRun = verdict === 'offline' || verdict === 'empty' ? unknownRun + 1 : 0;
  const mark =
    verdict === 'accepted'
      ? 'ПРИНЯТ'
      : verdict === 'rejected'
        ? 'отброшен'
        : verdict === 'offline'
          ? 'сеть не ответила'
          : 'нет вердикта';
  if (verdict === 'accepted') accepted += 1;
  console.log(`  ${code} (${city}) — ${mark}: ${note}`);
  await new Promise((r) => setTimeout(r, PAUSE_MS));
}
console.log(
  accepted > 0
    ? `\nПринято кодов: ${accepted}.`
    : '\nНи один код из справочника не принят — либо сеть отвечает не так, либо IP заблокирован.',
);
process.exit(accepted > 0 ? 0 : 4);
