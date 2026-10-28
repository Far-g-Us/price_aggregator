-- MVP схема: цены в разрезе город + магазин, история только по изменению
CREATE TABLE IF NOT EXISTS cities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

-- Точка сети в городе. Идентичность магазина — это ТРИ вещи вместе: сеть,
-- город и код точки. Поэтому ключ тройной: одна сеть в одном городе может
-- иметь несколько точек (у Магнита в СПб их десятки), и цена всегда
-- принадлежит конкретной точке, а не «магазину вообще».
CREATE TABLE IF NOT EXISTS stores (
  id TEXT NOT NULL,              -- pyaterochka | magnit | lenta
  city TEXT NOT NULL REFERENCES cities(id),
  external_store_id TEXT NOT NULL, -- sapCode / shopCode / storeId
  name TEXT NOT NULL,
  address TEXT,
  PRIMARY KEY (id, city, external_store_id)
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,           -- canonical id
  name TEXT NOT NULL,
  brand TEXT,
  unit TEXT NOT NULL,
  barcode TEXT,
  image_url TEXT,                -- одна главная картинка с сайта
  description TEXT,              -- если есть на сайте
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- склейка "один товар в разных сетях и точках"
--
-- store_code — часть ключа, а не украшение: store_sku и url описывают товар
-- КОНКРЕТНОЙ точки, и без кода вторая точка затирает первую, а джойн по
-- (canonical_id, store_id) открывает карточку чужой точки.
CREATE TABLE IF NOT EXISTS product_links (
  canonical_id TEXT NOT NULL REFERENCES products(id),
  store_id TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  store_code TEXT NOT NULL DEFAULT '?',
  store_sku TEXT NOT NULL,
  url TEXT,
  image_url TEXT,                -- переопределение картинки под сеть, если надо
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (canonical_id, store_id, city, store_code)
);

-- история изменения цен с датой; пишем только если price/promo/inStock изменились
--
-- store_code — часть идентичности цены. Значение '?' означает «точка неизвестна»:
-- так переносятся строки, написанные до появления точек, и они НИКОГДА не
-- склеиваются с линией реальной точки: новая точка — это новая история, а не
-- продолжение старой. Такая строка становится целью опроса, пока той же тройки
-- «товар + сеть + город» нет ни в одной реальной точке; после первой же записи
-- в реальную точку она перестаёт быть целью, иначе опрос спрашивал бы сеть
-- дважды на один товар каждый цикл.
CREATE TABLE IF NOT EXISTS prices_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  city TEXT NOT NULL,
  store_code TEXT NOT NULL DEFAULT '?',
  price REAL NOT NULL,
  promo_price REAL,
  old_price REAL,
  in_stock INTEGER NOT NULL DEFAULT 1,
  unit_price TEXT,
  collected_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prices_lookup
  ON prices_history (canonical_id, store_id, city, store_code, collected_at);

-- Избранное с целевой ценой. Ключ (canonical_id, store_id, city, store_code), а
-- не один canonical_id: цена всегда конкретного магазина, поэтому и «избранное» —
-- конкретное предложение. Иначе отметка в Москве задела бы Ульяновск, а
-- уведомление сработало бы на чужой цене.
--
-- Перенесённые строки лежат с store_code = '?', и это значит «любая точка этой
-- сети в этом городе», а не «точка неизвестна»: иначе отметка и раскладка
-- перестали бы работать до первого опроса, а новая точка в городе потребовала бы
-- размножения строк. Опрос при этом всегда пишет реальный код, поэтому линия
-- точки не смешивается с общей.
CREATE TABLE IF NOT EXISTS favorites (
  canonical_id TEXT NOT NULL REFERENCES products(id),
  store_id TEXT NOT NULL,
  city TEXT NOT NULL,
  store_code TEXT NOT NULL DEFAULT '?',
  -- null = просто отметка без порога. 0 и отрицательные запрещены проверкой
  -- в services: цена не может быть нулём, и порог 0 означал бы «уведомлять
  -- всегда», что молча превратилось бы в шум.
  target_price REAL,
  -- Цена, по которой УЖЕ сообщили. Без неё одна и та же отметка ниже порога
  -- уведомляла бы на каждом опросе (каждые 6 ч), то есть шум. Сообщаем только
  -- про новое снижение: цена должна стать строго НИЖЕ последней уведомлённой.
  notified_price REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (canonical_id, store_id, city, store_code)
);
CREATE INDEX IF NOT EXISTS idx_favorites_scope ON favorites (city, store_id);

-- Когда последний раз опрашивали каждый город. Без этого приложение не
-- помнит о прошлом опросе: lastRun жил только в памяти процесса, поэтому
-- перезапуск запускал опрос заново, даже если он был час назад.
CREATE TABLE IF NOT EXISTS poll_meta (
  city TEXT PRIMARY KEY REFERENCES cities(id),
  last_run TEXT,
  counts TEXT
);
CREATE INDEX IF NOT EXISTS idx_poll_meta_run ON poll_meta (last_run);

-- Что уже проверено в ТЕКУЩЕМ цикле опроса города.
--
-- Зачем: без неё повторное нажатие «Опросить» снова шло по всем 137 товарам
-- города, и товары с ошибками прошлого прогона терялись в общей очереди — их
-- повторный опрос нельзя было ни увидеть, ни дождаться. С отметками повторный
-- прогон берёт только то, что ещё не проверено (то есть новое и ошибочное), а
-- полный проход без прерывания обнуляет список — и следующий прогон снова
-- обходит всё.
--
-- БЕЗ внешних ключей — намеренно. При `PRAGMA foreign_keys = ON` ссылка на
-- products превращала удаление товара в «FOREIGN KEY constraint failed», а
-- openDatabase() глотает такую ошибку и отдаёт database: null: тихо умирают
-- вся история цен, полки и избранное. Строка сироты безвредна — при удалении
-- товара она просто больше не совпадёт ни с одной целью опроса.
CREATE TABLE IF NOT EXISTS poll_checklist (
  city TEXT NOT NULL,
  store_id TEXT NOT NULL,
  store_code TEXT NOT NULL DEFAULT '?',
  canonical_id TEXT NOT NULL,
  PRIMARY KEY (city, store_id, store_code, canonical_id)
);

-- Ручное «это разные товары». Склейка по названию ошибается: у Магнита и
-- Пятёрки нет общего штрих-кода, а Jaccard по названию не отличает «Сыр
-- сливочный 200 г» от «Сыр сливочный 200 г в упаковке». Строка означает «эту
-- пару никогда не склеивать». Направление неважно — сверка симметрична, поэтому
-- ключ хранится в алфавитном порядке, и (a,b) и (b,a) не создают двух строк.
CREATE TABLE IF NOT EXISTS product_splits (
  left_id TEXT NOT NULL,
  right_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (left_id, right_id)
);

-- Наши собственные категории (не витрины сетей): id как в taxonomy.ts.
CREATE TABLE IF NOT EXISTS our_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES our_categories(id),
  position INTEGER NOT NULL DEFAULT 0
);

