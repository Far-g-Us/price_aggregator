import re, json, os

tmp = os.environ['TEMP']
files = {
    'category': os.path.join(tmp, 'magnit-ssr.html'),
    'search': os.path.join(tmp, 'magnit-search.html'),
    'product': os.path.join(tmp, 'magnit-product.html'),
}
for kind, path in files.items():
    html = open(path, encoding='utf-8').read()
    blocks = re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S)
    print('===', kind, 'bytes:', len(html), 'ld blocks:', len(blocks))
    for b in blocks:
        d = json.loads(b)
        items = d.get('itemListElement', [])
        print('  type:', d.get('@type'), '| name:', str(d.get('name'))[:50], '| offers:', len(items))
        if items:
            print('  offer keys:', sorted(items[0].keys()))
            print('  sample:', json.dumps(items[0], ensure_ascii=False)[:500])
        if d.get('@type') == 'OfferCatalog' and kind == 'category':
            fixture = {'offers': items[:2]}
            out = os.path.join('tests', 'fixtures', 'magnit-category.json')
            json.dump(fixture, open(out, 'w', encoding='utf-8'), ensure_ascii=False)
            print('  fixture saved:', out)
        elif d.get('@type') == 'Product':
            print('  product keys:', sorted(d.keys()))
            print('  sample:', json.dumps(d, ensure_ascii=False)[:600])
            if kind == 'product':
                print('  OFFERS:', json.dumps(d.get('offers'), ensure_ascii=False)[:900])
                print('  BRAND:', json.dumps(d.get('brand'), ensure_ascii=False)[:200])
                print('  DESC:', str(d.get('description'))[:300])
                print('  WEIGHT:', json.dumps(d.get('weight'), ensure_ascii=False)[:200])
                print('  SKU:', d.get('sku'))
                out = os.path.join('tests', 'fixtures', 'magnit-product.json')
                json.dump(d, open(out, 'w', encoding='utf-8'), ensure_ascii=False)
                print('  fixture saved:', out)
