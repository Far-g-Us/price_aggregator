// СГЕНЕРИРОВАНО scripts/gen-lenta-regions.mjs из живых ответов lenta.com, 2026-09-29. Не править руками.
//
// Что это: справочник регионов Ленты. У Ленты нет «кода города» — цена
// всегда за конкретную точку, а регион определяет, к какому городу точка
// относится (это slug, а не наш id города: СПб — `spb`, Краснодар — `ksdr`).
// Это НЕ id из CITY_STORES: там id точки (напр. 4161 = ТК3090, Москва).
//
// `stores` — сколько точек в регионе, `pickup` — сколько с самовывозом
// (только такие годится: цены берутся по mode:pickup), `sampleStoreId` —
// первая точка с самовывозом, её можно сразу вписать в src/shared/catalog.ts.

export interface LentaRegion {
  /** regionId из pickup/search и region/list. */
  id: number;
  /** slug региона: он уходит в заголовок X-Domain. */
  slug: string | null;
  /** Название региона как в магазине, null если region/list был недоступен. */
  name: string | null;
  /** Всего точек в регионе. */
  stores: number;
  /** Из них с самовывозом. */
  pickup: number;
  /** Первая точка с самовывозом — кандидат на externalStoreId. */
  sampleStoreId: number | null;
  /** Типы точек: SM супермаркет, HM гипермаркет, ZO зоомагазин. */
  marketTypes: string;
}

