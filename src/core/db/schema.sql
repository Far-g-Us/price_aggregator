-- MVP схема: цены в разрезе город + магазин, история только по изменению
CREATE TABLE IF NOT EXISTS cities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  id TEXT NOT NULL,              -- pyaterochka | magnit | lenta
  city TEXT NOT NULL REFERENCES cities(id),
  external_store_id TEXT NOT NULL, -- sapCode / shopCode / storeId
  name TEXT NOT NULL,
  address TEXT,
  PRIMARY KEY (id, city)
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

-- склейка "один товар в разных сетях"
CREATE TABLE IF NOT EXISTS product_links (
  canonical_id TEXT NOT NULL REFERENCES products(id),
  store_id TEXT NOT NULL,
  store_sku TEXT NOT NULL,
  url TEXT,
  image_url TEXT,                -- переопределение картинки под сеть, если надо
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (canonical_id, store_id)
);

-- история изменения цен с датой; пишем только если price/promo/inStock изменились
CREATE TABLE IF NOT EXISTS prices_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  city TEXT NOT NULL,
  price REAL NOT NULL,
  promo_price REAL,
  old_price REAL,
  in_stock INTEGER NOT NULL DEFAULT 1,
  unit_price TEXT,
  collected_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prices_lookup
  ON prices_history (canonical_id, store_id, city, collected_at);

-- Избранное с целевой ценой. Ключ (canonical_id, store_id, city), а не один
-- canonical_id: цена всегда конкретного магазина, поэтому и «избранное» —
-- конкретное предложение. Иначе отметка в Москве задела бы Ульяновск, и
-- уведомление сработало бы на чужой цене.
CREATE TABLE IF NOT EXISTS favorites (
  canonical_id TEXT NOT NULL REFERENCES products(id),
  store_id TEXT NOT NULL,
  city TEXT NOT NULL,
  -- null = просто отметка без порога. 0 и отрицательные запрещены проверкой
  -- в services: цена не может быть нулём, и порог 0 означал бы «уведомлять
  -- всегда», что молча превратилось бы в шум.
  target_price REAL,
  -- Цена, по которой УЖЕ сообщили. Без неё одна и та же отметка ниже порога
  -- уведомляла бы на каждом опросе (каждые 6 ч), то есть шум. Сообщаем только
  -- про новое снижение: цена должна стать строго НИЖЕ последней уведомлённой.
  notified_price REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (canonical_id, store_id, city)
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
-- поэтому связь many-to-many. city держим, чтобы разделить раскладку по городам.
CREATE TABLE IF NOT EXISTS product_categories (
  canonical_id TEXT NOT NULL REFERENCES products(id),
  store_id TEXT NOT NULL,
  city TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES our_categories(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (canonical_id, store_id, city, category_id)
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (canonical_id, store_id, city)
);
CREATE INDEX IF NOT EXISTS idx_product_category_manual_scope
  ON product_category_manual (store_id, city);

INSERT OR IGNORE INTO our_categories (id, name, parent_id, position) VALUES
  ('dairy', 'Молочное и яйца', NULL, 1),
  ('dairy-milk', 'Молоко', NULL, 2),
  ('dairy-fermented', 'Кефир и йогурты', NULL, 3),
  ('dairy-cheese', 'Сыры', NULL, 4),
  ('dairy-butter', 'Масло', NULL, 5),
  ('bakery', 'Хлеб и выпечка', NULL, 6),
  ('bakery-bread', 'Хлеб и батоны', NULL, 7),
  ('meat', 'Мясо и птица', NULL, 8),
  ('meat-chicken', 'Курица и индейка', NULL, 9),
  ('sausage', 'Колбасы', NULL, 10),
  ('vegetables', 'Овощи', NULL, 11),
  ('fruit', 'Фрукты и ягоды', NULL, 12),
  ('groceries', 'Бакалея', NULL, 13),
  ('groceries-flour', 'Мука', NULL, 14),
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
  ('irkutsk', 'Иркутск');
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
  ('lenta', 'irkutsk', '3621', 'Лента')
ON CONFLICT(id, city) DO UPDATE SET
  external_store_id = excluded.external_store_id,
  name = excluded.name;
