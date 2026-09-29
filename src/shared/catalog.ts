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
    { storeId: 'lenta', name: 'Лента', externalStoreId: 'TBD_STOREID', ready: false },
  ],
  'saint-petersburg': [
    { storeId: 'pyaterochka', name: 'Пятёрочка', externalStoreId: '5415', ready: false },
    { storeId: 'magnit', name: 'Магнит', externalStoreId: '501478', ready: true },
  ],
  ulyanovsk: [
    { storeId: 'pyaterochka', name: 'Пятёрочка', externalStoreId: '3288', ready: false },
    { storeId: 'magnit', name: 'Магнит', externalStoreId: '730159', ready: true },
  ],
  // Магнит: магазин задаётся кукой shopCode, которую шлёт адаптер, поэтому
  // любой магазин читается с любого IP — проверено, в том числе с чужого
  // города. Формат точки (Семейный/Экстра/у дома) — её свойство в куке
  // x_shop_type, а не отдельный магазин. М.Косметика — отдельный поддомен
  // cosmetic.magnit.ru с тем же кодом точки, Аптека — apteka.magnit.ru, там
  // магазин выбирается по адресу, а не по shopCode.
  krasnodar: [{ storeId: 'magnit', name: 'Магнит', externalStoreId: '010033', ready: true }],
  irkutsk: [{ storeId: 'magnit', name: 'Магнит', externalStoreId: '540675', ready: true }],
};
