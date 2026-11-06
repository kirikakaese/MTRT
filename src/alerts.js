// Alerts: loud sound, desktop notification, speech, ntfy push.
import { spawn } from 'node:child_process';

const run = (cmd, args) => new Promise((res) => {
  try { const p = spawn(cmd, args, { stdio: 'ignore' }); p.on('exit', res); p.on('error', res); } catch { res(); }
});
const osa = (script) => run('osascript', ['-e', script]);
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export async function sendNtfy(a, { title, message, url, priority = 5, tags = 'rotating_light,ticket' }) {
  if (!a.ntfyTopic) return { ok: false, error: 'no ntfy topic configured' };
  const headers = { Title: title.replace(/[^\x20-\x7e]/g, ''), Priority: String(priority), Tags: tags };
  if (url) headers.Click = url;
  if (a.ntfyToken) headers.Authorization = `Bearer ${a.ntfyToken}`;
  try {
    const res = await fetch(`${a.ntfyServer.replace(/\/$/, '')}/${encodeURIComponent(a.ntfyTopic)}`, { method: 'POST', body: message, headers, signal: AbortSignal.timeout(8000) });
    return { ok: res.ok, status: res.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function localAlert(a, { title, message }) {
  const jobs = [];
  if (process.platform === 'darwin') {
    if (a.forceVolume != null) await osa(`set volume output volume ${Number(a.forceVolume)}`);
    if (a.notification) jobs.push(osa(`display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`));
    if (a.sound) jobs.push((async () => { for (let i = 0; i < a.soundRepeat; i++) await run('afplay', [a.soundFile]); })());
    if (a.say) jobs.push(run('say', [title]));
  } else if (process.platform === 'linux') {
    if (a.notification) jobs.push(run('notify-send', ['-u', 'critical', title, message]));
    if (a.sound) jobs.push((async () => { for (let i = 0; i < a.soundRepeat; i++) await run('paplay', ['/usr/share/sounds/freedesktop/stereo/complete.oga']); })());
  } else {
    process.stdout.write('\x07');
  }
  return Promise.allSettled(jobs);
}

/** Bring the browser application to the front (page.bringToFront() only switches the tab inside the browser). */
export function activateApp(executablePath, channel) {
  if (process.platform !== 'darwin') return;
  const app = /^(.*?\.app)\//.exec(executablePath || '')?.[1];
  if (app) return run('open', ['-a', app]);
  if (channel === 'chrome') return osa('tell application "Google Chrome" to activate');
  if (channel === 'msedge') return osa('tell application "Microsoft Edge" to activate');
}
