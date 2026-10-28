// Готовит сертификаты для локального перехватчика трафика (scripts/net-log-proxy.mjs):
// корневой CA и листовой сертификат с SAN на нужные домены.
//
//   node scripts/make-proxy-ca.mjs [домен...]
//
// Зачем: чтобы перехватчик мог расшифровывать HTTPS, клиент должен доверять
// нашему корневому CA, а сертификат, который видит клиент, должен быть выдан
// на имя запрашиваемого хоста. Отдельный CA и отдельный лист — как в обычном
// корпоративном MITM.
//
// Требуется openssl (в поставке Git for Windows: C:\Program Files\Git\usr\bin\openssl.exe).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DOMAINS = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const HOSTS = DOMAINS.length
  ? DOMAINS
  : [
      'magnit.ru',
      'www.perekrestok.ru',
      '5ka.ru',
      '5d.5ka.ru',
      'app.chizhik.club',
      'example.com',
    ];

function opensslPath() {
  for (const c of [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
  ]) {
    try {
      execFileSync(c, ['version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* ищем дальше */
    }
  }
  return null;
}

const ssl = opensslPath();
if (!ssl) {
  console.error('make-proxy-ca: openssl не найден (поставка Git for Windows: usr/bin/openssl.exe)');
  process.exit(1);
}

const DIR = resolve('.cache');
mkdirSync(DIR, { recursive: true });
const run = (a) => execFileSync(ssl, a, { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

run([
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'probe-ca.key', '-out', 'probe-ca.pem',
  '-days', '3650', '-subj', '/CN=PriceAggregator Probe CA',
]);
run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'probe-leaf.key', '-out', 'probe-leaf.csr', '-subj', '/CN=probe']);
const san = HOSTS.map((h) => `DNS:${h}`).join(',');
writeFileSync(join(DIR, 'probe-leaf.ext'), `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
run([
  'x509', '-req', '-in', 'probe-leaf.csr', '-CA', 'probe-ca.pem', '-CAkey', 'probe-ca.key',
  '-CAcreateserial', '-out', 'probe-leaf.pem', '-days', '3650', '-sha256', '-extfile', 'probe-leaf.ext',
]);

console.log(`make-proxy-ca: готово в ${DIR}`);
console.log(`  CA:   ${join(DIR, 'probe-ca.pem')}`);
console.log(`  лист: ${join(DIR, 'probe-leaf.pem')} (SAN: ${san})`);
console.log('');
console.log('  В эмулятор (нужен root):');
console.log('    adb root && adb remount');
console.log(`    adb push ${join(DIR, 'probe-ca.pem')} /system/etc/security/cacerts/0102030d.0`);
console.log('    adb shell chmod 644 /system/etc/security/cacerts/0102030d.0');
console.log('    adb shell settings put global http_proxy 10.0.2.2:8899');
if (!existsSync(join(DIR, 'probe-leaf.pem'))) {
  console.error('лист не создан');
  process.exit(1);
}
