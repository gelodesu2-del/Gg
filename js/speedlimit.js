/* The speed limit for the road actually underneath the bike.

   Google's Roads API has speed limits, but only under an Asset Tracking
   licence — it is not something a standard Maps key can call, so it is not an
   option here. OpenStreetMap's `maxspeed` tag is, it needs no key, and on
   Metro Manila's named roads the coverage is decent. On the small streets it
   is not, which is why the rider's own setting stays the floor: when OSM has
   nothing to say, nothing changes.

   Overpass is a shared free service. It is queried by area rather than by
   position — one request covers a square kilometre and everything inside it is
   answered from memory — and never more than once every half minute. */

import { S, settings } from "./state.js";
import * as store from "./store.js";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
const CELL = 0.01;                 // ~1.1 km of latitude per tile
const TILE_LIFE = 14 * 864e5;      // speed limits are not weather
const MIN_GAP_MS = 30000;          // politeness toward a free shared service
const MAX_SNAP_M = 40;             // beyond this the bike is not on that road
const MAX_TILES = 24;

let tiles = new Map();             // key -> { at, ways: [...] }
let lastReq = 0;
let inflight = false;
let epIdx = 0;
let lastErr = "";

/* Kept between sessions: the same commute is the same tiles every day, and
   re-downloading them daily would be rude as well as slow. */
try {
  const saved = store.get("osmspeed", null);
  if (saved && typeof saved === "object") {
    for (const k of Object.keys(saved)) {
      if (Date.now() - saved[k].at < TILE_LIFE) tiles.set(k, saved[k]);
    }
  }
} catch (e) { /* start empty */ }

function persist() {
  const out = {};
  for (const [k, v] of tiles) out[k] = v;
  store.set("osmspeed", out);
}

const keyOf = (lat, lng) =>
  Math.floor(lat / CELL) + "_" + Math.floor(lng / CELL);

/* "60", "60 km/h", "30 mph" — and the words some mappers use instead. */
function parseMaxspeed(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (s === "none" || s === "signals" || s === "variable") return null;
  const m = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kph)?$/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0 || n > 200) return null;
  return Math.round(m[2] === "mph" ? n * 1.609344 : n);
}

/* Distance in metres from the bike to a segment, and the segment's own
   bearing. Planar maths: over the tens of metres that matter here the error
   is far below the GPS's own. */
function segment(aLat, aLng, bLat, bLng) {
  const cos = Math.cos(S.lat * Math.PI / 180);
  const ax = (aLng - S.lng) * 111320 * cos, ay = (aLat - S.lat) * 110540;
  const bx = (bLng - S.lng) * 111320 * cos, by = (bLat - S.lat) * 110540;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + t * dx, py = ay + t * dy;
  return {
    d: Math.sqrt(px * px + py * py),
    bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360
  };
}

async function fetchTile(key, lat, lng) {
  const south = Math.floor(lat / CELL) * CELL, west = Math.floor(lng / CELL) * CELL;
  const bbox = south.toFixed(4) + "," + west.toFixed(4) + "," +
               (south + CELL).toFixed(4) + "," + (west + CELL).toFixed(4);
  const q = "[out:json][timeout:20];way[highway][maxspeed](" + bbox + ");out geom tags;";

  const url = ENDPOINTS[epIdx % ENDPOINTS.length];
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(q)
  });
  if (!res.ok) { epIdx++; throw new Error("overpass " + res.status); }
  const body = await res.json();

  const ways = [];
  for (const el of (body.elements || [])) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const kmh = parseMaxspeed(el.tags && el.tags.maxspeed);
    if (!kmh) continue;
    ways.push({
      kmh: kmh,
      name: (el.tags && (el.tags.name || el.tags.ref)) || "",
      pts: el.geometry.map((p) => [p.lat, p.lon])
    });
  }
  tiles.set(key, { at: Date.now(), ways: ways });
  // Oldest out first, so a long ride cannot grow this without bound.
  while (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
  persist();
}

/* Called from the slow loop. Fetches at most one tile, and only the one the
   bike is actually in. */
export function tick() {
  if (S.lat === null || inflight) return;
  const key = keyOf(S.lat, S.lng);
  const have = tiles.get(key);
  if (have && Date.now() - have.at < TILE_LIFE) return;
  if (Date.now() - lastReq < MIN_GAP_MS) return;

  lastReq = Date.now();
  inflight = true;
  fetchTile(key, S.lat, S.lng)
    .then(() => { lastErr = ""; })
    .catch((e) => { lastErr = String(e && e.message ? e.message : e).slice(0, 60); })
    .then(() => { inflight = false; });
}

/* The limit for the road under the bike, or null when OSM has nothing.
   Among the roads within snapping distance, the one running the same way the
   bike is wins — otherwise a limit from the expressway overhead would apply
   to the service road beneath it. */
export function current() {
  if (S.lat === null) return null;
  const tile = tiles.get(keyOf(S.lat, S.lng));
  if (!tile || !tile.ways.length) return null;

  let best = null;
  for (const w of tile.ways) {
    for (let i = 0; i < w.pts.length - 1; i++) {
      const seg = segment(w.pts[i][0], w.pts[i][1], w.pts[i + 1][0], w.pts[i + 1][1]);
      if (seg.d > MAX_SNAP_M) continue;
      // A road carries traffic both ways, so an exactly opposite bearing is
      // just as aligned as an identical one.
      let off = Math.abs(((seg.bearing - S.heading + 540) % 360) - 180);
      if (off > 90) off = 180 - off;
      const score = seg.d + (S.gpsOk && S.speed > 8 ? off * 0.6 : 0);
      if (!best || score < best.score) {
        best = { score: score, kmh: w.kmh, name: w.name, d: Math.round(seg.d) };
      }
    }
  }
  return best;
}

/* What the roundel shows: the road's own limit when there is one, and the
   rider's setting when there is not. */
export function limit() {
  const road = settings.roadLimits === false ? null : current();
  return road ? road.kmh : settings.speedLimit;
}

export function roadName() {
  const road = settings.roadLimits === false ? null : current();
  return road ? road.name : "";
}

export function status() {
  if (settings.roadLimits === false) return "off";
  if (lastErr) return lastErr;
  if (S.lat === null) return "waiting for a fix";
  const tile = tiles.get(keyOf(S.lat, S.lng));
  if (!tile) return inflight ? "loading" : "no data here yet";
  const road = current();
  return road
    ? road.kmh + " km/h" + (road.name ? " · " + road.name : "") + " · " + road.d + " m"
    : tile.ways.length + " roads mapped, none matched";
}
