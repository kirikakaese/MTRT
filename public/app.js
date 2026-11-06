/* MTRT control panel */
const $ = (s) => document.querySelector(s);
let S = null;            // latest snapshot
let logRows = [];
let formDirty = false;
let audioCtx = null;

const api = (path, body) => fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-MTRT': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; });

const pad = (n, w = 2) => String(n).padStart(w, '0');
const fmtClock = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
const fmtDur = (ms) => {
  const neg = ms < 0; ms = Math.abs(ms);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, ds = Math.floor(ms / 100) % 10;
  const d = Math.floor(h / 24);
  return (neg ? '+' : '') + (d ? `${d}d ` : '') + `${pad(h % 24)}:${pad(m)}:${pad(s)}.${ds}`;
};
const signed = (n) => (n == null ? '–' : (n >= 0 ? '+' : '') + n);
const serverNow = () => (S ? Date.now() + S.offset : Date.now());

// ---------- rendering ----------
function renderTick() {
  if (S) {
    const left = S.target - serverNow();
    $('#countdown').textContent = left >= 0 ? fmtDur(left) : fmtDur(left);
    $('#countdown').classList.toggle('past', left < 0);
    $('#countdown').classList.toggle('soon', left >= 0 && left < 60000);
    $('#serverClock').textContent = fmtClock(serverNow());
    const c = S.cfg;
    let phase = 'idle';
    if (left <= c.rampLeadMs && left > -c.rampAfterMs) phase = 'FAST phase';
    else if (left <= -c.rampAfterMs) phase = left > -(c.rampAfterMs + c.slowDurationMs) ? 'slow phase' : 'schedule over';
    else if (left <= c.warmupLeadMs) phase = 'warm-up';
    $('#phaseLine').textContent = S.state === 'armed' ? phase : '';
    for (const t of S.tabs) {
      const el = document.querySelector(`#tab-next-${t.i}`);
      if (el) el.textContent = t.nextAt && t.active ? (t.nextAt - serverNow() > 0 ? 'in ' + fmtDur(t.nextAt - serverNow()) : 'now') : '–';
    }
  }
  requestAnimationFrame(renderTick);
}

