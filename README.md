# MTRT – managed tab reloader

MTRT reloads a ticket shop in several browser tabs on a precise, staggered schedule. It schedules against the **ticket server's clock**, not your Mac's. The moment one tab reaches the shop, the queue, a captcha or an unexpected page, MTRT:

- stops all reloading,
- brings that tab to the front,
- plays a loud sound and shows a macOS notification,
- sends a push to your iPhone via ntfy.

Made for the **40C3 public presale**. Round 1 is **Sun 2026-11-08 11:00 CET**. See [docs/40C3-presale.md](docs/40C3-presale.md) for what I found and what to prepare.

> MTRT only reloads and alerts. It never fills forms, never clicks "add to cart", never touches captchas or the queue. You do the checkout yourself.

## Why this architecture

**Node.js + Playwright, driving its own headed Chromium window with N tabs.**

- **Timing runs in Node, not in the page.** Each reload is sent to the browser over the DevTools protocol (`page.goto`) by a scheduler that sleeps coarsely and then spins for the last ~20 ms. Browser timer throttling in background or minimised tabs does not apply. Playwright also emulates focus, so every tab stays "visible" to the page. On top of that, Chromium is started with `--disable-background-timer-throttling`, `--disable-renderer-backgrounding` and `--disable-backgrounding-occluded-windows`.
- **Not an extension:** `chrome.alarms` has a minimum period (30 s in current Chrome), and timers in background tabs or service workers get throttled. Neither works for sub-second staggering.
- **You check out in the same window.** It is a normal Chromium window with a persistent profile (`.profile/`).

**One shared session (one profile, tabs in one context).** The shop's front end puts a queue cookie (`__QXSESSION`) on the first request. A queue position and a pretix cart both live in cookies. With one shared session:

- the first tab to get through the gate gets *your* queue spot;
- MTRT then stops everything;
- whichever tab you check out in, the cart is the same.

Separate contexts would mean several parallel queue identities. That is unfair, and it is not what the organisers ask for. It also gains nothing here: all tabs stop the moment any of them is in.

## Install (macOS)

1. Install Node.js 20 or newer: `brew install node`, or the installer from nodejs.org.
2. Install MTRT:
   ```bash
   git clone https://github.com/kirikakaese/mtrt.git && cd mtrt
   git checkout claude/mtrt-v1
   npm install          # also downloads Playwright's Chromium (~150 MB)
   ```
3. To use your installed Google Chrome instead of the bundled Chromium, set `"browser": { "channel": "chrome" }` in `config.local.json`.

## Setup

### 1. ntfy push to your iPhone
1. Install the **ntfy** app on the iPhone.
2. Subscribe to a long, random topic, e.g. `mtrt-7f3k9q2xv8`. Anyone who knows the topic can read it.
3. Allow notifications. For Focus modes, allow ntfy under "Time Sensitive".
4. On the Mac, run `cp config.local.example.json config.local.json` and put the topic in it:
   ```json
   { "alerts": { "ntfyTopic": "mtrt-7f3k9q2xv8" } }
   ```
   `config.local.json` is git-ignored and merged into every preset.
5. Start MTRT and press **Test alerts**. You should get a push, a sound and a notification.

   macOS asks once to allow notifications from "Script Editor"/osascript. Allow it.

### 2. Presets
- `presets/round-1.json`, `round-2.json` and `round-3.json` hold the three public sale dates. `presets/test.json` is for the fake page.
- A preset stores only what differs from the defaults in `src/config.js`. ntfy secrets are never stored in a preset.
- In the control panel: **Load** a preset, change fields, **Save as preset**.
- From the CLI: `node src/cli.js --preset round-2`.

### 3. Defaults and what they mean

