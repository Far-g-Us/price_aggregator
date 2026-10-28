export interface CityInfo {
  id: string;
  name: string;
}

export interface CityStoreInfo {
  storeId: 'pyaterochka' | 'magnit' | 'lenta' | 'svetofor' | 'chizhik' | 'perekrestok';
  name: string;
  /**
   * Адрес точки — как его отдала СЕТЬ (capture, снимок справочника регионов),
   * БЕЗ города: город и так стоит в шапке приложения, и «Москва, ул. Саянская»
   * рядом с «Москва» в заголовке читается как сбой вёрстки, а не как адрес.
   *
   * Необязателен: не у всех сетей адрес берётся из уже имеющегося ответа, а
   * отдельный запрос «адрес точки» на каждую точку — это лишние обращения к
   * сети ради подписи. Где адреса нет, подписью остаётся `name`, и это честно:
   * выдуманный адрес в UI опаснее отсутствующего.
   *
   * Правило записи: только то, что сеть отдала сама, и без нашего города.
   * Адрес из предположения («Магазин на Пушкинской») сюда попадать не должен.
   */
  address?: string;
  externalStoreId: string;
  ready: boolean;
}

/**
 * Идентификатор сети. Вынесен отдельно, потому что из базы и из IPC сеть
 * приходит строкой, а справочник знает закрытый список: на границе (SQL,
 * renderer) значение сужается этим типом один раз, вместо повторов по коду.
 */
export type StoreId = CityStoreInfo['storeId'];

export const CITIES: CityInfo[] = [
  { id: 'moscow', name: 'Москва' },
  { id: 'saint-petersburg', name: 'Санкт-Петербург' },
  { id: 'novosibirsk', name: 'Новосибирск' },
  { id: 'ekaterinburg', name: 'Екатеринбург' },
  { id: 'kazan', name: 'Казань' },
  { id: 'nizhny-novgorod', name: 'Нижний Новгород' },
  { id: 'chelyabinsk', name: 'Челябинск' },
  { id: 'krasnoyarsk', name: 'Красноярск' },
  { id: 'perm', name: 'Пермь' },
  { id: 'barnaul', name: 'Барнаул' },
  { id: 'omsk', name: 'Омск' },
  { id: 'kemerovo', name: 'Кемерово' },
  { id: 'ulyanovsk', name: 'Ульяновск' },
  { id: 'krasnodar', name: 'Краснодар' },
  { id: 'irkutsk', name: 'Иркутск' },
  // Города, добавленные ради Светофора (2026-10-11): в них у сети есть живая
  // точка с сегодняшним прайсом, а Магнита и Ленты там нет. Показывать город с
  // одной сетью полезнее, чем прятать работающий магазин, но порядок такой же:
  // сначала города с полным покрытием, потом добавленные сетями по отдельности.
  { id: 'ryazan', name: 'Рязань' },
  { id: 'tula', name: 'Тула' },
  { id: 'orel', name: 'Орёл' },
  { id: 'bryansk', name: 'Брянск' },
  { id: 'voronezh', name: 'Воронеж' },
  { id: 'lipetsk', name: 'Липецк' },
  { id: 'tambov', name: 'Тамбов' },
  { id: 'vladimir', name: 'Владимир' },
  { id: 'ivanovo', name: 'Иваново' },
  { id: 'kaluga', name: 'Калуга' },
  { id: 'smolensk', name: 'Смоленск' },
  { id: 'tver', name: 'Тверь' },
  { id: 'yaroslavl', name: 'Ярославль' },
  { id: 'kursk', name: 'Курск' },
  { id: 'belgorod', name: 'Белгород' },
];

/**
 * Точки сетей по городам — единственное место, где они заводятся.
 *
 * Правила записи:
 * - код точки (`externalStoreId`) — это код МАГАЗИНА у сети (Пятёрка
 *   `sapCode`, Магнит `shopCode`, Лента `storeId`, Светофор `shopId`).
 *   Новая точка = новая строка; коды существующих точек не меняются никогда.
 * - `name` у точек одной сети в городе ДОЛЖНЫ различаться, иначе в карточке
 *   сравнения цен две точки подписаны одинаково и отличить их нечем
 *   (см. `pointLabel` в renderer). Подпись берётся через `storeByCode`.
 */
