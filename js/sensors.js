/* GPS and motion.

   Lean is the interesting one. A bike in a steady, balanced corner is in
   equilibrium, so the accelerometer alone reads close to upright no matter how
   far over you are — the classic trap. What it *can* see is the magnitude of
   the combined vector: |a| = g / cos(lean). That gives the size of the lean but
   not its direction. The gyroscope gives direction and fast response but
   drifts. Blending the two — sign and transients from the gyro, steady-state
   magnitude from |a| — is accurate through the riding you actually look at. */

import { CFG, S, settings } from "./state.js";

const G = 9.81;
let gyroLean = 0;
let joltBase = 0;
let lastJolt = 0;
let lastMotion = 0;
let onJolt = () => {};

export function setJoltHandler(fn) { onJolt = fn; }

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function startGPS() {
  if (!("geolocation" in navigator)) return false;
  navigator.geolocation.watchPosition(
    (p) => {
      const c = p.coords;
      if (typeof c.speed === "number" && c.speed >= 0) S.speed = c.speed * 3.6;
      if (typeof c.heading === "number" && !Number.isNaN(c.heading)) S.heading = c.heading;
      S.lat = c.latitude;
      S.lng = c.longitude;
      S.accuracy = c.accuracy;
      S.gpsOk = true;
      S.lastFix = performance.now();
    },
    () => { S.gpsOk = false; },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
  return true;
}

function motion(e) {
  const now = performance.now();
  const dt = lastMotion ? Math.min((now - lastMotion) / 1000, 0.2) : 0;
  lastMotion = now;
  if (!dt) return;

  const g = e.accelerationIncludingGravity;
  const r = e.rotationRate;
  if (!g) return;

  // --- lean ---
  if (r && typeof r.alpha === "number") {
    // Mounted landscape facing the rider, roll about the bike's axis of travel
    // shows up as rotation around the screen normal.
    const rate = (r.alpha || 0) * (settings.invertLean ? -1 : 1);
    gyroLean += rate * dt;
    S.leanRaw += rate * dt;
  }

  const mag = Math.hypot(g.x || 0, g.y || 0, g.z || 0);
  if (mag > G * 0.92) {
    const magnitude = Math.acos(clamp(G / mag, 0, 1)) * 180 / Math.PI;
    const signed = Math.sign(S.leanRaw || gyroLean || 1) * magnitude;
    // Long time constant: the gyro leads, |a| pulls the estimate back over
    // seconds so integration drift cannot accumulate.
    const k = 1 - Math.exp(-dt / 2.5);
    S.leanRaw += (signed - S.leanRaw) * k;
  }
  S.lean += (S.leanRaw - S.lean) * (1 - Math.exp(-dt / 0.12));
  S.lean = clamp(S.lean, -80, 80);

  if (S.lean < 0) S.maxL = Math.max(S.maxL, -S.lean);
  if (S.lean > 0) S.maxR = Math.max(S.maxR, S.lean);

  // --- longitudinal acceleration, for crash detection ---
  const lin = e.acceleration;
  if (lin && typeof lin.z === "number") S.accel = -(lin.z || 0) / G;

  // --- jolts ---
  // Slow baseline removes the steady 1g and any mount angle, leaving the
  // spikes. Speed gating keeps handling the phone out of the log.
  const dev = mag - G;
  joltBase += (dev - joltBase) * 0.02;
  const spike = Math.abs(dev - joltBase);
  if (
    spike > CFG.joltThreshold &&
    S.speed > CFG.joltMinSpeed &&
    now - lastJolt > CFG.joltDebounce &&
    S.lat !== null
  ) {
    lastJolt = now;
    onJolt({ lat: S.lat, lng: S.lng, mag: +spike.toFixed(2), t: Date.now() });
  }
}

export async function startMotion() {
  const DME = window.DeviceMotionEvent;
  if (!DME) return false;
  // iOS gates this behind a user gesture. Android does not, but asking costs
  // nothing when the method is absent.
  if (typeof DME.requestPermission === "function") {
    try {
      const res = await DME.requestPermission();
      if (res !== "granted") return false;
    } catch (e) {
      return false;
    }
  }
  window.addEventListener("devicemotion", motion, { passive: true });
  return true;
}

/* Zero the estimate with the bike held upright. The |a| term needs no
   calibration, so this only has to clear the integrator. */
export function calibrateLean() {
  gyroLean = 0;
  S.leanRaw = 0;
  S.lean = 0;
}

export function resetPeaks() { S.maxL = 0; S.maxR = 0; }

/* Metres between two fixes. */
export function haversine(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