-- Товар может лежать в нескольких наших категориях (у сетей он в разных),
-- поэтому связь many-to-many. city и store_code держим, чтобы разделить
-- раскладку по городам и точкам. Перенесённые строки лежат с store_code = '?',
-- то есть «любая точка этой сети в городе» — раскладка не должна теряться от
-- того, что точки в справочнике добавили.
CREATE TABLE IF NOT EXISTS product_categories (
  canonical_id TEXT NOT NULL REFERENCES products(id),
  store_id TEXT NOT NULL,
  city TEXT NOT NULL,
  store_code TEXT NOT NULL DEFAULT '?',
  category_id TEXT NOT NULL REFERENCES our_categories(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (canonical_id, store_id, city, store_code, category_id)
);
CREATE INDEX IF NOT EXISTS idx_product_categories_cat
  ON product_categories (city, category_id, store_id);

-- Маркер «товар под ручным управлением». Строка есть — автораскладка больше не
-- трогает этот товар: ни добавляет, ни убирает полки. Содержимое
-- product_categories при этом равно ровно тому, что выбрал пользователь, и
-- может быть пустым («убрать со всех полок»), поэтому отдельная таблица, а не
-- колонка в product_categories. Ключ — (canonical_id, store_id, city): цены и
-- наличие считаются по магазину, и правка в одной сети не должна трогать другую.
CREATE TABLE IF NOT EXISTS product_category_manual (
  canonical_id TEXT NOT NULL REFERENCES products(id),
  store_id TEXT NOT NULL,
  city TEXT NOT NULL,
  store_code TEXT NOT NULL DEFAULT '?',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (canonical_id, store_id, city, store_code)
);
CREATE INDEX IF NOT EXISTS idx_product_category_manual_scope
  ON product_category_manual (store_id, city);

INSERT OR IGNORE INTO our_categories (id, name, parent_id, position) VALUES
  ('dairy', 'Молочное и яйца', NULL, 1),
  ('dairy-milk', 'Молоко', 'dairy', 2),
  ('dairy-fermented', 'Кефир и йогурты', 'dairy', 3),
  ('dairy-cheese', 'Сыры', 'dairy', 4),
  ('dairy-butter', 'Масло', 'dairy', 5),
  ('bakery', 'Хлеб и выпечка', NULL, 6),
  ('bakery-bread', 'Хлеб и батоны', 'bakery', 7),
  ('meat', 'Мясо и птица', NULL, 8),
  ('meat-chicken', 'Курица и индейка', 'meat', 9),
  ('sausage', 'Колбасы', 'meat', 10),
  ('vegetables', 'Овощи', NULL, 11),
  ('fruit', 'Фрукты и ягоды', NULL, 12),
  ('groceries', 'Бакалея', NULL, 13),
  ('groceries-flour', 'Мука', 'groceries', 14),
  ('drinks', 'Напитки', NULL, 15),
  ('household', 'Быт и химия', NULL, 16)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  parent_id = excluded.parent_id,
  position = excluded.position;

INSERT OR IGNORE INTO cities (id, name) VALUES
  ('moscow', 'Москва'),
  ('saint-petersburg', 'Санкт-Петербург'),
  ('novosibirsk', 'Новосибирск'),
  ('ekaterinburg', 'Екатеринбург'),
  ('kazan', 'Казань'),
  ('nizhny-novgorod', 'Нижний Новгород'),
  ('chelyabinsk', 'Челябинск'),
  ('krasnoyarsk', 'Красноярск'),
  ('perm', 'Пермь'),
  ('barnaul', 'Барнаул'),
  ('omsk', 'Омск'),
  ('kemerovo', 'Кемерово'),
  ('ulyanovsk', 'Ульяновск'),
  ('krasnodar', 'Краснодар'),
  ('irkutsk', 'Иркутск'),
  ('ryazan', 'Рязань'),
  ('tula', 'Тула'),
  ('orel', 'Орёл'),
  ('bryansk', 'Брянск'),
  ('voronezh', 'Воронеж'),
  ('lipetsk', 'Липецк'),
  ('tambov', 'Тамбов'),
  ('vladimir', 'Владимир'),
  ('ivanovo', 'Иваново'),
  ('kaluga', 'Калуга'),
  ('smolensk', 'Смоленск'),
  ('tver', 'Тверь'),
  ('yaroslavl', 'Ярославль'),
  ('kursk', 'Курск'),
  ('belgorod', 'Белгород');
INSERT INTO stores (id, city, external_store_id, name)
VALUES
  ('pyaterochka', 'moscow', '35XY', 'Пятёрочка'),
  ('magnit', 'moscow', '303857', 'Магнит'),
  ('lenta', 'moscow', '4161', 'Лента'),
  ('pyaterochka', 'saint-petersburg', '5415', 'Пятёрочка'),
  ('magnit', 'saint-petersburg', '277027', 'Магнит'),
  ('lenta', 'saint-petersburg', '3135', 'Лента'),
  -- Десять новых городов Магнита: коды от юзера, подтверждены живым поиском
  -- 2026-10-01 (сверка по ссылкам на товары). Флаг готовности живёт в
  -- catalog.ts; здесь только коды и города, поэтому в сид попадают и
  -- выключенные магазины тоже.
  ('magnit', 'novosibirsk', '543579', 'Магнит'),
  ('lenta', 'novosibirsk', '3311', 'Лента'),
  ('magnit', 'ekaterinburg', '099255', 'Магнит'),
  ('lenta', 'ekaterinburg', '3481', 'Лента'),
  ('magnit', 'kazan', '747996', 'Магнит'),
  ('lenta', 'kazan', '3181', 'Лента'),
  ('magnit', 'nizhny-novgorod', '633408', 'Магнит'),
  ('lenta', 'nizhny-novgorod', '3170', 'Лента'),
  ('magnit', 'chelyabinsk', '740682', 'Магнит'),
  ('lenta', 'chelyabinsk', '3483', 'Лента'),
  ('magnit', 'krasnoyarsk', '432925', 'Магнит'),
  ('lenta', 'krasnoyarsk', '3491', 'Лента'),
  ('magnit', 'perm', '593395', 'Магнит'),
  ('lenta', 'perm', '3567', 'Лента'),
  ('magnit', 'barnaul', '221456', 'Магнит'),
  ('lenta', 'barnaul', '3563', 'Лента'),
  ('magnit', 'omsk', '558755', 'Магнит'),
  ('lenta', 'omsk', '3441', 'Лента'),
  ('magnit', 'kemerovo', '427498', 'Магнит'),
  ('lenta', 'kemerovo', '3517', 'Лента'),
  ('pyaterochka', 'ulyanovsk', '3288', 'Пятёрочка'),
  ('magnit', 'ulyanovsk', '730159', 'Магнит'),
  ('lenta', 'ulyanovsk', '3275', 'Лента'),
  ('magnit', 'krasnodar', '010033', 'Магнит'),
  ('lenta', 'krasnodar', '3208', 'Лента'),
  ('magnit', 'irkutsk', '540675', 'Магнит'),
  ('lenta', 'irkutsk', '3621', 'Лента'),
  ('svetofor', 'moscow', '820', 'Светофор'),
  ('svetofor', 'saint-petersburg', '206', 'Светофор'),
  -- Чижик: коды точек из /api/v1/shops (2026-10-08). Сеть покрывает 11 городов из
  -- 15 наших; Санкт-Петербурга, Красноярска, Омска и Иркутска в localities нет,
  -- и пустая строка сломала бы инвариант «у каждой сети в городе есть магазин».
  ('chizhik', 'moscow', 'HD87', 'Чижик'),
  ('chizhik', 'ulyanovsk', 'HDOW', 'Чижик'),
  ('chizhik', 'krasnodar', 'HDRA', 'Чижик'),
  ('chizhik', 'novosibirsk', 'HDJ7', 'Чижик'),
  ('chizhik', 'ekaterinburg', 'HD1W', 'Чижик'),
  ('chizhik', 'kazan', 'HDFD', 'Чижик'),
  ('chizhik', 'nizhny-novgorod', 'HD89', 'Чижик'),
  ('chizhik', 'chelyabinsk', 'HD98', 'Чижик'),
  ('chizhik', 'perm', 'HD0J', 'Чижик'),
  ('chizhik', 'barnaul', 'HDJT', 'Чижик'),
  ('chizhik', 'kemerovo', 'HDIG', 'Чижик'),
  -- Перекрёсток: 2053 — код точки из `content.sapId` в ответе каталога для
  -- Москвы по этому IP. Списка магазинов у сети в API нет (`/shop` → 400,
  -- `/shop/list` → 404, проверено 2026-10-10), и переключения города тоже не
  -- нашли: покрытие начинается с Москвы и расширяется только после того, как
  -- найдётся способ выбрать город.
  ('perekrestok', 'moscow', '2053', 'Перекрёсток'),
  -- Светофор в пятнадцати городах, где других сетей нет. Коды — из живой
  -- выгрузки сети (`api.php?mode=getShops`), у каждой точки самый свежий товар
  -- датирован сегодняшним днём; протухшие точки (свежесть больше месяца) в
  -- список не берут, иначе витрина показывала бы цены двухлетней давности.
  ('svetofor', 'ryazan', '630', 'Светофор'),
  ('svetofor', 'tula', '365', 'Светофор'),
  ('svetofor', 'orel', '75', 'Светофор'),
  ('svetofor', 'bryansk', '109', 'Светофор'),
  ('svetofor', 'voronezh', '703', 'Светофор'),
  ('svetofor', 'lipetsk', '120', 'Светофор'),
  ('svetofor', 'tambov', '640', 'Светофор'),
  ('svetofor', 'vladimir', '142', 'Светофор'),
  ('svetofor', 'ivanovo', '757', 'Светофор'),
  ('svetofor', 'kaluga', '713', 'Светофор'),
  ('svetofor', 'smolensk', '255', 'Светофор'),
  ('svetofor', 'tver', '274', 'Светофор'),
  ('svetofor', 'yaroslavl', '9', 'Светофор'),
  ('svetofor', 'kursk', '175', 'Светофор'),
  ('svetofor', 'belgorod', '193', 'Светофор'),
  -- Лента в тех же городах: коды из её справочника регионов, покрытие
  -- подтверждено живым поиском 2026-11-11 (в Воронеже и Ярославле Ленты нет).
  ('lenta', 'ryazan', '3237', 'Лента'),
  ('lenta', 'tula', '3845', 'Лента'),
  ('lenta', 'orel', '3271', 'Лента'),
  ('lenta', 'bryansk', '3313', 'Лента'),
  ('lenta', 'lipetsk', '3279', 'Лента'),
  ('lenta', 'tambov', '5313', 'Лента'),
  ('lenta', 'vladimir', '3216', 'Лента'),
  ('lenta', 'ivanovo', '3269', 'Лента'),
  ('lenta', 'kaluga', '3415', 'Лента'),
  ('lenta', 'smolensk', '3315', 'Лента'),
  ('lenta', 'tver', '3285', 'Лента'),
  ('lenta', 'kursk', '3375', 'Лента'),
  ('lenta', 'belgorod', '3253', 'Лента')
ON CONFLICT(id, city, external_store_id) DO UPDATE SET
  name = excluded.name;