export const CITY_STORES: Record<string, CityStoreInfo[]> = {
  moscow: [
    // Пятёрочка: 35XY — магазин, который сайт отдаёт по IP этой сети
    // (Москва, Севастопольский пр. 28к2). Подставить другой код нельзя:
    // и кука `5ka_store_id_store`, и `DeliveryPanelStore` перезаписываются
    // сайтом, а URL-формы и подмена геолокации не помогают (см. SKILL.md).
    // Юзеровские коды из его браузера (Питер 5415, Ульяновск 3288,
    // Москва 30ML) — это коды МАГАЗИНОВ, не общий код города; каждый
    // город требует свой, и взять чужой город невозможно.
    { storeId: 'pyaterochka', name: 'Пятёрочка', address: 'ул. Севастопольский пр. 28к2', externalStoreId: '35XY', ready: true },
    { storeId: 'magnit', name: 'Магнит', externalStoreId: '303857', ready: true },
    // Лента: 4161 = ТК3090, Москва, Пресненская наб. 10с2 (SM). Это id точки
    // из capture 2026-09-29, а не alias: `delivery/mode/set` принимает id.
    // Alias магазина (3090) лежит в теле карточки и нужен только для сверки.
      // Поиск проверен живым ответом (jrpc/searchItems, 85 товаров на «молоко»).
      // ready:true — карточка по id (GET api-gateway/catalog/items/{id}) с ЦОД
      // режется Qrator (401, 2026-09-30 и 2026-10-01), и это единственное, что
      // раньше держало сеть выключенной. Опрашиваем товар поиском по названию и
      // берём его по id из выдачи (fetchProduct, 2026-10-01). Витрины у Ленты
      // нет by design: catalog/categories тоже на api-gateway, GET режется,
      // POST отдаёт 405, а jrpc-метод требует пользовательский Passport-токен.
      { storeId: 'lenta', name: 'Лента', address: 'ул. Пресненская наб. 10с2 (ТК3090)', externalStoreId: '4161', ready: true },
    // Светофор: 820 = Жулебино, Рязанский пр-кт 101 стр 5, домен
    // moskva-vostok. У сети прайс магазина — статический JSON на собственном
    // домене точки, метка выгрузки берётся из `var offersupd` страницы
    // домена, поэтому externalStoreId — это shopid (число). Домен приходит из
    // справочника svetofor-regions.ts: у Москвы их несколько, и метки у них
    // разные. Точки 376 и 682 не берём — их прайс протух (d = 2021 и 2022 года).
    { storeId: 'svetofor', name: 'Светофор', address: 'Жулебино, Рязанский пр-кт 101 стр 5', externalStoreId: '820', ready: true },
    // Чижик: HD87 = Саянская ул. 11Б (точка, которую сеть отдаёт первой по этому
    // IP). Код буквенный, из /api/v1/shops: числовой id в адрес каталога
    // не подставляется (404). Каталог, цены и полки читаются только из
    // контекста страницы — обычный fetch отдаёт 403 (chizhik-browser.ts).
    { storeId: 'chizhik', name: 'Чижик', address: 'ул. Саянская, 11Б', externalStoreId: 'HD87', ready: true },
    // Перекрёсток: 2053 — код точки, который сеть сама отдаёт в ответе
    // (`content.sapId`) для Москвы по этому IP. Списка магазинов в API нет
    // (проверено 2026-10-10: /shop → 400, /shop/list и прочие → 404), поэтому
    // точка одна на город — как у сетей, у которых цены не различаются между
    // магазинами. Ответ сверяется по sapId: чужой код в ответе означает, что
    // цены пришли из другого магазина, и это наша ошибка настройки, а не отказ
    // сети (StaleStoreError).
    { storeId: 'perekrestok', name: 'Перекрёсток', externalStoreId: '2053', ready: true },
  ],
  'saint-petersburg': [
    { storeId: 'pyaterochka', name: 'Пятёрочка', externalStoreId: '5415', ready: false },
    // Магнит СПб: код 501478 выдачи не отдавал («search-парсер пуст при живом
    // shopCode», 2026-10-03), поэтому 2026-10-03 заменён на код 277027 от
    // пользователя — он отдал 30 товаров с ценами. В тот же день живым поиском
    // прошёлся весь список городов: 24–32 товара в каждом, СПб не исключение.
    { storeId: 'magnit', name: 'Магнит', externalStoreId: '277027', ready: true },
    // Лента: 3135 = ТК0010, наб. Обводного канала 118к7. Код точки взят из
    // `npm run lenta:store saint-petersburg` и проверен живым поиском 2026-10-01:
    // 12 товаров с ценой, 11 в наличии (наличие у Ленты per-store, и оно уже
    // отличается от московской точки — сверять надо именно его).
    { storeId: 'lenta', name: 'Лента', address: 'наб. Обводного канала 118к7 (ТК0010)', externalStoreId: '3135', ready: true },
    // Светофор: 206 = Санкт-Петербург, пр. Александровской Фермы 17 к 3. Из
    // пятнадцати городов каталога сеть покрывает только Москву и Питер (40
    // регионов, практически всё — центральная часть и Поволжье). В Калуге
    // точка есть (shopid 237), но города Калуга в каталоге нет, и пустой город
    // сломал бы инвариант Ленты: добавлять его нужно вместе с покрытием Ленты.
    { storeId: 'svetofor', name: 'Светофор', externalStoreId: '206', ready: true },
    // Чижика в Санкт-Петербурге нет: в localities сети для города нет ни одной
    // точки (живой /api/v1/shops 2026-10-08, 3799 магазинов). Похожая запись —
    // «Ленинградская ст-ца», станица в Краснодарском крае, то есть другой город.
  ],
  ulyanovsk: [
    { storeId: 'pyaterochka', name: 'Пятёрочка', externalStoreId: '3288', ready: false },
    { storeId: 'magnit', name: 'Магнит', externalStoreId: '730159', ready: true },
    // Лента: 3275 = ТК0036, пр-т Созидателей 112.
    { storeId: 'lenta', name: 'Лента', externalStoreId: '3275', ready: true },
    // Чижик: HDOW — код точки Ульяновска из справочника chizhik-regions.ts.
    { storeId: 'chizhik', name: 'Чижик', externalStoreId: 'HDOW', ready: true },
  ],
  // Магнит: магазин задаётся кукой shopCode, которую шлёт адаптер, поэтому
  // любой магазин читается с любого IP — проверено, в том числе с чужого
  // города. Формат точки (Семейный/Экстра/у дома) — её свойство в куке
  // x_shop_type, а не отдельный магазин. М.Косметика — отдельный поддомен
  // cosmetic.magnit.ru с тем же кодом точки, Аптека — apteka.magnit.ru, там
  // магазин выбирается по адресу, а не по shopCode.
  krasnodar: [
    { storeId: 'magnit', name: 'Магнит', externalStoreId: '010033', ready: true },
    // Лента: 3208 = ТК0333, мкр. Любимово 22с1.
    { storeId: 'lenta', name: 'Лента', externalStoreId: '3208', ready: true },
    // Чижик: HDRA.
    { storeId: 'chizhik', name: 'Чижик', externalStoreId: 'HDRA', ready: true },
  ],
  irkutsk: [
    { storeId: 'magnit', name: 'Магнит', externalStoreId: '540675', ready: true },
    // Лента: 3621 = ТК0236, ул. Франк-Каменецкого 13/1.
    { storeId: 'lenta', name: 'Лента', address: 'ул. Франк-Каменецкого 13/1 (ТК0236)', externalStoreId: '3621', ready: true },
  ],
};

