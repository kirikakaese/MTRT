// Clock synchronisation against the ticket server's HTTP `Date` header (1 s resolution),
// refined by bisecting the second boundary, plus an SNTP cross-check.
//
// Each HEAD request gives: the server stamped second S at some local moment x in [t0, t1]
// (t0 = request sent, t1 = response headers received). So offset = server - local lies in
// [S - t1, S + 1000 - t0]. We intersect these intervals, and time each next request so the
// server stamps it right at the predicted second boundary -> every sample halves the
// uncertainty until it is limited by the round-trip time.
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import dgram from 'node:dgram';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Optional HTTPS_PROXY support (CONNECT tunnel) so sync also works behind a corporate proxy. */
function makeAgent(url) {
  const isHttps = url.protocol === 'https:';
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const noProxy = /^(localhost|127\.|\[::1\])/.test(url.hostname);
  if (!isHttps) return new http.Agent({ keepAlive: true, maxSockets: 1 });
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  if (proxy && !noProxy) {
    const p = new URL(proxy);
    agent.createConnection = (opts, cb) => {
      const req = http.request({ host: p.hostname, port: p.port || 80, method: 'CONNECT', path: `${url.hostname}:${url.port || 443}`,
        headers: p.username ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(decodeURIComponent(p.username) + ':' + decodeURIComponent(p.password)).toString('base64') } : {} });
      req.once('connect', (res, socket) => {
        if (res.statusCode !== 200) return cb(new Error(`proxy CONNECT ${res.statusCode}`));
        cb(null, tls.connect({ socket, servername: url.hostname }));
      });
      req.once('error', cb);
      req.end();
    };
  }
  return agent;
}

function headOnce(url, agent) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    const req = mod.request(url, { method: 'HEAD', agent, headers: { 'User-Agent': 'mtrt-clock/1.0', 'Cache-Control': 'no-cache' }, timeout: 8000 }, (res) => {
      const t1 = Date.now();
      res.resume();
      const d = Date.parse(res.headers.date);
      if (!Number.isFinite(d)) return reject(new Error('no Date header'));
      resolve({ t0, t1, server: d, rtt: t1 - t0, status: res.statusCode });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

/**
 * @returns {{offsetMs:number, accuracyMs:number, rttMs:number, samples:number, inconsistent:number, at:number, url:string}}
 */
export async function syncHttp(urlStr, { samples = 12, onProgress } = {}) {
  const url = new URL(urlStr);
  const agent = makeAgent(url);
  try {
    await headOnce(url, agent); // warm up: DNS + TCP + TLS, not measured
    let lo = -Infinity, hi = Infinity, inconsistent = 0;
    const rtts = [];
    const take = async () => {
      const s = await headOnce(url, agent);
      rtts.push(s.rtt);
      const nlo = s.server - s.t1, nhi = s.server + 1000 - s.t0;
      if (Math.max(lo, nlo) > Math.min(hi, nhi)) {
        // Contradiction (load-balanced servers with different clocks, or a clock jump): restart from this sample.
        inconsistent++; lo = nlo; hi = nhi;
      } else { lo = Math.max(lo, nlo); hi = Math.min(hi, nhi); }
      onProgress?.({ lo, hi, rtt: s.rtt });
    };
    await take();
    for (let k = 1; k < samples; k++) {
      const est = (lo + hi) / 2;
      const r = median(rtts);
      // Next server-second boundary at least 300 ms ahead; aim the server-side stamp exactly there.
      const boundary = Math.ceil((Date.now() + est + 300 + r) / 1000) * 1000;
      const sendAt = boundary - est - r / 2;
      const wait = sendAt - Date.now();
      if (wait > 0) await sleep(wait);
      await take();
      if (hi - lo <= Math.max(4, r * 0.6) && k >= 6) break;
    }
    return { offsetMs: Math.round((lo + hi) / 2), accuracyMs: Math.round((hi - lo) / 2), rttMs: Math.round(median(rtts)), samples: rtts.length, inconsistent, at: Date.now(), url: url.origin };
  } finally {
    agent.destroy();
  }
}

/** Minimal SNTP client. Returns {offsetMs, rttMs} with offset = true time - local time. */
export function syncNtp(server = 'time.apple.com', timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const msg = Buffer.alloc(48); msg[0] = 0x1b; // LI=0, VN=3, Mode=3 (client)
    const timer = setTimeout(() => { sock.close(); reject(new Error('NTP timeout (UDP 123 blocked?)')); }, timeoutMs);
    const readTs = (b, o) => (b.readUInt32BE(o) - 2208988800) * 1000 + (b.readUInt32BE(o + 4) * 1000) / 2 ** 32;
    let t1;
    sock.on('message', (b) => {
      const t4 = Date.now();
      clearTimeout(timer); sock.close();
      const t2 = readTs(b, 32), t3 = readTs(b, 40);
      resolve({ offsetMs: Math.round(((t2 - t1) + (t3 - t4)) / 2), rttMs: Math.round((t4 - t1) - (t3 - t2)), server });
    });
    sock.on('error', (e) => { clearTimeout(timer); sock.close(); reject(e); });
    t1 = Date.now();
    sock.send(msg, 123, server, (e) => { if (e) { clearTimeout(timer); sock.close(); reject(e); } });
  });
}

export async function fullSync(cfg, log = () => {}) {
  const syncUrl = cfg.clock.syncUrl || new URL(cfg.url).origin + '/';
  const out = { http: null, ntp: null, httpError: null, ntpError: null };
  const [h, n] = await Promise.allSettled([
    syncHttp(syncUrl, { samples: cfg.clock.samples }),
    cfg.clock.ntpServer ? syncNtp(cfg.clock.ntpServer) : Promise.reject(new Error('disabled')),
  ]);
  if (h.status === 'fulfilled') out.http = h.value; else out.httpError = h.reason.message;
  if (n.status === 'fulfilled') out.ntp = n.value; else out.ntpError = n.reason.message;
  log(out);
  return out;
}