| Setting | Default | Meaning |
|---|---|---|
| `tabs` | 4 | number of tabs |
| `offsetMs` | 250 | tab *i* fires at T + i×250 ms (`tabOffsets` overrides per tab) |
| `idleIntervalMs` | 120 000 | slow keep-alive reload long before T |
| `warmupLeadMs` | 15 000 | one warm-up reload per tab at T−15 s (fresh TLS connection, fresh page fingerprint) |
| `rampLeadMs` / `rampAfterMs` | 3 000 / 30 000 | fast phase from T−3 s to T+30 s |
| `fastIntervalMs` | 2 000 | per tab, so 4 tabs give one request every 500 ms, aligned on T |
| `slowIntervalMs` / `slowDurationMs` | 10 000 / 15 min | after the fast phase, then MTRT gives up |
| `latencyCompensation` | on | dispatch early by RTT/2 plus measured browser lag, so requests *arrive* on the slot |
| `arrivalBiasMs` | 30 | aim ≥30 ms (or ≥ clock uncertainty) *after* T, never a hair early |
| `backoff` | 4 s → 30 s | per tab, on 429/5xx/timeouts, honours `Retry-After`; other tabs keep going |

There are hard floors (fast ≥ 500 ms, slow ≥ 2 s per tab), so a typo cannot hammer the server.

### 4. Detection

Every page load is classified inside the page. This works in background tabs.

| Result | Default rule | Action |
|---|---|---|
| `queue` | URL `/queue\|waiting…/` or text "waiting room / Warteschlange / estimated wait / your position…" | **stop all**, front, alert. Never reloads a queue page. |
| `captcha` | captcha iframes/widgets, or text "captcha / are you human" | stop all, front, alert |
| `open` | pretix quantity inputs `item_*`/`variation_*` or `#btn-add-to-cart` | stop all, front, alert |
| `closed` | text "Tickets will be sold on… / presale will start…", the intro page, or a page fingerprint already seen before the fast phase | keep reloading |
| `changed` | 2xx page during the fast phase that matches nothing above and differs from every page seen before | stop all and alert. A false alarm costs a click on ARM; a miss costs the ticket. |
| `overload` / `timeout` / `error` | 429, 5xx, network errors | back off **that tab only** |

You can override every rule in the panel or a preset. Use a CSS selector, a substring, or `/regex/i`.

**If you navigate in any tab yourself** (click, type a URL) while armed, MTRT stops all reloading. It never reloads under your hands.

### 5. Clock sync
- MTRT sends HEAD requests to the shop and reads the `Date` header. The header only has 1-second resolution, so MTRT *aims* each request at the server's predicted second boundary and intersects the possible ranges (bisection). Within ~12 requests the offset is known to about ±RTT/2 (typically ±5–20 ms).
- An SNTP query to `time.apple.com` is a cross-check. The panel shows server−Mac, the accuracy, the RTT, Mac vs NTP and server vs NTP.
- Re-sync runs automatically when you arm and again at T−90 s. You can also click **Re-sync clock**.
- Quick check from a terminal: `npm run clock`.

## Sale-day checklist (Round 1: Sun 8 Nov, 11:00 CET)

**Day before**
- [ ] `npm install` works. Run `npm run test-mode` once and watch the full flow.
- [ ] `config.local.json` has your ntfy topic. **Test alerts** works, phone included.
- [ ] Start `npm run round1` and click **Open browser & load tabs once**. All tabs should show `closed`. This also stores the shop's cookies in `.profile/`. Close MTRT afterwards.
- [ ] Prepare ticket type, attendee and invoice data, payment method, and the Friends-ticket text if needed.

**Sale day, from about 10:40**
- [ ] Mac on power, wired network if possible, VPN / iCloud Private Relay off, other big downloads paused.
- [ ] `npm run round1`. The panel opens in your normal browser (Orion is fine for the panel).
- [ ] Check the clock box: offset shown, accuracy ±<50 ms. If it shows a large server−Mac offset, that is fine: MTRT corrects for it.
- [ ] Click **ARM** (by 10:55 at the latest). Tabs load once ("initial"), then idle. You get a warm-up at 10:59:45 and the fast phase from 10:59:57.
- [ ] Leave the Chromium window alone. It may be in the background or minimised. Don't click in its tabs while armed: that counts as "manual navigation" and stops MTRT. Keep your hand near **PANIC STOP** (or press Esc in the panel).
- [ ] **When it fires:** the Chromium window comes to the front on the winning tab. Solve the captcha if there is one, and wait in the queue (30–60 min) **without reloading**. Then check out within the 10-minute cart window.
- [ ] If it fires `changed`, look at the tab. If it's a harmless page, click **Acknowledge** and **ARM** again.
- [ ] After a successful order, pay within 7 days.

