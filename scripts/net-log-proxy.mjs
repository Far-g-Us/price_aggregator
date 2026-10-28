// Свой перехват сетевых запросов — локальный MITM-прокси.
//
//   npm run net:log                       # порт 8899, лог в консоль
//   npm run net:log -- --out probe.log --only magnit
//
// Зачем он нужен. У GeckoView нет ни API перехвата запросов, ни `evaluateJS`
// (проверено по классам версий 147 и 158): увидеть, что именно сеть делает
// под Firefox-движком, штатным способом нельзя. Прокси закрывает эту дыру —
// он стоит между приложением и сетью и пишет всё: хост, метод, заголовки,
// тело запроса, статус и первые байты ответа.
//
// Сертификаты. Свои генерируются скриптом scripts/make-proxy-ca.mjs (нужен
// openssl из поставки Git for Windows): корневой CA и листовой сертификат с
// SAN на нужные домены. Лист лежит в .cache/probe-leaf.pem, CA — в
// .cache/probe-ca.pem.
//
// Как пользоваться.
//
//   1. node scripts/make-proxy-ca.mjs        # сертификаты
//   2. npm run net:log                       # прокси
//   3. Сказать устройству доверять CA.
//      Эмулятор (нужен root):
//        adb root && adb remount
//        adb push .cache/probe-ca.pem /system/etc/security/cacerts/0102030d.0
//        adb shell chmod 644 /system/etc/security/cacerts/0102030d.0
//        adb shell settings put global http_proxy 10.0.2.2:8899
//      Десктоп (Chrome/Firefox): импортировать .cache/probe-ca.pem в хранилище
//      сертификатов и указать прокси 127.0.0.1:8899.
//
// ЛИЦЕНЗИОННОЕ И ПРАВОВОЕ: инструмент только для личной отладки на своих
// устройствах и со своими учётными данными. Правила сетей (ToS) это не
// меняет: перехват собственного трафика для отладки собственного кода —
// обычная практика.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(argOf('--port', '8899'));
// По умолчанию — только localhost: прокси без авторизации на весь LAN — это
// открытый ретранслятор чужого трафика. Для эмулятора хост доступен как
// 10.0.2.2, но слушать на 0.0.0.0 нужно явным --host.
const HOST = argOf('--host', '127.0.0.1');
// Лог по умолчанию — в .cache/ (в .gitignore), а не куда попало.
const OUT = argOf('--out', path.resolve('.cache/net-log.log'));
const LEAF = argOf('--leaf', path.resolve('.cache/probe-leaf.pem'));
const LEAF_KEY = argOf('--leaf-key', path.resolve('.cache/probe-leaf.key'));
const BODY_LIMIT = Number(argOf('--body', '400'));
const ONLY = argOf('--only', '');

const log = (line) => {
  const stamp = new Date().toISOString().slice(11, 19);
  const text = `[${stamp}] ${line}`;
  process.stdout.write(`${text}\n`);
  if (OUT) fs.appendFileSync(OUT, `${text}\n`);
};

