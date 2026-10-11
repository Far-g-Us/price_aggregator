import { connect } from 'node:tls';

const host = 'uly-msk.svetoforpfo.ru';
const socket = connect({ host, port: 443, rejectUnauthorized: false, servername: host }, () => {
  const cert = socket.getPeerCertificate();
  console.log('  subject:', cert.subject?.CN, '|', cert.subject?.O);
  console.log('  issuer:', cert.issuer?.O, '|', cert.issuer?.CN);
  console.log('  действителен до:', cert.valid_to);
  console.log('  самоподписанный:', cert.issuer?.CN === cert.subject?.CN);
  console.log('  SAN:', (cert.subjectaltname ?? '').slice(0, 120));
  socket.end();
});
socket.on('error', (e) => {
  console.log('  TLS-ошибка:', e.message.slice(0, 120));
  socket.end();
});
setTimeout(() => {
  console.log('  (таймаут)');
  process.exit(0);
}, 15000).unref?.();