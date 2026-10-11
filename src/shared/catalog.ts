export interface CityInfo {
  id: string;
  name: string;
}

export interface CityStoreInfo {
  storeId: 'pyaterochka' | 'magnit' | 'lenta' | 'svetofor' | 'chizhik' | 'perekrestok';
  name: string;
  externalStoreId: string;
  ready: boolean;
}

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

export const CITY_STORES: Record<string, CityStoreInfo[]> = {
  moscow: [
    // Пятёрочка: 35XY — магазин, который сайт отдаёт по IP этой сети
    // (Москва, Севастопольский пр. 28к2). Подставить другой код нельзя:
    // и кука `5ka_store_id_store`, и `DeliveryPanelStore` перезаписываются
    // сайтом, а URL-формы и подмена геолокации не помогают (см. SKILL.md).
    // Юзеровские коды из его браузера (Питер 5415, Ульяновск 3288,
    // Москва 30ML) — это коды МАГАЗИНОВ, не общий код города; каждый
    // город требует свой, и взять чужой город невозможно.
    { storeId: 'pyaterochka', name: 'Пятёрочка', externalStoreId: '35XY', ready: true },
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
      { storeId: 'lenta', name: 'Лента', externalStoreId: '4161', ready: true },
    // Светофор: 820 = Жулебино, Рязанский пр-кт 101 стр 5, домен
    // moskva-vostok. У сети прайс магазина — статический JSON на собственном
    // домене точки, метка выгрузки берётся из `var offersupd` страницы
    // домена, поэтому externalStoreId — это shopid (число). Домен приходит из
    // справочника svetofor-regions.ts: у Москвы их несколько, и метки у них
    // разные. Точки 376 и 682 не берём — их прайс протух (d = 2021 и 2022 года).
    { storeId: 'svetofor', name: 'Светофор', externalStoreId: '820', ready: true },
    // Чижик: HD87 = Саянская ул. 11Б (точка, которую сеть отдаёт первой по этому
    // IP). Код буквенный, из /api/v1/shops: числовой id в адрес каталога
    // не подставляется (404). Каталог, цены и полки читаются только из
    // контекста страницы — обычный fetch отдаёт 403 (chizhik-browser.ts).
    { storeId: 'chizhik', name: 'Чижик', externalStoreId: 'HD87', ready: true },
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
    { storeId: 'lenta', name: 'Лента', externalStoreId: '3135', ready: true },
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
    { storeId: 'lenta', name: 'Лента', externalStoreId: '3621', ready: true },
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
  { storeId: 'chizhik', name: 'Чижик', externalStoreId: 'HDJ7', ready: true },
];
CITY_STORES.ekaterinburg = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '099255', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3481', ready: true },
  // Чижик: HD1W — Комсомольская ул. 9, код из справочника chizhik-regions.ts.
  { storeId: 'chizhik', name: 'Чижик', externalStoreId: 'HD1W', ready: true },
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
  { storeId: 'chizhik', name: 'Чижик', externalStoreId: 'HD89', ready: true },
];
CITY_STORES.chelyabinsk = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '740682', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3483', ready: true },
  // Чижик: HD98 — ул. Героев Танкограда 163, код из справочника chizhik-regions.ts.
  { storeId: 'chizhik', name: 'Чижик', externalStoreId: 'HD98', ready: true },
];
CITY_STORES.krasnoyarsk = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '432925', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3491', ready: true },
];
CITY_STORES.perm = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '593395', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3567', ready: true },
  // Чижик: HD0J — ул. Куйбышева 25, код из справочника chizhik-regions.ts.
  { storeId: 'chizhik', name: 'Чижик', externalStoreId: 'HD0J', ready: true },
];
CITY_STORES.barnaul = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '221456', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3563', ready: true },
  // Чижик: HDJT — ул. Маяковского 110, код из справочника chizhik-regions.ts.
  { storeId: 'chizhik', name: 'Чижик', externalStoreId: 'HDJT', ready: true },
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