export const LENTA_REGIONS: LentaRegion[] = [
  {
    "id": 3,
    "slug": "spb",
    "name": "Санкт-Петербург и область",
    "stores": 339,
    "pickup": 305,
    "sampleStoreId": 3135,
    "marketTypes": "AL,EC,HM,SM,ZO"
  },
  {
    "id": 1,
    "slug": "moscow",
    "name": "Москва и МО",
    "stores": 226,
    "pickup": 192,
    "sampleStoreId": 103,
    "marketTypes": "AL,HM,SM,ZO"
  },
  {
    "id": 19,
    "slug": "nsk",
    "name": "Новосибирск",
    "stores": 46,
    "pickup": 44,
    "sampleStoreId": 3311,
    "marketTypes": "HM,SM,ZO"
  },
  {
    "id": 25,
    "slug": "chel",
    "name": "Челябинск",
    "stores": 41,
    "pickup": 35,
    "sampleStoreId": 3483,
    "marketTypes": "EC,HM,SM,ZO"
  },
  {
    "id": 29,
    "slug": "perm",
    "name": "Пермь",
    "stores": 26,
    "pickup": 24,
    "sampleStoreId": 3567,
    "marketTypes": "HM,SM,ZO"
  },
  {
    "id": 9,
    "slug": "ekb",
    "name": "Екатеринбург",
    "stores": 18,
    "pickup": 18,
    "sampleStoreId": 3481,
    "marketTypes": "HM,SM,ZO"
  },
  {
    "id": 83,
    "slug": "petrozavodsk",
    "name": "Петрозаводск",
    "stores": 13,
    "pickup": 9,
    "sampleStoreId": 3539,
    "marketTypes": "HM,SM,ZO"
  },
  {
    "id": 61,
    "slug": "kemerovo",
    "name": "Кемерово",
    "stores": 12,
    "pickup": 12,
    "sampleStoreId": 3517,
    "marketTypes": "HM,SM,ZO"
  },
  {
    "id": 21,
    "slug": "omsk",
    "name": "Омск",
    "stores": 11,
    "pickup": 11,
    "sampleStoreId": 3441,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 27,
    "slug": "vrn",
    "name": "Воронеж",
    "stores": 11,
    "pickup": 9,
    "sampleStoreId": 3203,
    "marketTypes": "HM,SM,ZO"
  },
  {
    "id": 37,
    "slug": "barnaul",
    "name": "Барнаул",
    "stores": 11,
    "pickup": 11,
    "sampleStoreId": 3563,
    "marketTypes": "HM,SM,ZO"
  },
  {
    "id": 7,
    "slug": "nnov",
    "name": "Нижний Новгород",
    "stores": 10,
    "pickup": 10,
    "sampleStoreId": 3170,
    "marketTypes": "HM,SM,ZO"
  },
  {
    "id": 13,
    "slug": "krsk",
    "name": "Красноярск",
    "stores": 10,
    "pickup": 10,
    "sampleStoreId": 3491,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 101,
    "slug": "tomsk",
    "name": "Томск",
    "stores": 10,
    "pickup": 10,
    "sampleStoreId": 3561,
    "marketTypes": "HM,SM,ZO"
  },
  {
    "id": 105,
    "slug": "tyumen",
    "name": "Тюмень",
    "stores": 10,
    "pickup": 10,
    "sampleStoreId": 3485,
    "marketTypes": "HM,SM,ZO"
  },
  {
    "id": 23,
    "slug": "rnd",
    "name": "Ростов-на-Дону",
    "stores": 9,
    "pickup": 9,
    "sampleStoreId": 3191,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 117,
    "slug": "yar",
    "name": "Ярославль",
    "stores": 9,
    "pickup": 9,
    "sampleStoreId": 3229,
    "marketTypes": "HM,SM,ZO"
  },
  {
    "id": 11,
    "slug": "kzn",
    "name": "Казань",
    "stores": 8,
    "pickup": 8,
    "sampleStoreId": 3181,
    "marketTypes": "HM,SM"
  },
  {
    "id": 15,
    "slug": "ksdr",
    "name": "Краснодар",
    "stores": 8,
    "pickup": 8,
    "sampleStoreId": 3208,
    "marketTypes": "HM,SM,ZO"
  },
  {
    "id": 59,
    "slug": "kaluga",
    "name": "Калуга",
    "stores": 8,
    "pickup": 7,
    "sampleStoreId": 3415,
    "marketTypes": "HM,SM,ZO"
  },
  {
    "id": 5,
    "slug": "ufa",
    "name": "Уфа",
    "stores": 7,
    "pickup": 7,
    "sampleStoreId": 3224,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 17,
    "slug": "volgograd",
    "name": "Волгоград",
    "stores": 7,
    "pickup": 5,
    "sampleStoreId": 3193,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 31,
    "slug": "smr",
    "name": "Самара",
    "stores": 6,
    "pickup": 6,
    "sampleStoreId": 3204,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 51,
    "slug": "ivanovo",
    "name": "Иваново",
    "stores": 6,
    "pickup": 6,
    "sampleStoreId": 3269,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 85,
    "slug": "pskov",
    "name": "Псков",
    "stores": 6,
    "pickup": 6,
    "sampleStoreId": 3218,
    "marketTypes": "HM,SM,ZO"
  },
  {
    "id": 91,
    "slug": "saratov",
    "name": "Саратов",
    "stores": 6,
    "pickup": 6,
    "sampleStoreId": 3190,
    "marketTypes": "EC,HM,ZO"
  },
  {
    "id": 137,
    "slug": "magnitogorsk",
    "name": "Магнитогорск",
    "stores": 6,
    "pickup": 6,
    "sampleStoreId": 3607,
    "marketTypes": "HM,SM"
  },
  {
    "id": 147,
    "slug": "nkz",
    "name": "Новокузнецк",
    "stores": 6,
    "pickup": 6,
    "sampleStoreId": 3543,
    "marketTypes": "HM,SM"
  },
  {
    "id": 161,
    "slug": "surgut",
    "name": "Сургут",
    "stores": 6,
    "pickup": 6,
    "sampleStoreId": 3479,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 43,
    "slug": "vnovgorod",
    "name": "Великий Новгород",
    "stores": 5,
    "pickup": 5,
    "sampleStoreId": 3221,
    "marketTypes": "HM,SM,ZO"
  },
  {
    "id": 77,
    "slug": "orenburg",
    "name": "Оренбург",
    "stores": 5,
    "pickup": 5,
    "sampleStoreId": 3277,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 53,
    "slug": "izhevsk",
    "name": "Ижевск",
    "stores": 4,
    "pickup": 4,
    "sampleStoreId": 3243,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 139,
    "slug": "nchelny",
    "name": "Набережные Челны",
    "stores": 4,
    "pickup": 4,
    "sampleStoreId": 3194,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 163,
    "slug": "tgr",
    "name": "Таганрог",
    "stores": 4,
    "pickup": 4,
    "sampleStoreId": 3230,
    "marketTypes": "EC,HM,ZO"
  },
  {
    "id": 33,
    "slug": "arhangelsk",
    "name": "Архангельск",
    "stores": 3,
    "pickup": 3,
    "sampleStoreId": 3521,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 35,
    "slug": "astrakhan",
    "name": "Астрахань",
    "stores": 3,
    "pickup": 3,
    "sampleStoreId": 3259,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 55,
    "slug": "irkutsk",
    "name": "Иркутск",
    "stores": 3,
    "pickup": 3,
    "sampleStoreId": 3621,
    "marketTypes": "HM"
  },
  {
    "id": 69,
    "slug": "lipetsk",
    "name": "Липецк",
    "stores": 3,
    "pickup": 3,
    "sampleStoreId": 3279,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 73,
    "slug": "murmansk",
    "name": "Мурманск",
    "stores": 3,
    "pickup": 3,
    "sampleStoreId": 3291,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 87,
    "slug": "ryazan",
    "name": "Рязань",
    "stores": 3,
    "pickup": 3,
    "sampleStoreId": 3237,
    "marketTypes": "EC,HM"
  },
  {
    "id": 97,
    "slug": "stk",
    "name": "Сыктывкар",
    "stores": 3,
    "pickup": 3,
    "sampleStoreId": 3587,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 99,
    "slug": "tver",
    "name": "Тверь",
    "stores": 3,
    "pickup": 3,
    "sampleStoreId": 3285,
    "marketTypes": "HM,SM,ZO"
  },
  {
    "id": 107,
    "slug": "ulyanovsk",
    "name": "Ульяновск",
    "stores": 3,
    "pickup": 3,
    "sampleStoreId": 3275,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 149,
    "slug": "novorossiysk",
    "name": "Новороссийск",
    "stores": 3,
    "pickup": 3,
    "sampleStoreId": 3281,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 171,
    "slug": "engels",
    "name": "Энгельс",
    "stores": 3,
    "pickup": 3,
    "sampleStoreId": 3238,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 179,
    "slug": "cher",
    "name": "Череповец",
    "stores": 3,
    "pickup": 3,
    "sampleStoreId": 3244,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 39,
    "slug": "belgorod",
    "name": "Белгород",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3253,
    "marketTypes": "HM"
  },
  {
    "id": 47,
    "slug": "vologda",
    "name": "Вологда",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3365,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 57,
    "slug": "yo",
    "name": "Йошкар-Ола",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3236,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 67,
    "slug": "kursk",
    "name": "Курск",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3375,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 75,
    "slug": "orel",
    "name": "Орёл",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3271,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 79,
    "slug": "penza",
    "name": "Пенза",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3245,
    "marketTypes": "EC,HM"
  },
  {
    "id": 81,
    "slug": "noyabrsk",
    "name": "Ноябрьск",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3597,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 95,
    "slug": "stavropol",
    "name": "Ставрополь",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3252,
    "marketTypes": "HM"
  },
  {
    "id": 103,
    "slug": "tula",
    "name": "Тула",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3845,
    "marketTypes": "SM"
  },
  {
    "id": 109,
    "slug": "hm",
    "name": "Ханты-Мансийск",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3509,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 119,
    "slug": "almetevsk",
    "name": "Альметьевск",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3262,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 123,
    "slug": "balakovo",
    "name": "Балаково",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3405,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 125,
    "slug": "biysk",
    "name": "Бийск",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3701,
    "marketTypes": "HM,SM"
  },
  {
    "id": 127,
    "slug": "bratsk",
    "name": "Братск",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3633,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 129,
    "slug": "volzhskiy",
    "name": "Волжский",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3248,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 131,
    "slug": "dimitrovgrad",
    "name": "Димитровград",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3391,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 133,
    "slug": "zheleznovodsk",
    "name": "Железноводск",
    "stores": 2,
    "pickup": 1,
    "sampleStoreId": 3369,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 145,
    "slug": "ntg",
    "name": "Нижний Тагил",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3573,
    "marketTypes": "HM"
  },
  {
    "id": 155,
    "slug": "orsk",
    "name": "Орск",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3379,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 165,
    "slug": "tobolsk",
    "name": "Тобольск",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3505,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 167,
    "slug": "tolyatti",
    "name": "Тольятти",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 3260,
    "marketTypes": "HM"
  },
  {
    "id": 177,
    "slug": "achinsk",
    "name": "Ачинск",
    "stores": 2,
    "pickup": 1,
    "sampleStoreId": 3711,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 187,
    "slug": "Ulan-Ude",
    "name": "Улан-Удэ",
    "stores": 2,
    "pickup": 2,
    "sampleStoreId": 9199,
    "marketTypes": "HM,ZO"
  },
  {
    "id": 41,
    "slug": "bryansk",
    "name": "Брянск",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3313,
    "marketTypes": "HM"
  },
  {
    "id": 45,
    "slug": "vladimir",
    "name": "Владимир",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3216,
    "marketTypes": "HM"
  },
  {
    "id": 63,
    "slug": "kostroma",
    "name": "Кострома",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3381,
    "marketTypes": "HM"
  },
  {
    "id": 65,
    "slug": "kurgan",
    "name": "Курган",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3609,
    "marketTypes": "HM"
  },
  {
    "id": 71,
    "slug": "maykop",
    "name": "Майкоп",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3305,
    "marketTypes": "HM"
  },
  {
    "id": 89,
    "slug": "saransk",
    "name": "Саранск",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3254,
    "marketTypes": "HM"
  },
  {
    "id": 93,
    "slug": "smolensk",
    "name": "Смоленск",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3315,
    "marketTypes": "HM"
  },
  {
    "id": 113,
    "slug": "cheb",
    "name": "Чебоксары",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3222,
    "marketTypes": "HM"
  },
  {
    "id": 115,
    "slug": "cherkessk",
    "name": "Черкесск",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3258,
    "marketTypes": "HM"
  },
  {
    "id": 121,
    "slug": "armavir",
    "name": "Армавир",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3263,
    "marketTypes": "HM"
  },
  {
    "id": 135,
    "slug": "kuralskiy",
    "name": "Каменск-Уральский",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3495,
    "marketTypes": "HM"
  },
  {
    "id": 141,
    "slug": "nvt",
    "name": "Нижневартовск",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3627,
    "marketTypes": "HM"
  },
  {
    "id": 143,
    "slug": "niz",
    "name": "Нижнекамск",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3223,
    "marketTypes": "HM"
  },
  {
    "id": 151,
    "slug": "novocherkassk",
    "name": "Новочеркасск",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3545,
    "marketTypes": "HM"
  },
  {
    "id": 153,
    "slug": "obninsk",
    "name": "Обнинск",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3321,
    "marketTypes": "HM"
  },
  {
    "id": 157,
    "slug": "prk",
    "name": "Прокопьевск",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3631,
    "marketTypes": "HM"
  },
  {
    "id": 159,
    "slug": "sterlitamak",
    "name": "Стерлитамак",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3377,
    "marketTypes": "HM"
  },
  {
    "id": 169,
    "slug": "shakhty",
    "name": "Шахты",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3647,
    "marketTypes": "HM"
  },
  {
    "id": 173,
    "slug": "yurga",
    "name": "Юрга",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3737,
    "marketTypes": "HM"
  },
  {
    "id": 175,
    "slug": "novoshakhtinsk",
    "name": "Новошахтинск",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 3747,
    "marketTypes": "HM"
  },
  {
    "id": 181,
    "slug": "vladikavkaz",
    "name": "Владикавказ",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 5125,
    "marketTypes": "HM"
  },
  {
    "id": 183,
    "slug": "tambov",
    "name": "Тамбов",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 5313,
    "marketTypes": "HM"
  },
  {
    "id": 189,
    "slug": "anapa",
    "name": "Анапа",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 9803,
    "marketTypes": "HM"
  },
  {
    "id": 191,
    "slug": "nefteugansk",
    "name": "Нефтеюганск",
    "stores": 1,
    "pickup": 1,
    "sampleStoreId": 10349,
    "marketTypes": "HM"
  }
];

