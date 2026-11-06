#!/usr/bin/env node
// mtrt – managed tab reloader
//   node src/cli.js [--preset round-1] [--port 4740] [--arm] [--no-open] [--fake] [--clock-only]
import { spawn } from 'node:child_process';
import { resolveConfig } from './config.js';
import { Engine } from './engine.js';
import { startServer } from './server.js';
import { fullSync } from './clock.js';

const args = process.argv.slice(2);
const flag = (k) => args.includes('--' + k);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };

if (flag('help') || flag('h')) {
  console.log(`mtrt – managed tab reloader
  --preset <name>   load presets/<name>.json (default: round-1)
  --port <n>        control panel port (default 4740)
  --arm             arm immediately (no click needed)
  --no-open         do not open the control panel in your default browser
  --fake            test mode: start the local fake sale page (opens in --open-in seconds, default 90)
     --open-in <s> --skew-ms <ms> --queue --rate-limit <n/s> --overload-ms <ms>
  --clock-only      just measure the clock offset to the shop and exit`);
  process.exit(0);
}

const presetName = opt('preset', flag('fake') ? 'test' : 'round-1');
let overrides = {};
let fake = null;
if (flag('fake')) {
  const { startFakeServer } = await import('../fake/server.js');
  fake = await startFakeServer({
    openIn: Number(opt('open-in', 90)), skewMs: Number(opt('skew-ms', 0)), queue: flag('queue'),
    rateLimit: Number(opt('rate-limit', 0)), overloadMs: Number(opt('overload-ms', 0)),
  });
  overrides = { url: fake.url, targetTime: new Date(fake.openAt).toISOString(), testHeaders: true, clock: { ntpServer: '' } };
  console.log(`[test] fake sale page ${fake.url} opens at ${new Date(fake.openAt).toLocaleTimeString()} (server clock)`);
}
if (opt('port')) overrides.port = Number(opt('port'));

const cfg = resolveConfig(presetName, overrides);

if (flag('clock-only')) {
  const r = await fullSync(cfg);
  if (r.http) console.log(`HTTP Date sync vs ${r.http.url}: server - local = ${r.http.offsetMs} ms (±${r.http.accuracyMs} ms, RTT ${r.http.rttMs} ms, ${r.http.samples} samples${r.http.inconsistent ? `, ${r.http.inconsistent} inconsistent` : ''})`);
  else console.log('HTTP sync failed:', r.httpError);
  if (r.ntp) console.log(`NTP ${r.ntp.server}: true - local = ${r.ntp.offsetMs} ms (RTT ${r.ntp.rttMs} ms)`);
  else console.log('NTP failed:', r.ntpError);
  process.exit(0);
}

const engine = new Engine(cfg);
const port = cfg.port;
await startServer(engine, port);
const panel = `http://127.0.0.1:${port}/`;
console.log(`[mtrt] preset "${cfg.name}" · target ${cfg.targetTime} · ${cfg.url}`);
console.log(`[mtrt] control panel: ${panel}`);
if (!flag('no-open')) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, [panel], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
}
engine.on('alert', (a) => console.log(`\n\x07*** ${a.title} *** ${a.message}\n`));
engine.syncClock().catch((e) => console.log('[mtrt] clock sync failed:', e.message));
if (flag('arm')) engine.arm().catch((e) => console.error('[mtrt] arm failed:', e.message));

const shutdown = async () => { console.log('\n[mtrt] shutting down'); await engine.close(); await fake?.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
