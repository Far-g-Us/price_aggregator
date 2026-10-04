// Мелкие ветки адаптеров, до которых не дошла основная проверка: рассинхрон
// справочника регионов, сверка ответа по id у Ленты, разбор пейлоада Магнита,
// когда цены в нём нет, и края нормализации карточки.
//
// Каждая проверка тут — про конкретное решение кода. Если решение уберут, тест
// должен упасть, а не остаться в зелёном.
import assert from 'node:assert';
import fs from 'node:fs';
import { assertLentaAnswered, lentaDomain } from '../src/core/adapters/lenta.js';
import {
  extractCategoryOffers,
  normalizeMagnitProduct,
  parseMagnitCategoryPromos,
  parseMagnitSearchGoods,
} from '../src/core/adapters/magnit.js';
import type { ScrapedProduct } from '../src/shared/types.js';

const html = (name: string): string => fs.readFileSync(`tests/fixtures/${name}`, 'utf8');

// ─── Лента: справочник регионов и сверка ответа ──────────────────────────
{
  // slug есть в CITY_TO_SLUG, но региона нет — это рассинхрон данных, и он
  // обязан быть громким, а не приводить к 401 в молоко.
  assert.throws(
    () => lentaDomain('moscow', []),
    /регион «moscow» не найден в справочнике/,
    'пустой справочник регионов — loud-ошибка, а не молчаливая подмена',
  );
  assert.throws(
    () => lentaDomain('moscow', [{ slug: 'spb' }]),
    /не найден в справочнике/,
    'чужой регион тоже не подходит: slug города и slug региона — разные вещи',
  );
  assert.equal(lentaDomain('moscow'), 'moscow', 'с настоящим справочником всё работает');

  const product = { canonicalId: 'lenta-300886' } as ScrapedProduct;
  assert.doesNotThrow(() => assertLentaAnswered('lenta-300886', product), 'тот же id — сверка проходит');
  assert.throws(
    () => assertLentaAnswered('lenta-111', product),
    /просили lenta-111, а ответ по lenta-300886/,
    'ответ по другому товару в историю не попадает',
  );
}

// ─── Магнит: пейлоад с товарами и пейлоад без цен ────────────────────────
{
  const SHOP = '473996';
  const search = html('magnit-search.html');
  const goods = parseMagnitSearchGoods(search, SHOP);
  assert.ok(goods.length > 0, 'товары из пейлоада разобраны');
  assert.ok(goods.every((g) => g.id && g.title), 'у каждого есть id и название');

  // Ссылки на товары в пейлоаде есть, а цены и id выбиты в пустые строки —
  // дрейф вёрстки, а не «пусто». Именно этот случай ловит громкая ошибка.
  const priceless = search.replace(/"[\d.,]+"/g, '""');
  assert.notEqual(priceless, search, 'фикстуру действительно изменили, иначе проверка враньё');
  assert.throws(
    () => parseMagnitSearchGoods(priceless, SHOP),
    /смена вёрстки/,
    'товары без цен при живом магазине — смена вёрстки, а не пустая выдача',
  );

  assert.throws(
    () => parseMagnitSearchGoods(search, '303857'),
    /чужого магазина/,
    'пейлоад чужого магазина не принимается',
  );

  const promos = parseMagnitCategoryPromos(html('magnit-category-promo.html'), SHOP);
  assert.ok(promos instanceof Map, 'промо витрины разбираются в карту');
  assert.throws(
    () => parseMagnitCategoryPromos(html('magnit-category-promo.html'), '303857'),
    /чужого магазина/,
    'витрина чужого магазина отвергается',
  );
}

// ─── Магнит: битая разметка в скрипте ──────────────────────────────────
// В реальном HTML попадаются обрезанные или дважды экранированные блоки
// JSON-LD. Такой блок обязан пропускаться, а не ронять разбор всей витрины.
{
  const brokenLd = [
    '<html><body><script type="application/ld+json">{ этот блок не JSON }</script>',
    '<a href="/catalog/?shopCode=473996">витрина</a></body></html>',
  ].join('');
  assert.deepEqual(
    extractCategoryOffers(brokenLd, { city: 'moscow', shopCode: '473996' }),
    [],
    'битый JSON-LD пропущен, витрина разобрана как пустая, а не сломана',
  );
}

// ─── Магнит: нормализация карточки с offers-массивом и весом ──────────────
{
  const fromArray = normalizeMagnitProduct(
    { name: 'Сыр', sku: '900', offers: [{ price: '199' }] },
    { city: 'moscow', url: 'https://magnit.ru/product/900' },
  );
  assert.equal(fromArray?.price, 199, 'цена взята из offers-массива');
  assert.equal(fromArray?.canonicalId, 'magnit-900', 'id из sku');
  assert.equal(fromArray?.inStock, true, 'без availability товар считается в наличии');

  const withWeight = normalizeMagnitProduct(
    { name: 'Сыр', sku: '901', offers: { price: '199' }, weight: { value: 200, unitText: 'г' } },
    { city: 'moscow', url: 'https://magnit.ru/product/901' },
  );
  assert.equal(withWeight?.unit, '200г', 'вес склеен из значения и единицы без разделителя');

  const soldOut = normalizeMagnitProduct(
    { name: 'Сыр', sku: '902', offers: { price: '10', availability: 'OutOfStock' } },
    { city: 'moscow', url: 'https://magnit.ru/product/902' },
  );
  assert.equal(soldOut?.inStock, false, 'OutOfStock — товара нет');
}
console.log('adapter edges: ALL GREEN — справочник регионов, сверка id, пейлоад без цен, offers и вес');