function renderState() {
  const s = S;
  const badge = $('#stateBadge');
  badge.textContent = s.state === 'triggered' ? s.trigger?.kind?.toUpperCase() : s.state;
  badge.className = 'badge ' + s.state;
  document.body.classList.toggle('armed', s.state === 'armed');
  $('#targetLine').textContent = `${s.cfg.name || ''} · T = ${new Date(s.target).toString().slice(0, 33)}`;
  $('#reason').textContent = [s.reason, s.keepAwake ? 'Mac kept awake ☕' : '', s.browserOpen ? 'browser open' : 'browser closed', s.baselineSize ? `${s.baselineSize} closed-page fingerprint(s) learned` : ''].filter(Boolean).join(' · ');
  const h = s.clock?.http;
  $('#offsetLine').innerHTML = h
    ? `server − Mac = <b>${signed(h.offsetMs)} ms</b> ± ${h.accuracyMs} ms · RTT ${h.rttMs} ms · latency comp. ${s.latencyComp} ms · synced ${new Date(h.at).toLocaleTimeString()}`
    : s.clock?.httpError ? `<span class="bad">HTTP sync failed: ${esc(s.clock.httpError)}</span> (using Mac clock)` : 'offset: not synced yet';
  const n = s.clock?.ntp;
  $('#ntpLine').textContent = n ? `NTP ${n.server}: Mac is ${signed(-n.offsetMs)} ms off true time (RTT ${n.rttMs} ms)` + (h ? ` · server clock vs NTP: ${signed(h.offsetMs - n.offsetMs)} ms` : '') : (s.clock?.ntpError ? `NTP: ${s.clock.ntpError}` : '');

  const tb = $('#tabs tbody');
  tb.innerHTML = s.tabs.map((t) => `<tr class="st-${t.status}">
    <td>${t.i + 1}</td><td>+${t.offsetMs} ms</td><td><span class="pill ${t.status}">${t.status}</span>${t.status === 'backoff' ? ` <small>until ${fmtClock(t.backoffUntil)}</small>` : ''}</td>
    <td>${t.lastAt ? fmtClock(t.lastAt) : '–'}</td><td>${t.lastStatus ?? '–'}</td><td>${t.lastMs != null ? t.lastMs + ' ms' : '–'}</td>
    <td>${t.lastErrMs != null ? signed(t.lastErrMs) + ' ms' : '–'}</td><td id="tab-next-${t.i}">–</td><td>${t.reloads} / ${t.errors}</td>
    <td class="url" title="${esc(t.url)}">${esc(t.lastResult || '')} ${esc(t.title || '')}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">Browser not open yet – click ARM or "Open browser".</td></tr>';

  const bn = $('#banner');
  if (s.state === 'triggered' && s.trigger) {
    bn.className = 'banner ' + s.trigger.kind;
    $('#bannerTitle').textContent = { open: 'SHOP IS OPEN – CHECK OUT NOW', queue: 'IN THE QUEUE – DO NOT RELOAD', captcha: 'CAPTCHA – SOLVE IT', changed: 'PAGE CHANGED – LOOK NOW' }[s.trigger.kind];
    $('#bannerMsg').textContent = `Tab ${s.trigger.tab + 1} is in front: ${s.trigger.url}. All reloading stopped.`;
  } else bn.className = 'banner hidden';

  if (!formDirty) fillForm(s.cfg);
}

function esc(x) { return String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

function renderLog() {
  const rows = logRows.slice(-250).reverse();
  $('#log tbody').innerHTML = rows.map((e) => {
    const info = e.kind === 'ntfy' ? (e.ok ? 'ntfy push sent' : `ntfy push NOT sent: ${e.error || e.status}`) : e.kind ? `${e.kind}${e.reason ? ': ' + e.reason : ''}${e.waitMs ? ` ${e.waitMs} ms` : ''}${e.what ? ' ' + e.what : ''}${e.error ? ' ' + e.error : ''}` : (e.error || e.url || '');
    return `<tr class="r-${e.result || e.kind}"><td>${fmtClock(e.t)}</td><td>${e.tab != null ? e.tab + 1 : ''}</td><td>${e.phase || ''}</td><td>${e.result || ''}</td><td>${e.status ?? ''}</td>
      <td>${e.dispatchErrMs != null ? signed(e.dispatchErrMs) : ''}</td><td>${e.totalMs != null ? e.totalMs : ''}</td><td class="url">${esc(info)}</td></tr>`;
  }).join('');
  const r = logRows.filter((e) => e.seq && e.dispatchErrMs != null);
  if (r.length) {
    const errs = r.map((e) => Math.abs(e.dispatchErrMs)).sort((a, b) => a - b);
    const q = (p) => errs[Math.min(errs.length - 1, Math.floor(p * errs.length))];
    $('#stats').textContent = `${r.length} reloads · dispatch timing error |p50| ${q(0.5)} ms, |p95| ${q(0.95)} ms, max ${errs[errs.length - 1]} ms`;
  }
}

// ---------- form ----------
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function fillForm(cfg) {
  for (const el of $('#cfgForm').elements) {
    if (!el.name) continue;
    const v = getPath(cfg, el.name);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.name === 'tabOffsets') el.value = (v || []).join(',');
    else el.value = v ?? '';
  }
}
function readForm() {
  const out = {};
  for (const el of $('#cfgForm').elements) {
    if (!el.name) continue;
    let v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    if (el.name === 'tabOffsets') v = el.value.trim() ? el.value.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)) : [];
    const keys = el.name.split('.');
    let o = out; keys.slice(0, -1).forEach((k) => { o = o[k] ??= {}; });
    o[keys.at(-1)] = v;
  }
  return out;
}
$('#cfgForm').addEventListener('input', () => { formDirty = true; $('#cfgMsg').textContent = 'unsaved changes – Apply or ARM to use them'; });

// ---------- sound in the panel (backup for the system sound) ----------
function beep(times = 6) {
  try {
    audioCtx ??= new AudioContext();
    for (let i = 0; i < times; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'square'; o.frequency.value = i % 2 ? 880 : 1320;
      g.gain.value = 0.3; o.connect(g).connect(audioCtx.destination);
      const t = audioCtx.currentTime + i * 0.35; o.start(t); o.stop(t + 0.25);
    }
  } catch {}
}
document.addEventListener('click', () => { try { audioCtx ??= new AudioContext(); audioCtx.resume(); } catch {} }, { once: true });

// ---------- buttons ----------
const act = (btn, fn) => $(btn).addEventListener('click', async () => {
  try { await fn(); } catch (e) { alert(e.message); }
});
act('#armBtn', async () => { await api('/api/arm', readForm()); formDirty = false; $('#cfgMsg').textContent = ''; });
act('#stopBtn', () => api('/api/stop', {}));
act('#panicBtn', () => api('/api/panic', {}));
act('#ackBtn', () => api('/api/ack', {}));
act('#syncBtn', () => api('/api/sync', {}));
act('#prepareBtn', () => api('/api/prepare', {}));
act('#testAlertBtn', () => api('/api/test-alert', {}).then((r) => { $('#cfgMsg').textContent = r.ok ? 'ntfy push sent' : 'ntfy: ' + (r.error || r.status); }));
act('#applyBtn', async () => { await api('/api/config', readForm()); formDirty = false; $('#cfgMsg').textContent = 'applied'; });
act('#loadPresetBtn', async () => { const cfg = await api('/api/presets/' + encodeURIComponent($('#presetSel').value)); await api('/api/config', cfg); formDirty = false; $('#cfgMsg').textContent = 'preset loaded'; });
act('#savePresetBtn', async () => {
  const name = $('#presetName').value.trim(); if (!name) throw new Error('enter a preset name');
  const r = await api('/api/presets/' + encodeURIComponent(name), readForm()); await loadPresets(); $('#presetSel').value = r.saved; $('#cfgMsg').textContent = 'saved presets/' + r.saved + '.json';
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S?.state === 'armed') api('/api/panic', {}); });

async function loadPresets() {
  const r = await api('/api/presets');
  $('#presetSel').innerHTML = r.presets.map((p) => `<option>${esc(p)}</option>`).join('');
}

// ---------- live updates ----------
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => { S = JSON.parse(e.data); renderState(); });
  es.addEventListener('log', (e) => { logRows.push(...JSON.parse(e.data)); if (logRows.length > 5000) logRows = logRows.slice(-3000); renderLog(); });
  es.addEventListener('alert', (e) => {
    const a = JSON.parse(e.data); beep(a.kind === 'test' ? 2 : 8);
    if (Notification?.permission === 'granted') new Notification(a.title, { body: a.message });
  });
  es.addEventListener('info', (e) => { $('#cfgMsg').textContent = JSON.parse(e.data); });
  es.onerror = () => { $('#stateBadge').textContent = 'disconnected'; $('#stateBadge').className = 'badge stopped'; };
}
if (window.Notification && Notification.permission === 'default') document.addEventListener('click', () => Notification.requestPermission(), { once: true });
loadPresets();
connect();
requestAnimationFrame(renderTick);
