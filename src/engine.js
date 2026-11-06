// The reload engine: owns the Playwright browser, schedules staggered reloads against the
// server-corrected clock, classifies every page load, backs off per tab and stops everything
// the moment a tab reaches the shop, a queue, a captcha or an unexpected page.
//
// Timing lives in Node, not in the page, so background / minimised tabs are not throttled.
// Navigations are issued over CDP; Chromium is launched with background throttling disabled.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from './config.js';
import { fullSync } from './clock.js';
import { buildRules, pageProbe } from './detect.js';
import { localAlert, sendNtfy, activateApp } from './alerts.js';
import { keepAwake, isAwakeHeld } from './awake.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const immediate = () => new Promise((r) => setImmediate(r));
const TRIGGERS = new Set(['open', 'queue', 'captcha', 'changed']);

export class Engine extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.context = null;
    this.tabs = [];
    this.state = 'idle';           // idle | armed | stopped | triggered
    this.reason = '';
    this.runId = 0;
    this.offset = 0;               // server - local (ms)
    this.clock = null;             // last sync result
    this.log = [];
    this.seq = 0;
    this.baseline = new Set();     // fingerprints of "closed" pages
    this.trigger = null;           // {tab, kind, url, at}
    this.browserLag = 0;           // EWMA of (browser request start - dispatch), ms
    this.executablePath = '';
    this.logFile = null;
  }

  // ---- time -------------------------------------------------------------------------
  serverNow() { return Date.now() + this.offset; }
  target() { return Date.parse(this.cfg.targetTime); }
  /** Aim at least the clock uncertainty after T, so even the first tab cannot arrive a hair too early. */
  effectiveBias() {
    return Math.max(this.cfg.arrivalBiasMs, Math.min(250, this.clock?.http?.accuracyMs ?? 0));
  }

  /** How early to dispatch so the request *arrives* on the slot: one-way network latency (RTT/2 from clock sync)
   *  + the browser's own dispatch lag (CDP call -> request start), learned as a moving average. */
  latencyComp() {
    if (!this.cfg.latencyCompensation) return 0;
    const net = this.clock?.http ? this.clock.http.rttMs / 2 : 0;
    return Math.round(Math.min(400, net + this.browserLag));
  }

  syncClock() {
    if (!this._syncing) this._syncing = this._syncClock().finally(() => { this._syncing = null; });
    return this._syncing;
  }

  async _syncClock() {
    this.emit('info', 'Syncing clock…');
    const res = await fullSync(this.cfg);
    if (res.http) { this.offset = res.http.offsetMs; }
    this.clock = { ...res, appliedOffsetMs: this.offset, at: Date.now() };
    this.emit('info', res.http
      ? `Clock: server is ${fmtSigned(res.http.offsetMs)} ms vs this Mac (±${res.http.accuracyMs} ms, RTT ${res.http.rttMs} ms)` + (res.ntp ? `, NTP says Mac is ${fmtSigned(-res.ntp.offsetMs)} ms off` : '')
      : `Clock sync FAILED (${res.httpError}); using local clock` + (res.ntp ? ` (NTP: Mac off by ${fmtSigned(-res.ntp.offsetMs)} ms)` : ''));
    this.emit('change');
    return this.clock;
  }

  // ---- browser ------------------------------------------------------------------------
  async ensureBrowser() {
    if (this.context) {
      try { this.context.pages(); } catch { this.context = null; }
    }
    if (!this.context) {
      const b = this.cfg.browser;
      const opts = {
        headless: false,
        viewport: null,
        args: [
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion,HighEfficiencyModeAvailable,BatterySaverModeAvailable',
          '--no-first-run', '--no-default-browser-check',
          ...(b.extraArgs || []),
        ],
      };
      if (b.channel) opts.channel = b.channel;
      if (b.executablePath) opts.executablePath = b.executablePath;
      const dir = path.resolve(ROOT, b.profileDir || '.profile');
      this.context = await chromium.launchPersistentContext(dir, opts);
      this.executablePath = b.executablePath || (b.channel ? '' : chromium.executablePath());
      this.context.on('close', () => { this.context = null; this.tabs = []; if (this.state === 'armed') this.stop('browser closed'); this.emit('change'); });
      this.tabs = [];
    }
    // Reconcile tab count.
    this.tabs = this.tabs.filter((t) => !t.page.isClosed());
    const pages = this.context.pages().filter((p) => !p.isClosed());
    while (this.tabs.length < this.cfg.tabs) {
      const unused = pages.find((p) => !this.tabs.some((t) => t.page === p));
      const page = unused || await this.context.newPage();
      this.tabs.push(this.makeTab(page));
    }
    while (this.tabs.length > this.cfg.tabs) {
      const t = this.tabs.pop();
      await t.page.close().catch(() => {});
    }
    this.tabs.forEach((t, i) => { t.i = i; });
    return this.context;
  }

  makeTab(page) {
    const tab = {
      i: 0, page, status: 'new', ourNav: false, navEndedAt: 0, active: false,
      lastAt: null, lastStatus: null, lastMs: null, lastResult: '', lastErrMs: null, nextAt: null,
      reloads: 0, errors: 0, failStreak: 0, backoffUntil: 0, url: '', title: '',
    };
    page.on('close', () => { tab.status = 'closed'; tab.active = false; this.emit('change'); });
    // Pages you navigate yourself (or that redirect on their own) are inspected too.
    page.on('domcontentloaded', () => this.onForeignLoad(tab).catch(() => {}));
    return tab;
  }

  async onForeignLoad(tab) {
    if (tab.ourNav || this.state !== 'armed' || !tab.active) return;
    const det = await this.probe(tab.page);
    const kind = det && (det.queue ? 'queue' : det.captcha ? 'captcha' : det.open ? 'open' : null);
    this.addLog({ tab: tab.i, kind: 'foreign-load', url: det?.url, result: kind || 'navigated' });
    if (kind) return this.fire(tab, kind, det.url);
    if (Date.now() - tab.navEndedAt > 3000) {
      // Not a redirect of our own reload: you clicked/typed something. Never reload under your hands.
      if (this.cfg.onManualNavigation === 'pause-tab') { tab.active = false; tab.status = 'manual'; this.emit('change'); }
      else this.stop(`manual navigation in tab ${tab.i + 1}`);
    }
  }

  async probe(page) {
    try {
      return await Promise.race([
        page.evaluate(pageProbe, buildRules(this.cfg.detection)),
        sleep(3000).then(() => null),
      ]);
    } catch { return null; }
  }

  /** Open the browser and load each tab once (no schedule). Lets you check the page / accept cookies. */
  async prepare() {
    await this.ensureBrowser();
    await Promise.all(this.tabs.map(async (t, i) => {
      await sleep(i * 400);
      t.ourNav = true;
      try { await t.page.goto(this.cfg.url, { waitUntil: 'domcontentloaded', timeout: this.cfg.navTimeoutMs }); } catch {}
      t.ourNav = false; t.navEndedAt = Date.now(); t.status = 'ready';
    }));
    this.emit('change');
  }

  // ---- arming ---------------------------------------------------------------------------
  async arm(cfg) {
    if (cfg) this.cfg = cfg;
    if (this.state === 'armed') this.stop('re-arm');
    const runId = ++this.runId;
    this.state = 'armed'; this.reason = ''; this.trigger = null;
    this.openLogFile();
    this.addLog({ kind: 'arm', target: this.cfg.targetTime, url: this.cfg.url, tabs: this.cfg.tabs, preset: this.cfg.name });
    this.emit('change');
    try {
      await this.ensureBrowser();
      if (!this.clock?.at || Date.now() - this.clock.at > 120000) await this.syncClock().catch((e) => this.emit('info', 'Clock sync error: ' + e.message));
    } catch (e) {
      this.state = 'stopped'; this.reason = 'browser failed: ' + e.message; this.emit('change'); throw e;
    }
    if (runId !== this.runId) return;
    if (this.cfg.keepAwake) keepAwake(true);
    this.baseline.clear();
    for (const t of this.tabs) {
      t.active = true; t.status = 'waiting'; t.failStreak = 0; t.backoffUntil = 0;
      this.tabLoop(t, runId).catch((e) => { this.addLog({ tab: t.i, kind: 'loop-error', error: e.message }); });
    }
    this.resyncLoop(runId);
    this.emit('change');
  }

  async resyncLoop(runId) {
    const at = this.target() - this.cfg.clock.resyncBeforeMs;
    while (runId === this.runId && this.state === 'armed') {
      const d = at - this.serverNow();
      if (d <= 0) break;
      await sleep(Math.min(d, 1000));
    }
    if (runId === this.runId && this.state === 'armed' && this.serverNow() < this.target() - 20000) {
      await this.syncClock().catch(() => {});
    }
  }

  stop(reason = 'stopped by user', { panic = false } = {}) {
    if (this.state === 'armed' || panic) {
      this.runId++;
      if (this.state !== 'triggered') { this.state = 'stopped'; this.reason = reason; }
    }
    for (const t of this.tabs) {
      if (t.active) { t.active = false; if (!TRIGGERS.has(t.status)) t.status = 'stopped'; }
      t.nextAt = null;
    }
    if (panic) {
      // Cancel loads that are still in flight (does not navigate anywhere).
      for (const t of this.tabs) {
        if (t.ourNav && !t.page.isClosed()) t.page.evaluate(() => window.stop()).catch(() => {});
      }
    }
    keepAwake(false);
    this.addLog({ kind: panic ? 'panic' : 'stop', reason });
    this.emit('change');
  }

  // ---- scheduling ---------------------------------------------------------------------
  tabOffset(i) {
    const o = this.cfg.tabOffsets?.[i];
    return Number.isFinite(Number(o)) && o !== null && o !== '' ? Number(o) : i * this.cfg.offsetMs;
  }

  /** First planned slot (server time, i.e. intended *arrival* time) >= t for tab i, or null when done. */
  nextSlot(i, t) {
    const c = this.cfg, T = this.target();
    const phi = T + this.tabOffset(i) + this.effectiveBias();
    const rampStart = T - c.rampLeadMs, rampEnd = T + c.rampAfterMs, slowEnd = rampEnd + c.slowDurationMs;
    const grid = (from, iv, end) => {
      const s = phi + Math.ceil((from - phi) / iv) * iv;
      return s < end ? s : null;
    };
    const cands = [];
    if (c.idleIntervalMs && t < rampStart) cands.push(grid(t, c.idleIntervalMs, rampStart - 5000));
    const warm = T - c.warmupLeadMs + this.tabOffset(i);
    if (c.warmupLeadMs > c.rampLeadMs && warm >= t && warm < rampStart) cands.push(warm);
    if (t < rampEnd) cands.push(grid(Math.max(t, rampStart), c.fastIntervalMs, rampEnd));
    if (t < slowEnd) cands.push(grid(Math.max(t, rampEnd), c.slowIntervalMs, slowEnd));
    const v = cands.filter((x) => x != null && x >= t);
    return v.length ? Math.min(...v) : null;
  }

  async tabLoop(tab, runId) {
    const alive = () => runId === this.runId && tab.active && !tab.page.isClosed();
    // Immediate first load (staggered) to learn what the closed page looks like.
    const T = this.target();
    if (this.serverNow() < T - this.cfg.rampLeadMs - 8000) {
      const first = this.serverNow() + 300 + tab.i * 600;
      tab.nextAt = first;
      if (!(await this.waitUntil(first, alive))) return;
      await this.reload(tab, first, runId, 'initial');
    }
    while (alive()) {
      const comp = this.latencyComp();
      const from = Math.max(this.serverNow() + comp + 5, tab.backoffUntil);
      const slot = this.nextSlot(tab.i, from);
      if (slot == null) { tab.status = 'done'; tab.active = false; this.emit('change'); this.checkAllDone(); return; }
      tab.nextAt = slot;
      if (tab.status !== 'backoff') tab.status = 'waiting';
      this.emit('change');
      if (!(await this.waitUntil(slot - comp, alive))) return;
      await this.reload(tab, slot, runId, this.phaseOf(slot));
    }
  }

  phaseOf(slot) {
    const T = this.target();
    if (slot < T - this.cfg.rampLeadMs) return slot >= T - this.cfg.warmupLeadMs - 1000 ? 'warmup' : 'idle';
    if (slot < T + this.cfg.rampAfterMs) return 'fast';
    return 'slow';
  }

  checkAllDone() {
    if (this.state === 'armed' && this.tabs.every((t) => !t.active)) this.stop('schedule finished');
  }

  /** Waits until serverNow() >= t. Coarse setTimeout, then a short setImmediate spin for ~1 ms precision. */
  async waitUntil(t, alive) {
    for (;;) {
      if (!alive()) return false;
      const d = t - this.serverNow();
      if (d <= 0) return true;
      if (d > 25) await sleep(Math.min(d - 18, 250));
      else await immediate();
    }
  }

  // ---- one reload ------------------------------------------------------------------------
  async reload(tab, slot, runId, phase) {
    const { page } = tab;
    const comp = this.latencyComp();
    const seq = ++this.seq;
    const plannedDispatch = slot - comp - this.offset;   // local wall-clock ms
    tab.ourNav = true; tab.status = 'loading'; tab.reloads++;
    this.emit('change');
    if (this.cfg.testHeaders) await page.setExtraHTTPHeaders({ 'X-MTRT-Seq': String(seq), 'X-MTRT-Tab': String(tab.i), 'X-MTRT-Slot': String(slot) }).catch(() => {});
    const dispatch = Date.now();
    let resp = null, err = null;
    try {
      resp = await page.goto(this.cfg.url, { waitUntil: 'domcontentloaded', timeout: this.cfg.navTimeoutMs });
    } catch (e) { err = e; }
    const done = Date.now();
    let status = null, retryAfter = null, ttfb = null, browserStart = null;
    if (resp) {
      status = resp.status();
      const ra = resp.headers()['retry-after'];
      if (ra) retryAfter = /^\d+$/.test(ra.trim()) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - this.serverNow());
      try { const tm = resp.request().timing(); browserStart = tm.startTime; if (tm.responseStart >= 0) ttfb = Math.round(tm.responseStart); } catch {}
    }
    if (browserStart) {
      const lag = Math.max(0, Math.min(150, browserStart - dispatch));
      this.browserLag = this.browserLag ? this.browserLag * 0.8 + lag * 0.2 : lag;
    }
    const det = err ? null : await this.probe(page);
    tab.ourNav = false; tab.navEndedAt = Date.now();

    let result;
    if (det?.queue) result = 'queue';
    else if (det?.captcha) result = 'captcha';
    else if (det?.open) result = 'open';
    else if (err) result = /timeout/i.test(err.message) ? 'timeout' : 'error';
    else if (status === 429 || status >= 500) result = 'overload';
    else if (status >= 400) result = 'http-error';
    else if (det?.closed) { result = 'closed'; this.baseline.add(det.fp); }
    else if (det && (this.baseline.has(det.fp) || phase === 'idle' || phase === 'warmup' || phase === 'initial' || this.baseline.size === 0)) { result = 'closed'; this.baseline.add(det.fp); }
    else if (det && this.cfg.detection.stopOnUnknownChange) result = 'changed';
    else result = 'closed';

    const entry = {
      seq, tab: tab.i, phase, slot, plannedDispatch, dispatch, browserStart,
      dispatchErrMs: dispatch - plannedDispatch,
      startErrMs: browserStart ? Math.round(browserStart - plannedDispatch) : null,
      status, ttfbMs: ttfb, totalMs: done - dispatch, result, retryAfterMs: retryAfter,
      url: det?.url || page.url(), error: err ? err.message.split('\n')[0].slice(0, 160) : undefined,
    };
    this.addLog(entry);
    Object.assign(tab, { lastAt: dispatch, lastStatus: status, lastMs: done - dispatch, lastResult: result, lastErrMs: entry.dispatchErrMs, url: entry.url, title: det?.title || '' });

    if (runId !== this.runId) return;   // stopped meanwhile: no further action
    if (TRIGGERS.has(result)) return this.fire(tab, result, entry.url);
    if (['overload', 'timeout', 'error', 'http-error'].includes(result)) {
      tab.errors++; tab.failStreak++;
      const b = this.cfg.backoff;
      let wait = Math.min(b.maxMs, b.baseMs * 2 ** (tab.failStreak - 1));
      if (retryAfter != null) wait = Math.max(wait, Math.min(retryAfter, b.maxRetryAfterMs));
      wait = Math.round(wait * (1 + Math.random() * 0.2)); // jitter only ever extends (never undercut Retry-After)
      tab.backoffUntil = this.serverNow() + wait;
      tab.status = 'backoff';
      this.addLog({ tab: tab.i, kind: 'backoff', waitMs: wait, streak: tab.failStreak });
    } else {
      tab.failStreak = 0; tab.status = 'waiting';
    }
    this.emit('change');
  }

  // ---- success / queue / attention -----------------------------------------------------------
  async fire(tab, kind, url) {
    if (this.state !== 'armed') return;
    this.stop(`${kind} in tab ${tab.i + 1}`);
    this.state = 'triggered';
    tab.status = kind;
    this.trigger = { tab: tab.i, kind, url, at: Date.now() };
    this.emit('change');
    try { await tab.page.bringToFront(); } catch {}
    activateApp(this.executablePath, this.cfg.browser.channel);
    const titles = {
      open: '40C3 SHOP IS OPEN – go!',
      queue: 'You are in the queue – do not reload',
      captcha: 'CAPTCHA – solve it now',
      changed: 'Ticket page changed – check now',
    };
    const title = titles[kind];
    const message = `Tab ${tab.i + 1}: ${url}`;
    this.emit('alert', { kind, title, message, tab: tab.i, url });
    this.addLog({ kind: 'alert', what: kind, tab: tab.i, url });
    const [n] = await Promise.all([sendNtfy(this.cfg.alerts, { title, message, url }), localAlert(this.cfg.alerts, { title, message })]);
    this.addLog({ kind: 'ntfy', ...n });
    this.emit('change');
  }

  async testAlert() {
    const title = 'MTRT test alert', message = 'If you can read/hear this, alerts work.';
    this.emit('alert', { kind: 'test', title, message });
    const [n] = await Promise.all([sendNtfy(this.cfg.alerts, { title, message, priority: 3, tags: 'bell' }), localAlert(this.cfg.alerts, { title, message })]);
    return n;
  }

  // ---- log -------------------------------------------------------------------------------------
  openLogFile() {
    const dir = path.join(ROOT, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.logFile = path.join(dir, `${stamp}-${String(this.cfg.name || 'run').replace(/[^\w-]+/g, '_')}.jsonl`);
  }

  addLog(e) {
    const entry = { t: Date.now(), ...e };
    this.log.push(entry);
    if (this.log.length > 50000) this.log.splice(0, 10000);
    if (this.logFile) fs.appendFile(this.logFile, JSON.stringify(entry) + '\n', () => {});
    this.emit('log', entry);
  }

  snapshot() {
    return {
      state: this.state, reason: this.reason, trigger: this.trigger,
      cfg: this.cfg, now: Date.now(), offset: this.offset, latencyComp: this.latencyComp(),
      clock: this.clock, target: this.target(), biasMs: this.effectiveBias(), browserOpen: !!this.context, keepAwake: isAwakeHeld(),
      baselineSize: this.baseline.size,
      tabs: this.tabs.map((t) => ({
        i: t.i, status: t.status, active: t.active, lastAt: t.lastAt, lastStatus: t.lastStatus, lastMs: t.lastMs,
        lastResult: t.lastResult, lastErrMs: t.lastErrMs, nextAt: t.nextAt, reloads: t.reloads, errors: t.errors,
        backoffUntil: t.backoffUntil, url: t.url, title: t.title, offsetMs: this.tabOffset(t.i),
      })),
    };
  }

  async close() {
    this.stop('shutdown');
    keepAwake(false);
    await this.context?.close().catch(() => {});
  }
}

const fmtSigned = (n) => (n >= 0 ? '+' : '') + n;
