/* Places the rider tags by hand.

   This replaced a feed that read flood advisories and guessed coordinates from
   them. The rider riding past the water knows where it is; a model reading the
   news does not. So the marks are placed by tapping the map, they are only
   ever this phone's, and nothing is fetched.

   The proximity maths is the interesting part and is shared with the pothole
   map: a mark matters when it is close AND roughly in front, so a spot already
   ridden past stops warning about itself. */

import { S } from "./state.js";
import * as store from "./store.js";

const MAX = 200;
const WARN_M = 220;              // how close before a mark takes the warning chip
const AHEAD_DEG = 70;            // within this of the bike's heading counts as in front

let list = [];
let onChange = () => {};

export function setOnChange(fn) { onChange = fn; }
function changed() {
  store.set("marks", list);
  try { onChange(); } catch (e) { /* a render error is not fatal */ }
}

try {
  const saved = store.get("marks", []);
  if (Array.isArray(saved)) list = saved.filter(ok);
} catch (e) { /* start empty */ }

function ok(m) {
  return m && typeof m.lat === "number" && typeof m.lng === "number" &&
    isFinite(m.lat) && isFinite(m.lng) &&
    Math.abs(m.lat) <= 90 && Math.abs(m.lng) <= 180;
}

const metres = (aLat, aLng, bLat, bLng) => {
  const dx = (bLng - aLng) * 111320 * Math.cos(aLat * Math.PI / 180);
  const dy = (bLat - aLat) * 110540;
  return Math.sqrt(dx * dx + dy * dy);
};

export function all() { return list; }
export function count() { return list.length; }

export function add(lat, lng) {
  if (!isFinite(lat) || !isFinite(lng)) return null;
  const m = { id: "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              lat: +lat.toFixed(6), lng: +lng.toFixed(6), at: Date.now() };
  // Tapping the same spot twice is a miss-tap, not two marks.
  for (const e of list) {
    if (metres(e.lat, e.lng, m.lat, m.lng) < 15) return e;
  }
  list.unshift(m);
  if (list.length > MAX) list.length = MAX;
  changed();
  return m;
}

export function remove(id) {
  const before = list.length;
  list = list.filter((m) => m.id !== id);
  if (list.length !== before) changed();
}

export function clear() { list = []; changed(); }

/* The mark nearest a point, within a tap's worth of slop. Used to turn a tap
   on an existing mark into a removal rather than a second mark on top. */
export function at(lat, lng, withinM) {
  let best = null, bestD = Infinity;
  for (const m of list) {
    const d = metres(m.lat, m.lng, lat, lng);
    if (d < bestD) { bestD = d; best = m; }
  }
  return best && bestD <= (withinM || 25) ? best : null;
}

export function near(withinM) {
  if (S.lat === null || !list.length) return [];
  const out = [];
  for (const m of list) {
    const d = metres(S.lat, S.lng, m.lat, m.lng);
    if (d <= (withinM || WARN_M)) out.push({ id: m.id, lat: m.lat, lng: m.lng, at: m.at, d: Math.round(d) });
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}

/* The one worth a chip: close, and in front rather than behind. Standing
   still there is no "in front", so proximity alone decides. */
export function ahead() {
  const close = near(WARN_M);
  if (!close.length) return null;
  if (!S.gpsOk || S.speed < 8) return close[0];
  for (const m of close) {
    const brg = (Math.atan2(
      (m.lng - S.lng) * Math.cos(S.lat * Math.PI / 180), m.lat - S.lat) * 180 / Math.PI + 360) % 360;
    const rel = Math.abs((brg - S.heading + 540) % 360 - 180);
    if (rel < AHEAD_DEG) return m;
  }
  return null;
}
