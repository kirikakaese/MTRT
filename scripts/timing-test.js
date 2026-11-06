#!/usr/bin/env node
// Timing accuracy test against the local fake sale page.
//
//   node scripts/timing-test.js [--tabs 4] [--lead 25] [--skew-ms 1337] [--latency-ms 15] [--minimize] [--queue] [--rate-limit 0]
//
// 1. Starts the fake server with a skewed clock (so clock sync has something to find).
// 2. Arms the real engine (same code path as the control panel), tab 1 in front, others in the background
//    (with --minimize the whole window is minimised).
// 3. The fake page opens at T; MTRT must detect it, stop all tabs and raise the alert.
// 4. Reports: clock-sync error, per-tab dispatch error (Node), browser request-start error and the
//    server-measured arrival error, foreground vs background, plus whether anything reloaded after the trigger.
import { startFakeServer } from '../fake/server.js';
import { resolveConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';

const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? (a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true) : d; };
const tabs = Number(opt('tabs', 4)), lead = Number(opt('lead', 25)), skew = Number(opt('skew-ms', 1337));
const latency = Number(opt('latency-ms', 15)), minimize = !!opt('minimize', false), queue = !!opt('queue', false);
const neverOpen = !!opt('never-open', false), fastMs = Number(opt('fast-ms', 30000));

const fake = await startFakeServer({ openIn: neverOpen ? 1e6 : lead, skewMs: skew, latencyMs: latency, queue, rateLimit: Number(opt('rate-limit', 0)), overloadMs: Number(opt('overload-ms', 0)) });
const target = neverOpen ? Date.now() + skew + lead * 1000 : fake.openAt;
const cfg = resolveConfig('test', {
  url: fake.url, targetTime: new Date(target).toISOString(), tabs, testHeaders: true,
  rampAfterMs: fastMs, slowDurationMs: neverOpen ? 0 : 60000, idleIntervalMs: 10000,
  alerts: { sound: false, say: false, notification: false, ntfyTopic: '' }, keepAwake: false,
  clock: { ntpServer: '' },
});
console.log(`fake server ${fake.url}; opens at server time ${new Date(fake.openAt).toISOString()} (clock skew ${skew} ms, latency ${latency} ms)`);

const engine = new Engine(cfg);
engine.on('info', (m) => console.log('  [engine]', m));
let alertAt = null;
engine.on('alert', (x) => { alertAt = Date.now(); console.log(`  [ALERT] ${x.title} – ${x.message}`); });

await engine.ensureBrowser();
await engine.tabs[0].page.bringToFront();
if (minimize) {
  const cdp = await engine.context.newCDPSession(engine.tabs[0].page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  const st = await cdp.send('Browser.getWindowBounds', { windowId });
  console.log('  window state:', st.bounds.windowState);
  await new Promise((r) => setTimeout(r, 500));
}
const vis = await Promise.all(engine.tabs.map((t) => t.page.evaluate(() => document.visibilityState).catch(() => '?')));
console.log('  tab visibility:', vis.map((v, i) => `tab${i + 1}=${v}`).join(' '));

await engine.arm();
const until = neverOpen ? target - skew + fastMs + 3000 : fake.openAt - skew + 30000;
while (Date.now() < until && engine.state === 'armed') await new Promise((r) => setTimeout(r, 200));
await new Promise((r) => setTimeout(r, 1500));
const vis2 = await Promise.all(engine.tabs.map((t) => t.page.evaluate(() => document.visibilityState).catch(() => '?')));

// ---------------- report ----------------
const reloads = engine.log.filter((e) => e.seq);
const arrivals = new Map();
for (const r of fake.stats().arrivals) if (!arrivals.has(r.seq)) arrivals.set(r.seq, r);
const pct = (xs, p) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const summ = (xs) => xs.length ? `n=${String(xs.length).padStart(3)}  mean ${(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(1).padStart(6)}  p50 ${String(pct(xs, 0.5)).padStart(4)}  p95 ${String(pct(xs, 0.95)).padStart(4)}  max|.| ${String(Math.max(...xs.map(Math.abs))).padStart(4)}` : 'n=0';
const scheduled = reloads.filter((e) => e.phase !== 'initial');
const row = (label, list) => {
  const d = list.map((e) => e.dispatchErrMs);
  const s = list.filter((e) => e.startErrMs != null).map((e) => e.startErrMs);
  const ar = list.map((e) => arrivals.get(e.seq)).filter(Boolean).map((r) => Math.round(r.serverArrival - r.slot));
  console.log(`  ${label}`);
  console.log(`     Node dispatch error (ms)      ${summ(d)}`);
  console.log(`     browser request start (ms)    ${summ(s)}`);
  console.log(`     server-side arrival (ms)      ${summ(ar)}   (arrival − planned slot)`);
};
console.log('\n================ MTRT timing report ================');
const h = engine.clock?.http;
console.log(`clock sync: measured ${h?.offsetMs} ms ± ${h?.accuracyMs} (true skew ${skew} ms) -> error ${h ? h.offsetMs - skew : '?'} ms, RTT ${h?.rttMs} ms`);
console.log(`window ${minimize ? 'MINIMISED' : 'normal'}; visibility at start: ${vis.join(',')}; at end: ${vis2.join(',')}`);
row('ALL tabs', scheduled);
row('tab 1 (foreground)', scheduled.filter((e) => e.tab === 0));
row('tabs 2..n (background)', scheduled.filter((e) => e.tab > 0));
for (const ph of ['idle', 'fast', 'slow']) { const l = scheduled.filter((e) => e.phase === ph); if (l.length) row(`phase ${ph}`, l); }

if (!neverOpen) {
  const firstOpen = reloads.find((e) => ['open', 'queue'].includes(e.result));
  const firstHit = fake.stats().arrivals.filter((r) => r.serverArrival >= fake.openAt).sort((x, y) => x.arrival - y.arrival)[0];
  console.log(`\nsale opened (server) ${new Date(fake.openAt).toISOString()}`);
  if (firstHit) console.log(`first request after opening arrived ${Math.round(firstHit.serverArrival - fake.openAt)} ms after T (tab ${firstHit.tab + 1})`);
  if (firstOpen) console.log(`detected "${firstOpen.result}" in tab ${firstOpen.tab + 1}; alert raised ${alertAt ? alertAt - (fake.openAt - skew) : '?'} ms after T (local)`);
  const trig = engine.log.find((e) => e.kind === 'alert');
  const after = trig ? reloads.filter((e) => e.dispatch > trig.t) : [];
  const lastArrival = Math.max(...fake.stats().arrivals.map((r) => r.arrival));
  console.log(`reloads dispatched after the trigger: ${after.length}  (last request reached server ${trig ? lastArrival - trig.t : '?'} ms relative to trigger)`);
  console.log(`engine state: ${engine.state} (${engine.reason}); tab states: ${engine.tabs.map((t) => t.status).join(', ')}`);
}
const bo = engine.log.filter((e) => e.kind === 'backoff');
if (bo.length) console.log(`backoffs: ${bo.length} (${bo.map((b) => `tab${b.tab + 1}:${b.waitMs}ms`).join(' ')})`);
console.log('====================================================\n');
await engine.close();
await fake.close();
process.exit(0);
