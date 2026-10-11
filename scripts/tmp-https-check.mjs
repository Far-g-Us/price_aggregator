const hosts = ['uly-msk.svetoforpfo.ru', 'svetoforpfo.ru', 'www.svetoforpfo.ru', 'uly-msk.svetoforonline.ru'];
const out = [];
for (const host of hosts) {
  for (const proto of ['https', 'http']) {
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(`${proto}://${host}/`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        redirect: 'manual',
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const text = new TextDecoder('windows-1251').decode(new Uint8Array(await res.arrayBuffer()));
      const title = text.match(/<title>([^<]{0,60})/i)?.[1]?.trim() ?? '';
      const shopid = text.match(/shopid\s*=\s*"?(\d+)"?/i)?.[1] ?? 'нет';
      out.push(
        `${proto}://${host} → ${res.status} за ${Date.now() - t0} мс, shopid=${shopid}, title="${title}", байт ${text.length}`,
      );
    } catch (e) {
      out.push(`${proto}://${host} → ${e instanceof Error ? e.name : 'ошибка'} за ${Date.now() - t0} мс: ${String(e).slice(0, 90)}`);
    }
  }
}
const fs = await import('node:fs');
fs.writeFileSync('scripts/tmp-https-check.txt', out.join('\n'), 'utf8');
console.log('готово');