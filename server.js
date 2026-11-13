// Морський бій: сервер-посередник без залежностей. Запуск: node server.js
// Він не знає правил гри: лише зводить двох гравців за кодом і пересилає їхні повідомлення.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/icon.png': ['icon.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
};
const rooms = new Map();

const token = () => crypto.randomBytes(8).toString('hex');
const sse = (res, e) => res.write(`id: ${e.id}\ndata: ${JSON.stringify({ id: e.id, msg: e.msg, sys: e.sys })}\n\n`);

function newCode() {
  let c;
  do c = String(Math.floor(1000 + Math.random() * 9000)); while (rooms.has(c));
  return c;
}
/** Додає повідомлення в журнал кімнати й одразу доставляє іншому гравцю */
function push(room, from, msg, sys) {
  const e = { id: ++room.seq, from, msg, sys };
  room.log.push(e);
  if (room.log.length > 2000) room.log.shift();
  room.touched = Date.now();
  room.players.forEach((p, i) => { if (i !== from && p.res) sse(p.res, e); });
}
function auth(code, tok) {
  const room = rooms.get(String(code));
  const i = room ? room.players.findIndex(p => p.token === tok) : -1;
  return i < 0 ? [] : [room, i];
}
const readBody = req => new Promise(resolve => {
  let d = '';
  req.on('data', c => { d += c; if (d.length > 2e5) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
});

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (req.method === 'GET') {
    if (u.pathname === '/healthz') return res.end('ok');

    if (u.pathname === '/api/events') {
      const [room, i] = auth(u.searchParams.get('code'), u.searchParams.get('token'));
      if (!room) return json(404, { error: 'Сесію не знайдено' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const p = room.players[i];
      try { p.res && p.res.end(); } catch {}
      p.res = res;
      res.write('retry: 1500\n\n');
      // після розриву браузер сам надсилає Last-Event-ID, тож догортаємо все, що пропущено
      const after = Number(req.headers['last-event-id'] || u.searchParams.get('after') || 0);
      room.log.forEach(e => { if (e.id > after && e.from !== i) sse(res, e); });
      room.touched = Date.now();
      req.on('close', () => { if (p.res === res) p.res = null; });
      return;
    }

    const f = FILES[u.pathname];
    if (f) {
      try {
        const data = fs.readFileSync(path.join(__dirname, f[0]));
        res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-cache' });
        return res.end(data);
      } catch {}
    }
    return json(404, { error: 'Не знайдено' });
  }

  if (req.method !== 'POST') return json(405, { error: 'Не підтримується' });
  const b = await readBody(req);

  if (u.pathname === '/api/create') {
    const room = { code: newCode(), seq: 0, log: [], touched: Date.now(), players: [{ token: token(), lastN: 0, res: null }] };
    rooms.set(room.code, room);
    return json(200, { code: room.code, token: room.players[0].token });
  }

  if (u.pathname === '/api/join') {
    const room = rooms.get(String(b.code || '').trim());
    if (!room) return json(404, { error: 'Сесії з таким кодом немає' });
    if (room.players.length >= 2) return json(400, { error: 'У сесії вже двоє гравців' });
    const p = { token: token(), lastN: 0, res: null };
    room.players.push(p);
    push(room, 1, null, 'joined');
    return json(200, { code: room.code, token: p.token });
  }

  if (u.pathname === '/api/send') {
    const [room, i] = auth(b.code, b.token);
    if (!room) return json(404, { error: 'Сесію не знайдено' });
    if (typeof b.msg !== 'string' || b.msg.length > 20000) return json(400, { error: 'Неправильне повідомлення' });
    const p = room.players[i];
    if (Number(b.n) > p.lastN) { p.lastN = Number(b.n); push(room, i, b.msg); }   // повтори ігноруємо
    return json(200, { ok: 1 });
  }

  json(404, { error: 'Не знайдено' });
}).listen(PORT, '0.0.0.0', () => console.log('Морський бій працює на порту ' + PORT));

setInterval(() => {
  const old = Date.now() - 6 * 3600e3;
  rooms.forEach((r, k) => {
    r.players.forEach(p => p.res && p.res.write(':\n\n'));   // тримає зв’язок живим
    if (r.touched < old) rooms.delete(k);
  });
}, 20000);
