export interface CityInfo {
  id: string;
  name: string;
}

export interface CityStoreInfo {
  storeId: 'pyaterochka' | 'magnit' | 'lenta';
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
  ],
  ulyanovsk: [
    { storeId: 'pyaterochka', name: 'Пятёрочка', externalStoreId: '3288', ready: false },
    { storeId: 'magnit', name: 'Магнит', externalStoreId: '730159', ready: true },
    // Лента: 3275 = ТК0036, пр-т Созидателей 112.
    { storeId: 'lenta', name: 'Лента', externalStoreId: '3275', ready: true },
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
];
CITY_STORES.ekaterinburg = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '099255', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3481', ready: true },
];
CITY_STORES.kazan = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '747996', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3181', ready: true },
];
CITY_STORES['nizhny-novgorod'] = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '633408', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3170', ready: true },
];
CITY_STORES.chelyabinsk = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '740682', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3483', ready: true },
];
CITY_STORES.krasnoyarsk = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '432925', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3491', ready: true },
];
CITY_STORES.perm = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '593395', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3567', ready: true },
];
CITY_STORES.barnaul = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '221456', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3563', ready: true },
];
CITY_STORES.omsk = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '558755', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3441', ready: true },
];
CITY_STORES.kemerovo = [
  { storeId: 'magnit', name: 'Магнит', externalStoreId: '427498', ready: true },
  { storeId: 'lenta', name: 'Лента', externalStoreId: '3517', ready: true },
];
