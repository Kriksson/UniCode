import { createServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual, createHash, X509Certificate } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, extname, resolve, sep } from 'node:path';
import selfsigned from 'selfsigned';
import QRCode from 'qrcode';

const allowedMethods = new Set(['bootstrap', 'list', 'history', 'send', 'steer', 'interrupt', 'answer', 'rate-limits', 'manage-chat', 'delete-chat', 'delete-from']);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2' };
const digest = value => createHash('sha256').update(value).digest('hex');
const cookieMaxAge = 400 * 24 * 60 * 60;
const failure = (status, message) => Object.assign(new Error(message), { status });
const ipNumber = value => value.split('.').reduce((result, part) => (result << 8) | Number(part), 0) >>> 0;

export function localAddresses() {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries || [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal
      && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address)
      && !/^(docker|br-|veth|waydroid|tun|tap|wg|tailscale|happ)/i.test(name))
    .map(entry => ({ name, address: entry.address, netmask: entry.netmask })))
    .sort((a, b) => Number(/^wl/.test(b.name)) - Number(/^wl/.test(a.name)));
}

/** Opt-in LAN endpoint. TLS, one-use pairing, native approval, and revocable sessions. */
export class PhoneServer {
  constructor({ root, dataPath, invoke, approve, changed }) {
    Object.assign(this, { root, dataPath, invoke, approve, changed });
    this.sessions = new Map();
    this.streams = new Set();
    this.attempts = new Map();
    this.sockets = new Set();
    this.generation = 0;
    this.queue = Promise.resolve();
  }

