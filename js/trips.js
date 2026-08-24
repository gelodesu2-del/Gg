/* Trip recording and road scoring.

   A trip opens when you have been moving for a few seconds and closes after a
   sustained stop, so traffic lights do not shred one commute into twenty. Each
   trip carries its jolt count, which is what makes routes comparable: score a
   route by jolts per kilometre and you can answer which way home your
   suspension prefers, not merely which way is quicker. */

import { S } from "./state.js";
import * as store from "./store.js";
import { haversine } from "./sensors.js";

const START_SPEED = 5;      // km/h sustained before a trip opens
const START_MS = 3000;
const STOP_SPEED = 3;
const STOP_MS = 120000;     // a stop this long ends the trip
const POINT_M = 25;         // route is decimated to roughly this spacing
const CELL = 0.005;         // ~500 m grid, used to name a route by its ends

let trip = null;
let movingSince = 0;
let stoppedSince = 0;
let lastPoint = null;

export function tick(now) {
  const fix = S.lat === null ? null : { lat: S.lat, lng: S.lng };

  if (!trip) {
    if (S.speed > START_SPEED) {
      if (!movingSince) movingSince = now;
      if (now - movingSince > START_MS && fix) open(fix);
    } else {
      movingSince = 0;
    }
    return;
  }

  // distance and shape
  if (fix && lastPoint) {
    const d = haversine(lastPoint, fix);
    if (d > 2 && d < 200) {                  // 200 m in one tick is a GPS jump
      trip.m += d;
      if (d > POINT_M) { trip.pts.push([+fix.lat.toFixed(5), +fix.lng.toFixed(5)]); lastPoint = fix; }
    }
  } else if (fix) {
    lastPoint = fix;
  }

  trip.maxSpeed = Math.max(trip.maxSpeed, S.speed);
  trip.maxLean = Math.max(trip.maxLean, Math.abs(S.lean));
  if (S.speed > 1) trip.movingMs += 1000 / 60;

  if (S.speed < STOP_SPEED) {
    if (!stoppedSince) stoppedSince = now;
    if (now - stoppedSince > STOP_MS) close();
  } else {
    stoppedSince = 0;
  }
}

function open(fix) {
  trip = {
    id: Date.now(), start: Date.now(), m: 0, movingMs: 0,
    maxSpeed: 0, maxLean: 0, jolts: 0,
    from: cellKey(fix), to: null,
    pts: [[+fix.lat.toFixed(5), +fix.lng.toFixed(5)]]
  };
  lastPoint = fix;
  stoppedSince = 0;
  S.tripId = trip.id;
}

export function close() {
  if (!trip) return null;
  const t = trip;
  trip = null;
  S.tripId = null;
  movingSince = 0;
  stoppedSince = 0;
  lastPoint = null;

  if (t.m < 300) return null;               // too short to be a ride
  if (t.pts.length) t.to = cellKey({ lat: t.pts[t.pts.length - 1][0], lng: t.pts[t.pts.length - 1][1] });
  t.end = Date.now();
  t.km = +(t.m / 1000).toFixed(2);
  t.min = Math.round(t.movingMs / 60000);
  t.avg = t.min ? Math.round(t.km / (t.min / 60)) : 0;
  store.push("trips", t, 400);
  return t;
}

export function noteJolt(hit) {
  if (trip) trip.jolts++;
  store.push("jolts", hit, 2000);
}

export function current() { return trip; }

function cellKey(p) {
  return Math.round(p.lat / CELL) + ":" + Math.round(p.lng / CELL);
}

export function trips() { return store.get("trips", []); }
export function jolts() { return store.get("jolts", []); }

export function odometer() {
  return trips().reduce((s, t) => s + (t.km || 0), 0);
}

/* Group trips that share both endpoints, then score each group. A route needs
   a couple of runs before the average means anything, so single trips are
   held back rather than presented as findings. */
export function routes(minRides = 2) {
  const byKey = new Map();
  for (const t of trips()) {
    if (!t.from || !t.to) continue;
    const key = [t.from, t.to].sort().join("|");
    const r = byKey.get(key) || { key, km: 0, min: 0, jolts: 0, rides: 0, name: null };
    r.km += t.km || 0;
    r.min += t.min || 0;
    r.jolts += t.jolts || 0;
    r.rides++;
    byKey.set(key, r);
  }
  const named = store.get("routeNames", {});
  return [...byKey.values()]
    .filter((r) => r.rides >= minRides && r.km > 0)
    .map((r) => ({
      ...r,
      name: named[r.key] || ("Route " + r.key.slice(0, 6)),
      score: +(r.jolts / r.km).toFixed(1),
      avgKm: +(r.km / r.rides).toFixed(1),
      avgMin: Math.round(r.min / r.rides)
    }))
    .sort((a, b) => a.score - b.score);
}

/* Cluster logged hits so a single bad stretch reads as one entry rather than
   forty. Grid resolution is deliberately coarse — roughly a block. */
export function roughSpots(limit = 6) {
  const grid = new Map();
  for (const j of jolts()) {
    if (j.lat == null) continue;
    const k = Math.round(j.lat / 0.0004) + ":" + Math.round(j.lng / 0.0004);
    const g = grid.get(k) || { lat: j.lat, lng: j.lng, n: 0 };
    g.n++;
    grid.set(k, g);
  }
  return [...grid.values()].sort((a, b) => b.n - a.n).slice(0, limit);
}

/* Distance in metres to the nearest logged hit ahead, or null. Used for the
   approach warning — it only fires for spots you have hit more than once. */
export function nearestRough(maxM = 120) {
  if (S.lat === null) return null;
  let best = null;
  for (const g of roughSpots(40)) {
    if (g.n < 2) continue;
    const d = haversine({ lat: S.lat, lng: S.lng }, g);
    if (d < maxM && (!best || d < best.d)) best = { d, n: g.n };
  }
  return best;
}