// Десять городов, добавленных 2026-10-01.
//
// Лента: коды из справочника регионов, работают.
// Магнит: коды от юзера, подтверждены живым поиском 2026-10-01. Сверка идёт
// по ссылкам на товары: они ведут в тот магазин, чьи цены показаны. Раньше
// проверка шла по строке `shopCode=<код>` в HTML, а пейлоад повторяет там
// куку — то есть принимала ЛЮБОЙ код (контрольный 111111 проходил). Код
// Екатеринбурга пишется с ведущим нулём: без него сайт подставляет свой.
// СПб по коду 501478 выдачи не отдаёт — см. комментарий у 'saint-petersburg'.
//
// shopCode в конфиг кладём ГОЛЫМИ цифрами: в куке он URL-кодирован вместе с
// кавычками (`%22543579%22`), а адаптер Магнита сам оборачивает код в
// кавычки и кодирует (`shopCode=${encodeURIComponent('"' + code + '"')}`).
CITY_STORES.novosibirsk = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '543579', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3311', ready: true },
  // Чижик: HDJ7 — ул. Гоголя 21, код из справочника chizhik-regions.ts.
  { storeId: 'chizhik', name: 'Чижик', address: 'ул. Петухова, 12/1', externalStoreId: 'HDJ7', ready: true },
];
CITY_STORES.ekaterinburg = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '099255', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3481', ready: true },
  // Чижик: HD1W — Комсомольская ул. 9, код из справочника chizhik-regions.ts.
  { storeId: 'chizhik', name: 'Чижик', address: 'ул. Крестинского, 2', externalStoreId: 'HD1W', ready: true },
];
CITY_STORES.kazan = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '747996', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3181', ready: true },
  // Чижик: HDFD — пр-т Победы 141, код из справочника chizhik-regions.ts.
  { storeId: 'chizhik', name: 'Чижик', externalStoreId: 'HDFD', ready: true },
];
CITY_STORES['nizhny-novgorod'] = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '633408', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3170', ready: true },
  // Чижик: HD89 — ул. Доватора 11, код из справочника chizhik-regions.ts.
  { storeId: 'chizhik', name: 'Чижик', address: 'ул. Доватора, 11', externalStoreId: 'HD89', ready: true },
];
CITY_STORES.chelyabinsk = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '740682', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3483', ready: true },
  // Чижик: HD98 — ул. Героев Танкограда 163, код из справочника chizhik-regions.ts.
  { storeId: 'chizhik', name: 'Чижик', address: 'ул. Героев Танкограда, 163', externalStoreId: 'HD98', ready: true },
];
CITY_STORES.krasnoyarsk = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '432925', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3491', ready: true },
];
CITY_STORES.perm = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '593395', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3567', ready: true },
  // Чижик: HD0J — ул. Куйбышева 25, код из справочника chizhik-regions.ts.
  { storeId: 'chizhik', name: 'Чижик', address: 'ул. Куйбышева, 25', externalStoreId: 'HD0J', ready: true },
];
CITY_STORES.barnaul = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '221456', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3563', ready: true },
  // Чижик: HDJT — ул. Маяковского 110, код из справочника chizhik-regions.ts.
  { storeId: 'chizhik', name: 'Чижик', address: 'ул. Маяковского, 110', externalStoreId: 'HDJT', ready: true },
];
CITY_STORES.omsk = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '558755', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3441', ready: true },
];
CITY_STORES.kemerovo = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '427498', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3517', ready: true },
  // Чижик: HDIG — пр-т Ленина 33, код из справочника chizhik-regions.ts.
  { storeId: 'chizhik', name: 'Чижик', externalStoreId: 'HDIG', ready: true },
];

