/* Two alert sources, kept apart because they are answered differently.

   Bike alerts are derived rather than stored: each one is a function of the
   current state, so it appears when the condition is true and clears itself
   when it stops being true. Nothing to dismiss, nothing to go stale.

   Phone notifications are the opposite. They arrive once, pushed from the
   native shell through window.__nmaxNote, and stay until they are read or
   cleared. They live in memory only — a notification is somebody's private
   message, and writing it to this phone's storage would keep it long after
   the rider stopped caring. */

import { CFG, S, settings, SERVICE_DEFAULTS } from "./state.js";
import * as store from "./store.js";
import * as trips from "./trips.js";
import * as marks from "./marks.js";
import * as speedlimit from "./speedlimit.js";

const MAX_NOTES = 40;
const NOTE_LIFE = 6000;        // ms a banner holds the band before it hands it back

let notes = [];
let banner = null;             // the one currently in the band, if any
let bannerAt = 0;
let onChange = () => {};

export function setOnChange(fn) { onChange = fn; }
function changed() { try { onChange(); } catch (e) { /* a render error is not fatal */ } }

/* ---------------- the bike side ---------------- */

/* Ordered most urgent first, so the block can show list[0] and be right. */
export function bike() {
  const out = [];
  const add = (sev, t, s) => out.push({ sev: sev, t: t, s: s });

  if (S.temp !== null && S.temp >= 110) {
    add("crit", "Engine hot", Math.round(S.temp) + "°C — stop and let it cool");
  }
  if (S.volts !== null && S.volts > 5 && S.volts < 12.2 && S.rpm !== null && S.rpm > 1500) {
    // Running below rest voltage means the charging side is not keeping up.
    add("crit", "Not charging", S.volts.toFixed(1) + " V with the engine running");
  }
  if (S.temp !== null && S.temp < CFG.warmC) {
    add("warn", "Warm-up",
        "Coolant " + Math.round(S.temp) + "°C — revs capped until " + CFG.warmC + "°C");
  }
  const lim = speedlimit.limit();
  if (S.gpsOk && S.speed > lim + 2) {
    const road = speedlimit.roadName();
    add("warn", "Over the limit",
        Math.round(S.speed) + " in a " + lim + " zone" + (road ? " · " + road : ""));
  }
  // Places the rider tagged by hand. Whoever put it there knew why, so it
  // needs no severity of its own beyond being close.
  for (const m of marks.near(400)) {
    add("warn", "Marked spot", m.d + " m away");
  }

  if (S.nearJolt) {
    add("info", "Rough road", Math.round(S.nearJolt.d) + " m ahead, logged on an earlier ride");
  }

  // Service, worst first. Only what is actually close is worth the rider's attention.
  const odo = Math.round(trips.odometer() + (settings.odoOffset || 0));
  const svc = store.get("service", SERVICE_DEFAULTS);
  const due = [];
  for (const item of svc) {
    const left = item.every - Math.max(0, odo - (item.last || 0));
    if (left <= 0) due.push({ sev: "warn", t: item.n + " overdue", s: Math.round(-left) + " km past due", left: left });
    else if (left <= item.every * 0.15) due.push({ sev: "info", t: item.n + " due", s: "in " + Math.round(left) + " km", left: left });
  }
  due.sort((a, b) => a.left - b.left);
  for (const d of due) add(d.sev, d.t, d.s);

  const rank = { crit: 0, warn: 1, info: 2 };
  out.sort((a, b) => rank[a.sev] - rank[b.sev]);
  return out;
}

/* What the block itself says: the worst thing, and how many there are. */
export function summary() {
  const list = bike();
  const urgent = list.filter((a) => a.sev !== "info");
  return {
    sev: list.length === 0 ? "" : list[0].sev,
    text: list.length === 0 ? "All clear" : list[0].t + " · " + list[0].s,
    count: urgent.length
  };
}

/* ---------------- the phone side ---------------- */

export function phone() { return notes; }
export function unread() { return notes.filter((n) => !n.read).length; }

export function clearPhone() {
  notes = [];
  banner = null;
  changed();
}

export function markRead() {
  let any = false;
  for (const n of notes) if (!n.read) { n.read = true; any = true; }
  if (any) changed();
}

/* The banner the band shows, or null once it has had its few seconds.
   Wall-clock on purpose: the render loop is driven by requestAnimationFrame,
   whose timestamp counts from page load, and comparing that against the epoch
   millisecond a notification arrived at makes a banner that never expires. */
export function current() {
  if (!banner) return null;
  if (Date.now() - bannerAt > NOTE_LIFE) { banner = null; return null; }
  return banner;
}

export function dismissBanner() { if (banner) { banner = null; changed(); } }

/* One notification, as the shell posts it. Everything is treated as text from
   somewhere else: it is rendered as textContent, never as markup. */
function push(n) {
  const note = {
    app: String(n.app || "").slice(0, 40),
    pkg: String(n.pkg || "").slice(0, 80),
    title: String(n.title || "").slice(0, 120),
    body: String(n.body || "").replace(/\s+/g, " ").slice(0, 200),
    at: Date.now(),
    read: false
  };
  if (!note.title && !note.body) return;

  // Android reposts a notification on every edit — a chat thread ticking over
  // would otherwise flash the band on each keystroke of the sender's reply.
  const prev = notes[0];
  if (prev && prev.pkg === note.pkg && prev.title === note.title && note.at - prev.at < 4000) {
    prev.body = note.body;
    prev.at = note.at;
    if (banner === prev) bannerAt = note.at;
    changed();
    return;
  }

  notes.unshift(note);
  if (notes.length > MAX_NOTES) notes.length = MAX_NOTES;
  banner = note;
  bannerAt = note.at;
  changed();
}

/* The shell's entry point. Accepts the JSON string it sends, or an object,
   so the same path works when the page is driven from a console for testing. */
window.__nmaxNote = function (payload) {
  try {
    push(typeof payload === "string" ? JSON.parse(payload) : (payload || {}));
  } catch (e) { /* malformed push: drop it rather than break the render loop */ }
};

/* True when the shell is new enough to send notifications at all. */
export const hasShell = () =>
  !!(window.NMAXShell && typeof window.NMAXShell.noteEnabled === "function");

export function listenerOn() {
  try { return hasShell() && window.NMAXShell.noteEnabled(); } catch (e) { return false; }
}

export function openListenerSettings() {
  try { if (hasShell()) window.NMAXShell.noteSettings(); } catch (e) { /* no shell */ }
}

export function fmtAge(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  return Math.round(s / 86400) + "d";
}