## Test mode walkthrough

```bash
npm run test-mode                       # fake page opens 90 s after start
node src/cli.js --fake --open-in 60 --queue          # fake queue after opening
node src/cli.js --fake --rate-limit 2 --overload-ms 5000 --skew-ms 1500   # 429s, 503s, skewed server clock
```

1. The panel opens. The fake page runs at `http://127.0.0.1:4741/40c3/` and imitates the real pretix markup.
2. Click **ARM**, and minimise the Chromium window if you like.
3. Watch the countdown, the warm-up and the fast phase. At T the page "opens": MTRT stops, beeps and comes to the front.
4. Export the log as **CSV/JSON** to look at timing errors.

**Automated timing report** (uses the same engine; clock skew 1337 ms, symmetric 15–30 ms latency):

```bash
npm run timing-test -- --minimize                  # opening scenario
npm run timing-test -- --never-open --fast-ms 60000 --minimize   # many samples, no opening
npm run timing-test -- --queue | --overload-ms 8000 | --rate-limit 2
```

It reports, per foreground and background tab:
- Node dispatch error,
- browser request-start error,
- server-measured arrival error,
- clock-sync error against the true skew,
- whether anything reloaded after the trigger.

### Measured results (Linux/Xvfb + openbox, window minimised; run on your Mac to confirm)

| | n | dispatch error p50 / p95 / max | arrival vs plan p50 / p95 (spread) |
|---|---|---|---|
| foreground tab | 31 | 3 / 5 / 5 ms | −15 / −9 ms |
| background tabs | 93 | 2 / 5 / 12 ms | −16 / −10 ms |

- **Clock sync:** found 1354 ms against a true 1337 ms (±18 reported, RTT 33 ms).
  - The constant ~−16 ms arrival offset is that sync error.
  - It is within the ±RTT/2 limit of `Date`-header syncing.
  - The ≥30 ms arrival bias absorbs it: in the opening test the first request reached the server **15 ms after T**.
- **Detection and stop:** the alert fired 60 ms after T, and **no reload was dispatched after the trigger**.
- **Error scenarios:**
  - 503 storm: only the affected tab backed off, and the next tab got in 250 ms later.
  - 429 + `Retry-After: 5`: only the affected tabs waited ≥5 s.
  - Fake queue: all tabs stopped and the queue page was left alone.

## Control panel

`http://127.0.0.1:4740/`. It is local only and rejects other hosts and cross-site requests. It shows:
- a big countdown in server time, the corrected clock, offset ± accuracy, NTP;
- **ARM / STOP / PANIC STOP**. Panic also cancels in-flight loads. Esc = panic while armed;
- tabs: status, last reload, HTTP status, load time, timing error, next reload, reload and error counts;
- configuration, presets, and the reload log with CSV/JSON export.

Every run also writes `logs/<time>-<preset>.jsonl`.

## Keep-awake

While armed, MTRT runs `caffeinate -dimsu` (on Linux: `systemd-inhibit`) and releases it on stop or trigger. Closing the lid still sleeps most Macs, so keep the lid open.

## Files

```
src/cli.js       entry point (panel server, flags)
src/engine.js    browser, scheduler, classification, backoff, trigger
src/clock.js     HTTP-Date bisection sync + SNTP
src/detect.js    in-page probe
src/alerts.js    sound / notification / say / ntfy / bring-to-front
src/server.js    control panel API + SSE
public/          control panel UI
fake/server.js   fake sale page (test mode)
scripts/timing-test.js  automated timing report
presets/         round-1/2/3, test
```
