#!/usr/bin/env node
// Fake pretix-like sale page for practice and timing tests.
// Mimics what tickets.events.ccc.de/40c3/ looked like on 2026-11-06 (closed: alert "Tickets will be sold on …",
// products marked unavailable) and what an open pretix shop looks like (quantity inputs + "Add to cart").
//
//   node fake/server.js --open-in 60 [--skew-ms 1500] [--queue] [--rate-limit 3] [--overload-ms 5000]
//
// Also usable as a module: startFakeServer(opts) -> {url, openAt, stats(), close()}
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function startFakeServer(o = {}) {
  const opts = {
    port: 4741, openIn: 60, openAt: null, skewMs: 0, latencyMs: 0, queue: false, queueSeconds: 20,
    rateLimit: 0, overloadMs: 0, overloadP: 0.5, ...o,
  };
  const openAt = opts.openAt ? Date.parse(opts.openAt) : Date.now() + opts.openIn * 1000; // in *server* time
  const sNow = () => Date.now() + opts.skewMs;
  const arrivals = [];
  const buckets = new Map();
  const queueEntered = new Map();
  const fmt = (t) => new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 19);

  const layout = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;max-width:760px;margin:2em auto;padding:0 1em}.alert-info{background:#d9edf7;padding:1em;border-radius:6px}
.product-row{display:flex;justify-content:space-between;border-bottom:1px solid #ddd;padding:.6em 0}.unavailable{color:#999}
.btn-primary{background:#3b1c4a;color:#fff;border:0;padding:.8em 1.4em;border-radius:6px;font-size:1.1em}.fake{background:#ffeb3b;padding:.3em .6em}</style>
</head><body><p class="fake">MTRT FAKE SALE PAGE – not the real shop</p><h1>40th Chaos Communication Congress</h1>${body}</body></html>`;
  const products = ['Standard', 'Supporter Ticket 230', 'Business Ticket', 'Up-and-coming Ticket'];
  const closedPage = () => layout('40th Chaos Communication Congress', `<div class="alert alert-info">The Community Phase of our presale is over.
Tickets will be sold on ${fmt(openAt)} (CET). More information <a href="#">here</a>.</div><h3>Tickets</h3>
${products.map((p) => `<article class="row product-row variation"><h5>${p}</h5><div class="availability-box unavailable"><small><a href="#voucher">Enter a voucher code below to buy this product.</a></small></div></article>`).join('')}
<aside><h3>Redeem a voucher</h3><form method="get" action="redeem"><input name="voucher" placeholder="Voucher code"><button>Redeem voucher</button></form></aside>`);
  const openPage = () => layout('40th Chaos Communication Congress', `<h3>Tickets</h3><form method="post" action="cart/add">
${products.map((p, i) => `<article class="row product-row variation"><h5>${p}</h5><div class="availability-box available"><input type="number" name="item_${i + 1}" min="0" max="2" value="0"></div></article>`).join('')}
<button id="btn-add-to-cart" class="btn btn-primary" type="submit">Add to cart</button></form>`);
  const queuePage = (left) => layout('Waiting room', `<h2>You are now in the queue</h2><p>Estimated wait: <b id="w">${left}</b> s. Do not reload this page.</p>
<script>let n=${left};setInterval(()=>{n--;document.getElementById('w').textContent=Math.max(0,n);if(n<=0)location.href='/40c3/?from_queue=1'},1000)</script>`);

  // Simulated network latency is split symmetrically: half on the way in, half on the way out.
  const server = http.createServer((req, res) => (opts.latencyMs ? setTimeout(() => handle(req, res), opts.latencyMs / 2) : handle(req, res)));
  const handle = (req, res) => {
    const arrival = Date.now();
    const url = new URL(req.url, 'http://x');
    const cookie = /__QXSESSION=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
    const sid = cookie || crypto.randomBytes(16).toString('hex');
    const send = (status, body, headers = {}) => {
      const go = () => {
        res.setHeader('Date', new Date(sNow()).toUTCString());
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Server', 'mtrt-fake');
        if (!cookie) res.setHeader('Set-Cookie', `__QXSESSION=${sid}; Max-Age=2592000; Path=/`);
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
        res.end(req.method === 'HEAD' ? undefined : body);
      };
      opts.latencyMs ? setTimeout(go, opts.latencyMs / 2) : go();
    };
    if (url.pathname === '/__stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ openAt, skewMs: opts.skewMs, arrivals }));
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(404); return res.end(); }
    const serverArrival = arrival + opts.skewMs;
    const rec = { arrival, serverArrival, path: url.pathname, method: req.method, seq: Number(req.headers['x-mtrt-seq']) || null,
      tab: req.headers['x-mtrt-tab'] != null ? Number(req.headers['x-mtrt-tab']) : null, slot: Number(req.headers['x-mtrt-slot']) || null, status: 0 };
    if (req.method === 'GET' && rec.seq) arrivals.push(rec);
    const isOpen = serverArrival >= openAt;

    if (opts.rateLimit && req.method === 'GET') {
      const b = buckets.get(sid) || []; const recent = b.filter((t) => arrival - t < 1000); recent.push(arrival); buckets.set(sid, recent);
      if (recent.length > opts.rateLimit) { rec.status = 429; return send(429, layout('Too many requests', '<h2>429 Too Many Requests</h2>'), { 'Retry-After': '5' }); }
    }
    if (url.pathname.startsWith('/40c3/queue')) {
      const left = Math.max(0, opts.queueSeconds - Math.round((arrival - (queueEntered.get(sid) || arrival)) / 1000));
      rec.status = 200; return send(200, queuePage(left));
    }
    if (url.pathname === '/' ) { rec.status = 302; return send(302, '', { Location: '/40c3/' }); }
    if (url.pathname.startsWith('/40c3')) {
      if (isOpen && opts.overloadMs && serverArrival < openAt + opts.overloadMs && Math.random() < opts.overloadP) {
        rec.status = 503; return send(503, layout('Service unavailable', '<h2>503 Service Unavailable</h2>'), { 'Retry-After': '3' });
      }
      if (isOpen && opts.queue && !url.searchParams.has('from_queue')) {
        if (!queueEntered.has(sid)) queueEntered.set(sid, arrival);
        rec.status = 302; return send(302, '', { Location: '/40c3/queue/' });
      }
      rec.status = 200; return send(200, isOpen ? openPage() : closedPage());
    }
    rec.status = 404; send(404, layout('Not found', '<h2>404</h2>'));
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${opts.port}/40c3/`, openAt, skewMs: opts.skewMs,
      stats: () => ({ openAt, arrivals }),
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? (a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true) : d; };
  const o = {
    port: Number(get('port', 4741)), openIn: Number(get('open-in', 60)), openAt: get('open-at', null), skewMs: Number(get('skew-ms', 0)),
    latencyMs: Number(get('latency-ms', 0)), queue: !!get('queue', false), queueSeconds: Number(get('queue-seconds', 20)),
    rateLimit: Number(get('rate-limit', 0)), overloadMs: Number(get('overload-ms', 0)), overloadP: Number(get('overload-p', 0.5)),
  };
  startFakeServer(o).then((s) => {
    console.log(`Fake sale page: ${s.url}`);
    console.log(`Opens at (server clock): ${new Date(s.openAt).toISOString()}  [skew ${o.skewMs} ms${o.queue ? ', queue' : ''}${o.rateLimit ? `, rate limit ${o.rateLimit}/s` : ''}${o.overloadMs ? `, 503s for ${o.overloadMs} ms` : ''}]`);
  });
}
