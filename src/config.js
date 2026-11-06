// Configuration: defaults, presets and local (private) overrides.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PRESET_DIR = path.join(ROOT, 'presets');
export const LOCAL_FILE = path.join(ROOT, 'config.local.json');

export const DEFAULTS = {
  name: 'Round 1',
  // Page to reload. /40c3/ redirects once to /40c3/intro/ (cookie "intro_seen_40c3"), then shows the shop.
  url: 'https://tickets.events.ccc.de/40c3/',
  // Sale opening time (ISO 8601 with offset). Compared against the *server's* clock.
  targetTime: '2026-11-08T11:00:00+01:00',

  // --- tabs & timing ---------------------------------------------------------
  tabs: 4,
  offsetMs: 250,            // tab i fires at T + i*offsetMs (+ k*interval)
  tabOffsets: [],           // optional per-tab override, e.g. [0, 150, 400, 900] (ms after T)
  idleIntervalMs: 120000,   // reload interval while idle (long before T). 0 = no idle reloads
  warmupLeadMs: 15000,      // one extra "warm-up" reload per tab at T - warmupLeadMs (fresh TLS connection, fresh baseline)
  rampLeadMs: 3000,         // fast phase starts at T - rampLeadMs
  rampAfterMs: 30000,       // ...and lasts until T + rampAfterMs
  fastIntervalMs: 2000,     // per-tab interval during the fast phase
  slowIntervalMs: 10000,    // per-tab interval after the fast phase
  slowDurationMs: 900000,   // how long the slow phase lasts before MTRT gives up (15 min)
  latencyCompensation: true,// dispatch early by ~one-way latency so the request *arrives* on the slot
  arrivalBiasMs: 30,        // aim this many ms *after* the slot (never arrive a hair too early)
  navTimeoutMs: 20000,

  // --- backoff (per tab) -------------------------------------------------------
  backoff: { baseMs: 4000, maxMs: 30000, maxRetryAfterMs: 120000 },

  // --- detection -----------------------------------------------------------------
  // Strings are plain case-insensitive substrings, or regexes written as "/.../flags".
  detection: {
    // Shop is OPEN: pretix renders quantity inputs / an add-to-cart button only when products can be bought.
    openSelector: 'input[name^="item_"]:not([type="hidden"]):not([disabled]), input[name^="variation_"]:not([type="hidden"]):not([disabled]), select[name^="item_"], select[name^="variation_"], #btn-add-to-cart',
    openText: '',
    openUrl: '',
    // QUEUE / waiting room: never reload away from it.
    queueSelector: '',
    queueText: '/waiting room|warteraum|warteschlange|in the queue|in der queue|you are (now )?in line|your position|ihre position|estimated wait|voraussichtliche wartezeit|gesch(ä|ae)tzte wartezeit|queue position/i',
    queueUrl: '/queue|waiting|warteschlange|wartesaal/i',
    // CAPTCHA: a human has to act -> stop and alert.
    captchaSelector: 'iframe[src*="captcha"], iframe[src*="challenges.cloudflare.com"], .h-captcha, .g-recaptcha, .cf-turnstile, .frc-captcha, altcha-widget, [id*="captcha" i], [class*="captcha" i]',
    captchaText: '/captcha|are you (a )?human|verify you are human|bist du ein mensch/i',
    // "Not open yet" markers (seen on the real shop on 2026-11-06: "Tickets will be sold on 2026-11-08 11:00 (CET).")
    closedSelector: '',
    closedUrl: '/\\/intro\\/?(\\?|$)/i',   // pretix intro page (shown once until cookie intro_seen_40c3 is set)
    closedText: '/tickets will be sold on|presale (will )?start|will start soon|starts soon|has not started|not (yet )?open|vorverkauf (beginnt|startet)|tickets werden am|beginnt in k(ü|ue)rze/i',
    // If a page loads with 2xx during the fast phase and matches none of the above AND differs from every page seen
    // before the fast phase, treat it as "changed": stop everything and alert. Safer than missing the opening.
    stopOnUnknownChange: true,
  },
  onManualNavigation: 'stop-all', // a navigation you did yourself in any tab -> stop all reloading ("pause-tab" = only that tab)

  // --- clock -------------------------------------------------------------------------
  clock: {
    syncUrl: '',             // default: origin of `url`
    samples: 12,
    ntpServer: 'time.apple.com',
    resyncBeforeMs: 90000,   // automatic re-sync at T - 90 s while armed
  },

  // --- alerts -------------------------------------------------------------------------
  alerts: {
    ntfyServer: 'https://ntfy.sh',
    ntfyTopic: '',           // put your private topic in config.local.json
    ntfyToken: '',
    sound: true,
    soundFile: '/System/Library/Sounds/Glass.aiff',
    soundRepeat: 6,
    say: true,
    notification: true,
    forceVolume: null,       // e.g. 80 = set macOS output volume to 80% on alert (null = leave alone)
  },

  // --- browser -------------------------------------------------------------------------
  browser: {
    channel: '',             // '' = Playwright's bundled Chromium; 'chrome' = your installed Google Chrome
    executablePath: '',
    profileDir: '.profile',  // persistent profile (cookies survive restarts, e.g. intro_seen_40c3)
    extraArgs: [],
  },
  keepAwake: true,
  port: 4740,
  testHeaders: false,        // adds X-MTRT-Seq header (only used against the local fake server)
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export function deepMerge(base, over) {
  if (!isObj(over)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[config] cannot read ${file}: ${e.message}`);
    return null;
  }
}

export const loadLocal = () => readJson(LOCAL_FILE) || {};

const safeName = (n) => String(n).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'preset';

export function listPresets() {
  try {
    return fs.readdirSync(PRESET_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  } catch { return []; }
}

export function loadPreset(name) {
  const p = readJson(path.join(PRESET_DIR, safeName(name) + '.json'));
  if (!p) throw new Error(`preset "${name}" not found`);
  return p;
}

/** Saves only the values that differ from DEFAULTS (keeps presets small and readable). Never stores ntfy secrets. */
export function savePreset(name, cfg) {
  const diff = diffFrom(DEFAULTS, cfg) || {};
  if (diff.alerts) { delete diff.alerts.ntfyTopic; delete diff.alerts.ntfyToken; if (!Object.keys(diff.alerts).length) delete diff.alerts; }
  fs.mkdirSync(PRESET_DIR, { recursive: true });
  const file = path.join(PRESET_DIR, safeName(name) + '.json');
  fs.writeFileSync(file, JSON.stringify(diff, null, 2) + '\n');
  return safeName(name);
}

function diffFrom(base, cfg) {
  if (!isObj(cfg)) return JSON.stringify(base) === JSON.stringify(cfg) ? undefined : cfg;
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    const d = isObj(v) && isObj(base?.[k]) ? diffFrom(base[k], v) : (JSON.stringify(base?.[k]) === JSON.stringify(v) ? undefined : v);
    if (d !== undefined && !(isObj(d) && !Object.keys(d).length)) out[k] = d;
  }
  return out;
}

/** Effective config = DEFAULTS <- preset <- config.local.json (private: ntfy topic etc.) <- explicit overrides */
export function resolveConfig(presetName, overrides) {
  let cfg = structuredClone(DEFAULTS);
  if (presetName) cfg = deepMerge(cfg, loadPreset(presetName));
  cfg = deepMerge(cfg, loadLocal());
  if (overrides) cfg = deepMerge(cfg, overrides);
  return validate(cfg);
}

export function validate(cfg) {
  const t = Date.parse(cfg.targetTime);
  if (!Number.isFinite(t)) throw new Error(`targetTime "${cfg.targetTime}" is not a valid ISO date`);
  try { new URL(cfg.url); } catch { throw new Error(`url "${cfg.url}" is not valid`); }
  cfg.tabs = Math.max(1, Math.min(12, Math.round(Number(cfg.tabs) || 1)));
  for (const k of ['offsetMs', 'idleIntervalMs', 'warmupLeadMs', 'rampLeadMs', 'rampAfterMs', 'slowDurationMs', 'arrivalBiasMs']) {
    cfg[k] = Math.max(0, Number(cfg[k]) || 0);
  }
  // Hard floors so a typo cannot hammer the server.
  cfg.fastIntervalMs = Math.max(500, Number(cfg.fastIntervalMs) || 2000);
  cfg.slowIntervalMs = Math.max(2000, Number(cfg.slowIntervalMs) || 10000);
  if (cfg.idleIntervalMs) cfg.idleIntervalMs = Math.max(10000, cfg.idleIntervalMs);
  cfg.navTimeoutMs = Math.max(2000, Number(cfg.navTimeoutMs) || 20000);
  if (!Array.isArray(cfg.tabOffsets)) cfg.tabOffsets = [];
  return cfg;
}

/** "/re/flags" -> RegExp, plain string -> case-insensitive substring regex, '' -> null */
export function toRegexSource(s) {
  if (!s) return null;
  const m = /^\/(.+)\/([a-z]*)$/s.exec(s);
  if (m) return { source: m[1], flags: m[2].includes('i') ? m[2] : m[2] + 'i' };
  return { source: s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags: 'i' };
}