// Пятнадцать городов, добавленных 2026-11 ради Светофора.
//
// У каждого магазина Светофора прайс живой: самый свежий товар датирован
// сегодняшним днём (проверено `npm run svetofor:cities` по официальной выгрузке
// `svetoforonline.ru/api.php?mode=getShops`, где у каждого магазина в адресе
// указан город). Протухшие точки в список не берут: цены в них стоят годами,
// и витрина врала бы молча.
//
// Лента в тринадцати городах из пятнадцати тоже есть (коды — из живого
// справочника регионов, покрытие подтверждено живым поиском). Воронежа и
// Ярославля в справочнике Ленты нет, поэтому там только Светофор.
//
// Магнита в этих городах нет — проверено по его справочнику.
CITY_STORES.ryazan = [
  { storeId: 'svetofor', name: 'Светофор', externalStoreId: '630', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3237', ready: true },
];
CITY_STORES.tula = [
  { storeId: 'svetofor', name: 'Светофор', externalStoreId: '365', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3845', ready: true },
];
CITY_STORES.orel = [
  { storeId: 'svetofor', name: 'Светофор', externalStoreId: '75', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3271', ready: true },
];
CITY_STORES.bryansk = [
  { storeId: 'svetofor', name: 'Светофор', externalStoreId: '109', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3313', ready: true },
];
CITY_STORES.voronezh = [{ storeId: 'svetofor', name: 'Светофор', externalStoreId: '703', ready: true }];
CITY_STORES.lipetsk = [
  { storeId: 'svetofor', name: 'Светофор', externalStoreId: '120', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3279', ready: true },
];
CITY_STORES.tambov = [
  { storeId: 'svetofor', name: 'Светофор', externalStoreId: '640', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '5313', ready: true },
];
CITY_STORES.vladimir = [
  { storeId: 'svetofor', name: 'Светофор', externalStoreId: '142', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3216', ready: true },
];
CITY_STORES.ivanovo = [
  { storeId: 'svetofor', name: 'Светофор', externalStoreId: '757', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3269', ready: true },
];
CITY_STORES.kaluga = [
  { storeId: 'svetofor', name: 'Светофор', externalStoreId: '713', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3415', ready: true },
];
CITY_STORES.smolensk = [
  { storeId: 'svetofor', name: 'Светофор', externalStoreId: '255', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3315', ready: true },
];
CITY_STORES.tver = [
  { storeId: 'svetofor', name: 'Светофор', externalStoreId: '274', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3285', ready: true },
];
CITY_STORES.yaroslavl = [{ storeId: 'svetofor', name: 'Светофор', externalStoreId: '9', ready: true }];
CITY_STORES.kursk = [
  { storeId: 'svetofor', name: 'Светофор', externalStoreId: '175', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3375', ready: true },
];
CITY_STORES.belgorod = [
  { storeId: 'svetofor', name: 'Светофор', externalStoreId: '193', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3253', ready: true },
];

// --- Обращение к точкам ----------------------------------------------------
//
// Одна сеть может иметь в городе НЕСКОЛЬКО точек: `CITY_STORES[city]` — это
// список записей, а не словарь по сети, и записи одной сети отличаются
// externalStoreId (кодом точки). Поэтому искать точку через
// `find(s => s.storeId === …)` больше нельзя: это молча взяло бы ПЕРВУЮ точку
// сети, и товар, отслеживаемый по точке Б, уехал бы в цену точки А.
//
// КАК ДОБАВИТЬ ТОЧКУ. В коде правится только здесь:
//   1. новая запись `{ storeId, name, externalStoreId, ready: true }` в
//      `CITY_STORES[city]`. Код точки берётся из зонда сети (`npm run
//      magnit:store`, `lenta:store`, `5ka:store`), а не выдумывается;
//   2. `npm run gen:schema` — сид БД берётся из этого же справочника
//      (`stores`, PK `(id, city, external_store_id)`). Про забытый шаг
//      напомнит `npm run test:db`: он роняется на расхождении схемы.
//      Выбор магазинов, опрос и цены подхватываются сами.
// Требования к записи: код уникален внутри (сеть, город) — это проверяет
// `npm run test:db`, — и у двух точек одной сети разные `name`, иначе в UI
// они неразличимы.
//
// Ниже четыре функции вместо самописного поиска. Пока точек на город одна,
// `storesForCity(...)[0]` ведёт себя как прежний `find` — то есть перевод на
// них безопасен по месту.

/** Все точки города; с storeId — только точки этой сети. */
export function storesForCity(city: string, storeId?: StoreId): CityStoreInfo[] {
  const all = CITY_STORES[city] ?? [];
  return storeId ? all.filter((s) => s.storeId === storeId) : all;
}

/** То же, но только рабочие точки:
 * ready: false — точка, до которой сеть ещё не доехала. */
export function readyStoresForCity(city: string, storeId?: StoreId): CityStoreInfo[] {
  return storesForCity(city, storeId).filter((s) => s.ready);
}

/**
 * Точка по коду. Это единственный способ обратиться к конкретной точке: код
 * точки — часть идентичности цены, значит искать точку по коду, а не по
 * позиции в списке.
 */
export function storeByCode(
  storeId: StoreId,
  city: string,
  code: string,
): CityStoreInfo | undefined {
  return storesForCity(city, storeId).find((s) => s.externalStoreId === code);
}

/**
 * Ключи всех ТОЧЕК города (storeId:storeCode) — то, чем помечаются галочки в
 * шапке и что приходит в ядро как «выбранные магазины».
 *
 * Отдельная функция, а не storeIdsForCity: выбор по сети у двух точек одной
 * сети дал бы одну галочку на два разных магазина, то есть снятие второй точки
 * было бы невозможно.
 */
export function pointKeysForCity(city: string, readyOnly = false): PointKey[] {
  const list = readyOnly ? readyStoresForCity(city) : storesForCity(city);
  return list.map((s) => pointKey(s.storeId, s.externalStoreId));
}

/** Уникальные сети города — для выбора сетей и подписей, где точки не нужны. */
export function storeIdsForCity(city: string): StoreId[] {
  return [...new Set(storesForCity(city).map((s) => s.storeId))];
}

/**
 * По одной записи на сеть: первая точка каждой сети города.
 *
 * Нужна местам, которые оперируют СЕТЯМИ, а не точками: галочки в меню
 * магазинов, счётчик «3/7», подпись сети в уведомлении. Перебирать там
 * `storesForCity` нельзя: с двумя точками одной сети получились бы две
 * одинаковые строки с одинаковым ключом React и одна галочка на два раза.
 * Выбор по точкам (шаг 8) сделан, но ЭТА функция осталась: по сети считаются
 * меню города и имя сети в подписи. Список точек — storesForCity.
 */
export function networksForCity(city: string): CityStoreInfo[] {
  return uniqueByNetwork(storesForCity(city));
}

/**
 * Подписи для интерфейса: сети — по одной записи на сеть, точки — по всем.
 *
 * Живут здесь, а не в компоненте, по двум причинам. Первая: renderer не покрыт
 * тестами вообще, а ошибка «подписываю по networksForCity вместо точек»
 * невидима — вторая точка сети просто молча не попадает в словарь. Вторая:
 * словари строятся один раз при загрузке листа, и правило «одна запись на
 * сеть» тут обязано быть проверяемым тестом, а не глазками.
 */
export interface StoreLabels {
  /** Ключ `storeId` → имя сети. */
  byStore: Record<string, string>;
  /** Ключ `storeId:storeCode` → имя ТОЧКИ (у второй точки сети оно своё). */
  byPoint: Record<string, string>;
}

/**
 * Подпись точки для интерфейса: имя точки, а к нему адрес, если сеть его дала.
 *
 * Форма одна на все места (шапка, строка цены, плашка прогресса): «Чижик — ул.
 * Саянская, 11Б». Точка без адреса остаётся просто именем — у Магнита, например,
 * адрес сеть отдаёт отдельным запросом, которого пока нет, и молча выдумывать
 * его нельзя.
 */
export function pointLabel(point: CityStoreInfo): string {
  return point.address === undefined ? point.name : `${point.name} — ${point.address}`;
}

/**
 * Подпись блока выдачи, у которого точки нет: перенесённые цены из старой базы
 * помечены sentinel '?' и принадлежат сети, но не магазину.
 *
 * Называть их просто именем сети нельзя: у всех точек Магнита имя «Магнит», и
 * строка перенесённых цен выглядела бы как цена ВЫБРАННОГО магазина — ровно то
 * враньё, ради которого sentinel и выделен отдельным блоком.
 */
export const UNKNOWN_POINT_LABEL = 'точка не указана';

export function unknownPointLabel(networkName: string): string {
  return `${networkName} — ${UNKNOWN_POINT_LABEL}`;
}

/**
 * Ключ точки: `storeId:storeCode`.
 *
 * Шаблонный литерал, а не `string`, — и это защита, а не украшение. Выбор
 * магазинов и словари держится в `Record<PointKey, boolean>`, и чтение вида
 * `storeOn['magnit']` (ключ СЕТИ вместо точки) перестаёт компилироваться. Без
 * типа такие чтения молча давали `undefined`, то есть «выключено», и выбор
 * магазинов выглядел бы сломанным без единой ошибки компилятора.
 *
 * Собирается одной функцией: renderer тестами не покрыт, и если бы каждая
 * сторона писала ключ сама, расхождение формата было бы невидимо — словарь
 * просто тихо перестал бы находить подпись.
 */
export type PointKey = `${string}:${string}`;

export function pointKey(storeId: string, code: string): PointKey {
  return `${storeId}:${code}` as PointKey;
}

/**
 * Виден ли блок выдачи при текущем выборе магазинов.
 *
 * Правило одно и обязано быть единственным: блок своей точки виден, если эта
 * точка выбрана, а блок перенесённых цен ('?' — «точка неизвестна») виден, если
 * выбрана ХОТЯ БЫ ОДНА точка той же сети: такие цены не привязаны к точке, и
 * спрятать их от выбранного магазина значило бы потерять товары из выдачи
 * (привет «выбранные магазины не вернули товаров» при полной полке в базе).
 *
 * Дублировать это правило в рендерере нельзя: именно точное сравнение ключа
 * один раз уже съело перенесённые цены (см. storeCodeMatches в types.ts).
 */
export function resultBlockVisible(
  storeOn: Record<PointKey, boolean>,
  points: readonly CityStoreInfo[],
  storeId: string,
  storeCode: string,
): boolean {
  if (storeOn[pointKey(storeId, storeCode)] === true) return true;
  if (storeCode !== '?') return false;
  return points.some(
    (s) => s.storeId === storeId && s.ready && storeOn[pointKey(s.storeId, s.externalStoreId)] === true,
  );
}

export function buildStoreLabels(): StoreLabels {
  const byStore: Record<string, string> = {};
  const byPoint: Record<string, string> = {};
  for (const c of CITIES) {
    for (const s of networksForCity(c.id)) {
      if (byStore[s.storeId] === undefined) byStore[s.storeId] = s.name;
    }
    // Именно storesForCity, а не networksForCity: тот отдаёт по одной записи на
    // СЕТЬ, то есть вторую точку той же сети он не найдёт никогда.
    for (const s of storesForCity(c.id)) {
      byPoint[pointKey(s.storeId, s.externalStoreId)] = pointLabel(s);
    }
  }
  return { byStore, byPoint };
}

/**
 * Первая точка каждой сети из произвольного списка.
 *
 * Вынесено отдельно от networksForCity, чтобы правило «по одной записи на
 * сеть» можно было проверить на списке с ДВУМЯ точками одной сети: в самом
 * справочнике такой пары пока нет (второй точки СПб у нас нет), а сломаться
 * она должна именно на нём.
 *
 * Готовая точка приоритетнее неготовой: `ready` хранится на точке, и если
 * первая точка сети не готова, а вторая готова, сетевой список обязан показать
 * готовую — иначе UI показал бы «(скоро)» и задизейбленную галочку сети, которую
 * опрос при этом ходит (`pollOnce` и выбор точки для скоупов берут готовую).
 */
export function uniqueByNetwork(stores: readonly CityStoreInfo[]): CityStoreInfo[] {
  const byNetwork = new Map<StoreId, CityStoreInfo>();
  for (const s of stores) {
    const seen = byNetwork.get(s.storeId);
    if (seen === undefined) byNetwork.set(s.storeId, s);
    else if (!seen.ready && s.ready) byNetwork.set(s.storeId, s);
  }
  return [...byNetwork.values()];
}

