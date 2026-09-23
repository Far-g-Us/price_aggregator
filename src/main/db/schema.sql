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

INSERT OR IGNORE INTO cities (id, name) VALUES ('moscow', 'Москва');
INSERT OR IGNORE INTO cities (id, name) VALUES ('ulyanovsk', 'Ульяновск');
INSERT OR IGNORE INTO stores (id, city, external_store_id, name)
VALUES
  ('pyaterochka', 'moscow', 'TBD_SAP', 'Пятёрочка'),
  ('magnit', 'moscow', '473996', 'Магнит'),
  ('lenta', 'moscow', 'TBD_STOREID', 'Лента'),
  ('pyaterochka', 'ulyanovsk', '3CX1', 'Пятёрочка');