  async loadDevices() {
    if (!this.loaded) this.loaded = (async () => {
      let saved;
      try { saved = JSON.parse(await readFile(join(this.dataPath, 'phone-devices.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (saved.version !== 1 || !Array.isArray(saved.devices)) throw new Error('Не удалось прочитать сохранённые подключения телефона.');
      this.port = Number.isInteger(saved.port) && saved.port >= 1025 && saved.port <= 65535 ? saved.port : 0;
      for (const device of saved.devices.slice(0, 5)) {
        if (!/^[a-f0-9]{64}$/.test(device.key) || typeof device.id !== 'string'
          || typeof device.name !== 'string' || !Number.isFinite(device.connectedAt)) continue;
        this.sessions.set(device.key, { id: device.id, name: device.name.slice(0, 60), connectedAt: device.connectedAt, count: 0, interval: Date.now() });
      }
    })();
    return this.loaded;
  }

  saveDevices() {
    // Persist hashes only; the bearer token remains in the phone's HttpOnly cookie.
    const data = JSON.stringify({ version: 1, port: this.port || 0,
      devices: [...this.sessions].map(([key, { id, name, connectedAt }]) => ({ key, id, name, connectedAt })) });
    const operation = this.queue.then(async () => {
      const path = join(this.dataPath, 'phone-devices.json');
      await mkdir(this.dataPath, { recursive: true, mode: 0o700 });
      await writeFile(`${path}.tmp`, data, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  remember(request, response) {
    const token = request.headers.cookie?.match(/(?:^|;\s*)unicode_phone=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
    if (token) this.setCookie(response, token);
  }

  setCookie(response, token) {
    response.setHeader('Set-Cookie', `unicode_phone=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${cookieMaxAge}`);
  }

  status() {
    return {
      enabled: !!this.server, addresses: localAddresses(), host: this.host || null,
      url: this.origin || null, pairingUrl: this.ticket ? `${this.origin}/#pair=${this.ticket.secret}` : null,
      expiresAt: this.ticket?.expiresAt || null, qr: this.ticket?.qr || null,
      fingerprint: this.fingerprint || null,
      devices: [...this.sessions.values()]
        .map(({ id, name, connectedAt }) => ({ id, name, connectedAt })),
    };
  }

  async certificate(host) {
    const path = join(this.dataPath, 'phone-tls.json');
    try {
      const saved = JSON.parse(await readFile(path, 'utf8'));
      const certificate = new X509Certificate(saved.cert);
      if (certificate.checkIP(host) && Date.parse(certificate.validTo) > Date.now() + 86400000) return saved;
    } catch { /* Missing, expired, or a new LAN address: create a local certificate. */ }
    const saved = await selfsigned.generate([{ name: 'commonName', value: 'UniCode v1' }], {
      keyType: 'ec', curve: 'P-256', algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 7, ip: host }] },
      ],
    });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(`${path}.tmp`, JSON.stringify({ cert: saved.cert, private: saved.private }), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    return saved;
  }

  async start(host) {
    if (this.starting) return this.starting;
    if (this.server) return this.status();
    this.starting = this.open(host).finally(() => { this.starting = null; });
    return this.starting;
  }

  async open(host) {
    const generation = this.generation;
    await this.loadDevices();
    if (generation !== this.generation) throw new Error('Подключение отменено');
    const address = localAddresses().find(entry => entry.address === host) || (!host ? localAddresses()[0] : null);
    if (!address) throw new Error('Подключите компьютер к Wi-Fi или локальной сети.');
    const keys = await this.certificate(address.address);
    if (generation !== this.generation) throw new Error('Подключение отменено');
    const sockets = new Set();
    const server = createServer({ key: keys.private, cert: keys.cert, minVersion: 'TLSv1.2', handshakeTimeout: 10000 }, (request, response) => {
      response.on('error', () => response.destroy());
      void this.route(request, response).catch(error => {
        if (!response.headersSent) this.json(response, error.status || 500, { error: error.status ? error.message : 'Не удалось выполнить запрос. Повторите действие.' });
        else response.end();
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.headersTimeout = 10000; server.requestTimeout = 60000; server.maxConnections = 32;
    await new Promise((resolve, reject) => {
      const onError = error => reject(error.code === 'EADDRINUSE'
        ? new Error('Порт подключения телефона занят. Освободите его и включите подключение заново.') : error);
      server.once('error', onError);
      server.listen(this.port || 0, address.address, () => { server.removeListener('error', onError); resolve(); });
    });
    if (generation !== this.generation) { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); server.close(); throw new Error('Подключение отменено'); }
    this.server = server; this.host = address.address; this.netmask = address.netmask;
    this.sockets = sockets;
    this.origin = `https://${this.host}:${server.address().port}`;
    this.port = server.address().port;
    try { await this.saveDevices(); } catch (error) { await this.stop(); throw error; }
    if (generation !== this.generation) throw new Error('Подключение отменено');
    this.fingerprint = new X509Certificate(keys.cert).fingerprint256;
    server.on('error', () => { void this.stop(); });
    this.heartbeat = setInterval(() => {
      for (const stream of this.streams) {
        if (stream.response.destroyed || stream.response.writableEnded) { this.streams.delete(stream); continue; }
        if (!stream.response.write(': heartbeat\n\n')) stream.response.destroy();
      }
      for (const [ip, attempts] of this.attempts) if (attempts.until < Date.now()) this.attempts.delete(ip);
      if (this.ticket && this.ticket.expiresAt < Date.now()) { this.ticket = null; this.changed(this.status()); }
    }, 20000);
    this.heartbeat.unref();
    return this.newCode();
  }

  async newCode() {
    if (!this.server) throw new Error('Сначала включите подключение');
    const ticket = { secret: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 300000 };
    ticket.qr = await QRCode.toDataURL(`${this.origin}/#pair=${ticket.secret}`, { width: 256, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#322b29', light: '#ffffff' } });
    if (!this.server) throw new Error('Подключение выключено');
    this.ticket = ticket; this.changed(this.status()); return this.status();
  }

  async stop() {
    this.generation++; clearInterval(this.heartbeat); this.ticket = null;
    const server = this.server; this.server = null;
    for (const stream of this.streams) stream.response.end();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.streams.clear(); this.attempts.clear();
    this.origin = null; this.host = null;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await this.queue;
    this.changed(this.status()); return this.status();
  }

  async revoke(id) {
    await this.loadDevices();
    for (const [key, session] of this.sessions) if (session.id === id) {
      this.sessions.delete(key);
      for (const stream of this.streams) if (stream.session === session) { stream.response.end(`data: ${JSON.stringify({ type: 'remote-revoked' })}\n\n`); this.streams.delete(stream); }
    }
    await this.saveDevices();
    this.changed(this.status()); return this.status();
  }

  broadcast(event) {
    // Desktop-only pairing secrets must never enter a remote event stream.
    if (event.type === 'phone-status' || event.type === 'focus-thread') return;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of this.streams) {
      if (stream.response.destroyed || stream.response.writableEnded) { this.streams.delete(stream); continue; }
      if (!stream.response.write(frame) || stream.response.writableLength > 1024 * 1024) stream.response.destroy();
    }
  }

  json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  }

  async body(request) {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw failure(415, 'Неверный формат запроса');
    let length = 0; const chunks = [];
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 1024 * 1024) throw failure(413, 'Слишком большой запрос');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure(400, 'Неверный запрос'); }
  }

  session(request) {
    const value = request.headers.cookie?.match(/(?:^|;\s*)unicode_phone=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
    const session = value ? this.sessions.get(digest(value)) : null;
    if (!session) throw failure(401, 'Подключите телефон заново через QR-код.');
    return session;
  }

  async route(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const origin = this.origin;
    if (!origin || request.headers.host !== new URL(origin).host) throw failure(403, 'Адрес подключения изменился. Откройте новый QR-код на компьютере.');
    const ip = request.socket.remoteAddress?.replace(/^::ffff:/, '') || '';
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || (ipNumber(ip) & ipNumber(this.netmask)) !== (ipNumber(this.host) & ipNumber(this.netmask))) throw failure(403, 'Подключитесь к той же Wi-Fi сети.');
    const url = new URL(request.url, origin);
    // A QR scanner or another page can initiate a cross-site navigation to the
    // public shell. It contains no session data. Keep the API and every POST
    // restricted to our origin, including the pairing request itself.
    const publicDocument = (request.method === 'GET' || request.method === 'HEAD')
      && (url.pathname === '/' || url.pathname === '/mobile.html');
    if (!publicDocument) {
      if (request.headers.origin && request.headers.origin !== origin) throw failure(403, 'Откройте ссылку UniCode в обычном браузере телефона.');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw failure(403, 'Откройте ссылку UniCode в обычном браузере телефона.');
    }
    if (request.method === 'POST' && request.headers.origin !== origin) throw failure(403, 'Браузер не подтвердил адрес страницы. Откройте QR-код заново в обычном браузере.');
    if (request.method === 'POST' && url.pathname === '/pair') {
      let attempts = this.attempts.get(ip);
      if (!attempts || attempts.until < Date.now()) { attempts = { count: 0, until: Date.now() + 60000 }; this.attempts.set(ip, attempts); }
      if (++attempts.count > 8) throw failure(429, 'Повторите подключение через минуту.');
      const { secret, name } = await this.body(request);
      const ticket = this.ticket;
      if (!ticket || ticket.expiresAt < Date.now() || typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)
        || !timingSafeEqual(Buffer.from(secret), Buffer.from(ticket.secret))) throw failure(401, 'QR-код истёк. Создайте новый на компьютере.');
      if (this.sessions.size >= 5) throw failure(409, 'Отключите одно из подключённых устройств.');
      this.ticket = null; this.changed(this.status());
      const deviceName = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60) : 'Телефон';
      const generation = this.generation;
      const accepted = await this.approve(deviceName || 'Телефон');
      if (!accepted || this.generation !== generation || this.origin !== origin || response.destroyed) throw failure(403, 'Подключение не подтверждено на компьютере.');
      if (this.sessions.size >= 5) throw failure(409, 'Отключите одно из подключённых устройств.');
      const token = randomBytes(32).toString('base64url');
      const session = { id: randomUUID(), name: deviceName || 'Телефон', connectedAt: Date.now(), count: 0, interval: Date.now() };
      this.sessions.set(digest(token), session);
      try { await this.saveDevices(); } catch (error) { this.sessions.delete(digest(token)); throw error; }
      if (this.generation !== generation || response.destroyed) return;
      this.setCookie(response, token);
      this.changed(this.status()); this.json(response, 200, { connected: true }); return;
    }
    if (url.pathname === '/session' && request.method === 'GET') { this.session(request); this.remember(request, response); this.json(response, 200, { connected: true }); return; }
    if (url.pathname === '/events' && request.method === 'GET') {
      const session = this.session(request);
      if ([...this.streams].filter(stream => stream.session === session).length >= 3) throw failure(429, 'Слишком много открытых вкладок.');
      this.remember(request, response);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.write(': connected\n\n');
      const stream = { session, response }; this.streams.add(stream);
      response.on('close', () => this.streams.delete(stream)); return;
    }
    if (url.pathname === '/rpc' && request.method === 'POST') {
      const session = this.session(request);
      this.remember(request, response);
      if (Date.now() - session.interval > 1000) { session.interval = Date.now(); session.count = 0; }
      if (++session.count > 30) throw failure(429, 'Слишком много запросов.');
      const { method, args } = await this.body(request);
      if (!allowedMethods.has(method) || !Array.isArray(args) || args.length > 3) throw failure(403, 'Действие недоступно с телефона.');
      if (this.session(request) !== session) throw failure(401, 'Подключение отключено.');
      try { this.json(response, 200, { result: await this.invoke(method, args) }); }
      catch (error) { this.json(response, 400, { error: error.message || 'Не удалось выполнить действие' }); }
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') throw failure(405, 'Метод недоступен');
    let path;
    if (url.pathname === '/' || url.pathname === '/mobile.html') path = join(this.root, 'dist/mobile.html');
    else if (url.pathname === '/app-icon.png') path = join(this.root, 'assets/icon.png');
    else if (/^\/(assets|fonts)\/[A-Za-z0-9_.\/-]+$/.test(url.pathname)) {
      path = resolve(this.root, 'dist', `.${url.pathname}`);
      if (!path.startsWith(resolve(this.root, 'dist') + sep)) throw failure(404, 'Не найдено');
    } else throw failure(404, 'Не найдено');
    if (!mime[extname(path)]) throw failure(404, 'Не найдено');
    let data;
    try { data = await readFile(path); } catch { throw failure(404, 'Не найдено'); }
    response.writeHead(200, { 'Content-Type': mime[extname(path)], 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : data);
  }
}
