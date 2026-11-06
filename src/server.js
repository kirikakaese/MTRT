// Local control panel: static UI + JSON API + Server-Sent Events. Binds to 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, listPresets, loadPreset, savePreset, resolveConfig, deepMerge, validate, DEFAULTS, loadLocal } from './config.js';

const PUB = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const CSV_COLS = ['t', 'seq', 'tab', 'phase', 'kind', 'result', 'status', 'slot', 'plannedDispatch', 'dispatch', 'dispatchErrMs', 'startErrMs', 'ttfbMs', 'totalMs', 'retryAfterMs', 'waitMs', 'url', 'error', 'reason'];

export function startServer(engine, port) {
  const clients = new Set();
  let pendingLogs = [];
  const broadcast = (event, data) => { const s = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(s); };
  let dirty = true;
  engine.on('change', () => { dirty = true; });
  engine.on('log', (e) => pendingLogs.push(e));
  engine.on('alert', (a) => broadcast('alert', a));
  engine.on('info', (m) => { console.log('[mtrt]', m); broadcast('info', m); });
  setInterval(() => {
    if (dirty || engine.state === 'armed') { dirty = false; broadcast('state', engine.snapshot()); }
    if (pendingLogs.length) { broadcast('log', pendingLogs); pendingLogs = []; }
  }, 200).unref();

  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const body = (req) => new Promise((resolve, reject) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // Defend against DNS-rebinding / cross-site requests from web pages you visit.
    const host = (req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(host)) { res.writeHead(403); return res.end('forbidden host'); }
    if (req.method === 'POST' && req.headers['x-mtrt'] !== '1') { res.writeHead(403); return res.end('missing header'); }
    try {
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`event: state\ndata: ${JSON.stringify(engine.snapshot())}\n\n`);
        res.write(`event: log\ndata: ${JSON.stringify(engine.log.slice(-300))}\n\n`);
        clients.add(res); req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, engine.snapshot());
      if (req.method === 'GET' && url.pathname === '/api/presets') return json(res, 200, { presets: listPresets(), defaults: DEFAULTS, hasNtfy: !!loadLocal().alerts?.ntfyTopic });
      if (req.method === 'GET' && url.pathname.startsWith('/api/presets/')) {
        const name = decodeURIComponent(url.pathname.slice(13));
        return json(res, 200, resolveConfig(name));
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/presets/')) {
        const name = decodeURIComponent(url.pathname.slice(13));
        const cfg = validate(deepMerge(engine.cfg, await body(req)));
        return json(res, 200, { saved: savePreset(name, cfg) });
      }
      if (req.method === 'POST' && url.pathname === '/api/config') {
        const b = await body(req);
        engine.cfg = validate(deepMerge(engine.cfg, b));
        engine.emit('change');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/arm') {
        const b = await body(req);
        const cfg = validate(deepMerge(engine.cfg, b));
        engine.arm(cfg).catch((e) => engine.emit('info', 'Arm failed: ' + e.message));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/stop') { engine.stop('stopped by user'); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/api/panic') { engine.stop('PANIC STOP', { panic: true }); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/api/ack') { if (engine.state === 'triggered') { engine.state = 'stopped'; engine.emit('change'); } return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/api/prepare') { await engine.prepare(); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/api/sync') { const c = await engine.syncClock(); return json(res, 200, c); }
      if (req.method === 'POST' && url.pathname === '/api/test-alert') { const r = await engine.testAlert(); return json(res, 200, r); }
      if (req.method === 'GET' && url.pathname === '/api/log.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="mtrt-log.json"' });
        return res.end(JSON.stringify(engine.log, null, 1));
      }
      if (req.method === 'GET' && url.pathname === '/api/log.csv') {
        const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
        const rows = [CSV_COLS.join(','), ...engine.log.map((e) => CSV_COLS.map((c) => q(c === 't' ? new Date(e.t).toISOString() : e[c])).join(','))];
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="mtrt-log.csv"' });
        return res.end(rows.join('\n'));
      }
      if (req.method === 'GET') {
        const file = path.join(PUB, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
        if (file.startsWith(PUB) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
          return fs.createReadStream(file).pipe(res);
        }
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      json(res, 400, { error: e.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