/** Регион по slug (именно slug идёт в X-Domain). */
export function lentaRegionBySlug(slug: string): LentaRegion | undefined {
  return LENTA_REGIONS.find((r) => r.slug === slug);
}

/** Регион по нашему id города из CITY_STORES. */
export function lentaRegionByCity(city: string): LentaRegion | undefined {
  return LENTA_REGIONS.find((r) => r.slug === CITY_TO_SLUG[city]);
}

/**
 * Наш id города -> slug региона Ленты. Разные системы нумерации: у нас
 * `saint-petersburg`, у Ленты `spb`; у нас `krasnodar`, у Ленты `ksdr`.
 * Подставить свой id в X-Domain нельзя — всё кроме Москвы уедет в 401.
 */
export const CITY_TO_SLUG: Record<string, string> = {
  moscow: 'moscow',
  'saint-petersburg': 'spb',
  ulyanovsk: 'ulyanovsk',
  krasnodar: 'ksdr',
  irkutsk: 'irkutsk',
  // Десять крупнейших городов Ленты по числу точек с самовывозом
  // (справочник LENTA_REGIONS, снят 2026-09-30). Слаг региона НЕ совпадает с
  // названием города и не выводится из него: Новосибирск — `nsk`, Пермь —
  // `perm`, Екатеринбург — `ekb`, Нижний Новгород — `nnov`, Краснодар — `ksdr`.
  novosibirsk: 'nsk',
  chelyabinsk: 'chel',
  perm: 'perm',
  ekaterinburg: 'ekb',
  kemerovo: 'kemerovo',
  omsk: 'omsk',
  barnaul: 'barnaul',
  'nizhny-novgorod': 'nnov',
  krasnoyarsk: 'krsk',
  kazan: 'kzn',
};