// Секреты в лог не пишем: у сетей в ответах лежат сессионные токены и
// антибот-куки, а лог может уехать в репозиторий. Значения таких полей
// заменяем на «***».
const SECRET = /("?(?:access_?token|refresh_?token|session_?token|token|password|authorization|cookie|passportaccesstoken|passportrefreshtoken|qrator[\w-]*|utk[\w-]*)"?\s*[:=]\s*")([^"]{0,400})(")/gi;

const preview = (buf) => {
  if (!buf || buf.length === 0) return '';
  const text = buf.toString('utf8').replace(/\s+/g, ' ').trim();
  const masked = text.replace(SECRET, '$1***$3');
  return masked.length > BODY_LIMIT ? `${masked.slice(0, BODY_LIMIT)}…` : masked;
};

const hasLeaf = fs.existsSync(LEAF) && fs.existsSync(LEAF_KEY);
if (!hasLeaf) {
  log(`MITM: нет листового сертификата (${LEAF}) — HTTPS-тела не расшифруются, видны только хосты`);
  log('  сгенерировать: node scripts/make-proxy-ca.mjs');
}

const server = http.createServer((req, res) => {
  const host = req.headers.host ?? '';
  if (ONLY && !host.includes(ONLY)) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('proxy: хост отфильтрован');
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    log(`→ ${req.method} http://${host}${req.url}`);
    if (body.length) log(`  тело запроса: ${preview(body)}`);
    const upstream = http.request(
      {
        host: req.headers.host?.split(':')[0],
        port: Number(req.headers.host?.split(':')[1] ?? 80),
        path: req.url,
        method: req.method,
        headers: { ...req.headers, 'accept-encoding': 'identity' },
      },
      (up) => {
        const out = [];
        up.on('data', (c) => out.push(c));
        up.on('end', () => {
          const data = Buffer.concat(out);
          log(`← ${up.statusCode} ${host}${req.url}`);
          const text = preview(data);
          if (text) log(`  тело ответа: ${text}`);
          res.writeHead(up.statusCode ?? 502, up.headers);
          res.end(data);
        });
      },
    );
    upstream.on('error', (e) => {
      log(`  ошибка соединения: ${e.message}`);
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(String(e.message));
    });
    if (body.length) upstream.write(body);
    upstream.end();
  });
});

const tlsServer = hasLeaf
  ? https.createServer({ key: fs.readFileSync(LEAF_KEY), cert: fs.readFileSync(LEAF) })
  : null;
if (tlsServer) {
  tlsServer.on('clientError', (e) => log(`  TLS-ошибка клиента: ${e.message}`));
  tlsServer.on('error', (e) => log(`  TLS-ошибка: ${e.message}`));
  tlsServer.on('request', (req, res) => {
    const host = req.headers.host ?? '';
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      log(`→ ${req.method} https://${host}${req.url}`);
      if (body.length) log(`  тело запроса: ${preview(body)}`);
      const upstream = https.request(
        {
          host: host.split(':')[0],
          port: Number(host.split(':')[1] ?? 443),
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host, 'accept-encoding': 'identity' },
        },
        (up) => {
          const out = [];
          up.on('data', (c) => out.push(c));
          up.on('end', () => {
            const data = Buffer.concat(out);
            log(`← ${up.statusCode} ${host}${req.url}`);
            const text = preview(data);
            if (text) log(`  тело ответа: ${text}`);
            res.writeHead(up.statusCode ?? 502, up.headers);
            res.end(data);
          });
        },
      );
      upstream.on('error', (e) => {
        log(`  ошибка соединения: ${e.message}`);
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(String(e.message));
      });
      if (body.length) upstream.write(body);
      upstream.end();
    });
  });
}

server.on('connect', (req, clientSocket, head) => {
  clientSocket.on('error', () => {});
  const [host, portRaw] = (req.url ?? '').split(':');
  const port = Number(portRaw ?? 443);
  if (ONLY && !host.includes(ONLY)) {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.destroy();
    return;
  }
  log(`→ CONNECT ${host}:${port}`);
  if (!tlsServer) {
    // Без листа видим только хост: TLS не вскроем.
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    return;
  }
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  // TLS делает сам https-сервер: он обернёт сокет в сессию со своим
  // secureContext (листовой сертификат).
  tlsServer.emit('connection', clientSocket);
});

server.listen(PORT, HOST, () => {
  log(`net-log-proxy слушает 0.0.0.0:${PORT}`);
  log(`  CA для установки: ${path.resolve('.cache/probe-ca.pem')}`);
  log('  эмулятор: adb shell settings put global http_proxy 10.0.2.2:' + PORT + ' (прокси должен слушать 0.0.0.0: --host 0.0.0.0)');
  log('  десктоп:  прокси 127.0.0.1:' + PORT + ', CA импортировать в хранилище');
});
