const UA = { 'User-Agent': 'Mozilla/5.0' };
const dec = (b) => new TextDecoder('windows-1251').decode(b);

for (const host of ['uly-msk', 'uly-marata', 'perm', 'perm-vas', 'kazan-mir']) {
  try {
    const res = await fetch(`https://${host}.svetoforpfo.ru/`, { headers: UA });
    const html = dec(new Uint8Array(await res.arrayBuffer()));
    const shopid = html.match(/shopid\s*=\s*"?(\d+)"?/i)?.[1];
    const offersupd = html.match(/offersupd\s*=\s*"?(\d+)"?/)?.[1];
    const title = html.match(/<title>([^<]{0,60})/i)?.[1]?.trim() ?? '';
    const links = (html.match(/<a\b[^>]*href="\/[\w,.-]+\/"/gi) ?? []).length;
    const icons = (html.match(/svg\/menu-\d+\.svg/gi) ?? []).length;
    console.log(`  ${host}: ${res.status}, shopid=${shopid ?? 'нет'}, offersupd=${offersupd ?? 'нет'}, разделов-ссылок=${links}, svg=${icons}`);
    console.log(`      title: ${title}`);

    if (shopid !== undefined && offersupd !== undefined) {
      const priceUrl = `https://${host}.svetoforpfo.ru/cache/offers-${shopid}-${offersupd}.json`;
      const pr = await fetch(priceUrl, { headers: UA });
      const body = await pr.text();
      let count = -1;
      try {
        const parsed = JSON.parse(body);
        count = Array.isArray(parsed) ? parsed.length : -2;
      } catch {
        count = -1;
      }
      console.log(`      прайс: ${pr.status}, байт ${body.length}, позиций ${count}`);
      if (count > 0) {
        const parsed = JSON.parse(body);
        const first = parsed[0];
        console.log(`      пример: ${JSON.stringify(first).slice(0, 220)}`);
      }
    }
  } catch (e) {
    console.log(`  ${host}: ${e instanceof Error ? e.name : 'ошибка'}`);
  }
}