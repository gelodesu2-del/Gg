/* Flooding and road closures, from the companion Worker.

   Deliberately advisory. The app never reroutes on this by itself: an LLM
   reading news for flood locations is right often enough to be worth showing
   and wrong often enough that a silent detour would be the wrong response. So
   a hazard becomes a warning with its source and its age attached, and the
   rider decides.

   Everything degrades to nothing. No URL set, Worker down, no signal — the
   dash carries on without hazards and says nothing about it. */

import { S, settings, save } from "./state.js";
import * as store from "./store.js";

const FRESH_MS = 20 * 60000;       // matches the Worker's own cache window
const RETRY_MS = 3 * 60000;        // after a failure, before trying again
const MOVED_M = 8000;              // far enough that the old answer is the wrong area

let list = [];
let fetchedAt = 0;
let fetchedAt_lat = null, fetchedAt_lng = null;
let failedAt = 0;
let inflight = false;
let lastErr = "";
let onChange = () => {};

export function setOnChange(fn) { onChange = fn; }
export function configured() { return !!settings.hazardUrl; }
export function hazards() { return list; }
export function status() { return lastErr; }
export function checkedAt() { return fetchedAt; }

/* Restored on boot so a cold start still has the last answer to show while
   the fresh one is on its way. Hazards are public advisories, not private
   data, so unlike notifications these are fine to keep. */
try {
  const saved = store.get("hazards", null);
  if (saved && Array.isArray(saved.list) && Date.now() - saved.at < FRESH_MS * 3) {
    list = saved.list;
    fetchedAt = saved.at;
    fetchedAt_lat = saved.lat;
    fetchedAt_lng = saved.lng;
  }
} catch (e) { /* nothing kept */ }

const metres = (aLat, aLng, bLat, bLng) => {
  const dx = (bLng - aLng) * 111320 * Math.cos(aLat * Math.PI / 180);
  const dy = (bLat - aLat) * 110540;
  return Math.sqrt(dx * dx + dy * dy);
};

/* Asks only when there is a reason to: no answer yet, the answer has aged
   out, or the bike has left the area the answer covers. */
export function tick() {
  if (!configured() || inflight || S.lat === null) return;
  const now = Date.now();
  if (now - failedAt < RETRY_MS) return;

  const moved = fetchedAt_lat === null ||
    metres(fetchedAt_lat, fetchedAt_lng, S.lat, S.lng) > MOVED_M;
  if (fetchedAt && now - fetchedAt < FRESH_MS && !moved) return;

  refresh();
}

export async function refresh() {
  if (!configured() || inflight || S.lat === null) return;
  inflight = true;
  const lat = S.lat, lng = S.lng;
  try {
    const base = settings.hazardUrl.replace(/\/+$/, "");
    const res = await fetch(base + "/hazards?lat=" + lat.toFixed(4) + "&lng=" + lng.toFixed(4),
      { cache: "no-store" });
    const body = await res.json();
    if (!res.ok) throw new Error(body && body.error ? body.error : "HTTP " + res.status);

    list = (Array.isArray(body.hazards) ? body.hazards : []).filter(ok);
    fetchedAt = Date.now();
    fetchedAt_lat = lat;
    fetchedAt_lng = lng;
    failedAt = 0;
    lastErr = "";
    store.set("hazards", { at: fetchedAt, lat: lat, lng: lng, list: list });
  } catch (e) {
    // Keep whatever was already showing. A failed scan is not "all clear".
    failedAt = Date.now();
    lastErr = String(e && e.message ? e.message : e).slice(0, 80);
  }
  inflight = false;
  try { onChange(); } catch (e) { /* a render error is not fatal */ }
}

/* Everything that reaches the map came out of a model reading news. Anything
   without a real position on the map is not a hazard, it is a sentence. */
function ok(h) {
  return h && typeof h.lat === "number" && typeof h.lng === "number" &&
    isFinite(h.lat) && isFinite(h.lng) &&
    Math.abs(h.lat) <= 90 && Math.abs(h.lng) <= 180 &&
    (h.kind === "flood" || h.kind === "closure");
}

/* Hazards the rider is close to, nearest first. Radius comes from the report
   itself, widened by a margin so a warning arrives before the water does. */
export function near(withinM) {
  if (S.lat === null || !list.length) return [];
  const out = [];
  for (const h of list) {
    const d = metres(S.lat, S.lng, h.lat, h.lng);
    const reach = Math.min(Math.max(h.radius_m || 300, 150), 3000) + (withinM || 900);
    if (d <= reach) out.push(Object.assign({ d: Math.round(d) }, h));
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}

/* The one worth interrupting for, or null. Ahead of the bike rather than
   behind it — a flood already ridden through is not news. */
export function ahead() {
  const close = near(900);
  if (!close.length) return null;
  if (!S.gpsOk || S.speed < 8) return close[0];
  for (const h of close) {
    const brg = (Math.atan2(
      (h.lng - S.lng) * Math.cos(S.lat * Math.PI / 180), h.lat - S.lat) * 180 / Math.PI + 360) % 360;
    const rel = Math.abs((brg - S.heading + 540) % 360 - 180);
    if (rel < 70) return h;
  }
  return null;
}

export function setUrl(url) {
  save({ hazardUrl: String(url || "").trim() });
  list = [];
  fetchedAt = 0;
  fetchedAt_lat = null;
  failedAt = 0;
  lastErr = "";
  store.del("hazards");
  if (configured()) refresh();
}

export function fmtAge(iso) {
  const t = Date.parse(iso);
  if (!isFinite(t)) return "";
  const m = (Date.now() - t) / 60000;
  if (m < 90) return Math.max(1, Math.round(m)) + " min ago";
  if (m < 60 * 36) return Math.round(m / 60) + " h ago";
  return Math.round(m / 1440) + " d ago";
}
