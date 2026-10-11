import { writeFileSync } from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0' };
const out = [];

for (const host of ['uly-msk', 'uly-marata', 'perm', 'kazan-mir', 'nn-gagarina']) {
  try {
    const res = await fetch(`http://${host}.svetoforpfo.ru/`, { headers: UA, redirect: 'manual' });
    const html = new TextDecoder('windows-1251').decode(new Uint8Array(await res.arrayBuffer()));
    const shopid = html.match(/shopid\s*=\s*"?(\d+)"?/i)?.[1];
    const offersupd = html.match(/offersupd\s*=\s*"?(\d+)"?/)?.[1];
    const title = html.match(/<title>([^<]{0,70})/i)?.[1]?.trim() ?? '';
    const links = (html.match(/<a\b[^>]*href="\/[\w,.-]+\/"/gi) ?? []).length;
    out.push(`${host}: ${res.status} shopid=${shopid ?? 'нет'} offersupd=${offersupd ?? 'нет'} разделов=${links}`);
    out.push(`   title: ${title}`);

    if (shopid !== undefined && offersupd !== undefined) {
      const pr = await fetch(`http://${host}.svetoforpfo.ru/cache/offers-${shopid}-${offersupd}.json`, { headers: UA });
      const body = await pr.text();
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const count = Array.isArray(parsed) ? parsed.length : `не массив (${body.slice(0, 60)})`;
      out.push(`   прайс: ${pr.status}, байт ${body.length}, позиций ${count}`);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const first = parsed[0];
        out.push(`   поля: ${Object.keys(first).join(', ')}`);
        out.push(`   пример: ${JSON.stringify(first).slice(0, 260)}`);
        const newest = Math.max(...parsed.map((o) => Number(o.d) || 0));
        out.push(`   свежайшая позиция: ${new Date(newest * 1000).toISOString().slice(0, 10)}`);
      }
    }
  } catch (e) {
    out.push(`${host}: ${e instanceof Error ? e.name : 'ошибка'}`);
  }
}

writeFileSync('scripts/tmp-pfo-http.txt', out.join('\n'), 'utf8');
console.log('готово');