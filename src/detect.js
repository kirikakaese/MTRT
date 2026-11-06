// Page classification. `pageProbe` runs inside the page (via CDP, so it works in background tabs).
import { toRegexSource } from './config.js';

export function buildRules(det) {
  const r = (s) => toRegexSource(s);
  return {
    openSelector: det.openSelector || '', openText: r(det.openText), openUrl: r(det.openUrl),
    queueSelector: det.queueSelector || '', queueText: r(det.queueText), queueUrl: r(det.queueUrl),
    captchaSelector: det.captchaSelector || '', captchaText: r(det.captchaText),
    closedSelector: det.closedSelector || '', closedText: r(det.closedText), closedUrl: r(det.closedUrl),
  };
}

/* eslint-disable no-undef */
export function pageProbe(rules) {
  const text = (document.body ? document.body.innerText : '') || '';
  const url = location.href;
  const re = (x) => (x ? new RegExp(x.source, x.flags) : null);
  const t = (x) => { const e = re(x); return !!(e && e.test(text)); };
  const u = (x) => { const e = re(x); return !!(e && e.test(url)); };
  const q = (s) => { if (!s) return false; try { return !!document.querySelector(s); } catch { return false; } };
  const norm = text.toLowerCase().replace(/[0-9]+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 30000);
  let h = 5381; for (let i = 0; i < norm.length; i++) h = ((h * 33) ^ norm.charCodeAt(i)) >>> 0;
  return {
    url, title: document.title,
    open: q(rules.openSelector) || t(rules.openText) || u(rules.openUrl),
    queue: q(rules.queueSelector) || t(rules.queueText) || u(rules.queueUrl),
    captcha: q(rules.captchaSelector) || t(rules.captchaText),
    closed: q(rules.closedSelector) || t(rules.closedText) || u(rules.closedUrl),
    fp: h.toString(36) + ':' + norm.length,
    snippet: norm.slice(0, 140),
  };
}
/* eslint-enable no-undef */
