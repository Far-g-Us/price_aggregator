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

CREATE TABLE IF NOT EXISTS favorites (
  canonical_id TEXT PRIMARY KEY REFERENCES products(id),
  target_price REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

INSERT OR IGNORE INTO our_categories (id, name, parent_id, position) VALUES
  ('dairy', 'Молочное и яйца', NULL, 1),
  ('dairy-milk', 'Молоко', 'dairy', 1),
  ('dairy-fermented', 'Кефир и йогурты', 'dairy', 2),
  ('dairy-cheese', 'Сыры', 'dairy', 3),
  ('dairy-butter', 'Масло', 'dairy', 4),
  ('bakery', 'Хлеб и выпечка', NULL, 2),
  ('bakery-bread', 'Хлеб и батоны', 'bakery', 1),
  ('meat', 'Мясо и птица', NULL, 3),
  ('meat-chicken', 'Курица и индейка', 'meat', 1),
  ('sausage', 'Колбасы', NULL, 4),
  ('vegetables', 'Овощи', NULL, 5),
  ('fruit', 'Фрукты и ягоды', NULL, 6),
  ('groceries', 'Бакалея', NULL, 7),
  ('groceries-flour', 'Мука', 'groceries', 1),
  ('drinks', 'Напитки', NULL, 8),
  ('household', 'Быт и химия', NULL, 9)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  parent_id = excluded.parent_id,
  position = excluded.position;

INSERT OR IGNORE INTO cities (id, name) VALUES ('moscow', 'Москва');
INSERT OR IGNORE INTO cities (id, name) VALUES ('saint-petersburg', 'Санкт-Петербург');
INSERT OR IGNORE INTO cities (id, name) VALUES ('ulyanovsk', 'Ульяновск');
INSERT OR IGNORE INTO cities (id, name) VALUES ('krasnodar', 'Краснодар');
INSERT OR IGNORE INTO cities (id, name) VALUES ('irkutsk', 'Иркутск');
INSERT OR IGNORE INTO stores (id, city, external_store_id, name)
VALUES
  ('pyaterochka', 'moscow', '35XY', 'Пятёрочка'),
  ('magnit', 'moscow', '303857', 'Магнит'),
  ('lenta', 'moscow', 'TBD_STOREID', 'Лента'),
  ('pyaterochka', 'saint-petersburg', '5415', 'Пятёрочка'),
  ('magnit', 'saint-petersburg', '501478', 'Магнит'),
  ('pyaterochka', 'ulyanovsk', '3288', 'Пятёрочка'),
  ('magnit', 'ulyanovsk', '730159', 'Магнит'),
  ('magnit', 'krasnodar', '010033', 'Магнит'),
  ('magnit', 'irkutsk', '540675', 'Магнит')
ON CONFLICT(id, city) DO UPDATE SET
  external_store_id = excluded.external_store_id,
  name = excluded.name;
