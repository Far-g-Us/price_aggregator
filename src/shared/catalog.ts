export interface CityInfo {
  id: string;
  name: string;
  ready: boolean;
}

export interface CityStoreInfo {
  storeId: 'pyaterochka' | 'magnit' | 'lenta';
  name: string;
  externalStoreId: string;
  ready: boolean;
}

export const CITIES: CityInfo[] = [
  { id: 'moscow', name: 'Москва', ready: true },
  { id: 'ulyanovsk', name: 'Ульяновск', ready: false },
];

export const CITY_STORES: Record<string, CityStoreInfo[]> = {
  moscow: [
    { storeId: 'pyaterochka', name: 'Пятёрочка', externalStoreId: 'TBD_SAP', ready: false },
    { storeId: 'magnit', name: 'Магнит', externalStoreId: '473996', ready: true },
    { storeId: 'lenta', name: 'Лента', externalStoreId: 'TBD_STOREID', ready: false },
  ],
  ulyanovsk: [
    { storeId: 'pyaterochka', name: 'Пятёрочка', externalStoreId: '3CX1', ready: false },
  ],
};
