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
let decelEMA = 0;
let joltBase = 0;
let lastJolt = 0;
let lastMotion = 0;
let onJolt = () => {};

export function setJoltHandler(fn) { onJolt = fn; }

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

let gpsWatchId = null;
let motionOn = false;
let orientOn = false;
let calJob = null;

export function startGPS() {
  if (!("geolocation" in navigator)) return false;
  if (gpsWatchId !== null) return true;      // already watching
  gpsWatchId = navigator.geolocation.watchPosition(
    (p) => {
      const c = p.coords;
      if (typeof c.speed === "number" && c.speed >= 0) S.speed = c.speed * 3.6;
      const fastEnough = (c.speed || 0) * 3.6 >= 8;
      if (typeof c.heading === "number" && !Number.isNaN(c.heading) &&
          (fastEnough || !settings.cal)) S.heading = c.heading;
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

  if (calJob) {
    calJob.gx += g.x || 0; calJob.gy += g.y || 0; calJob.gz += g.z || 0; calJob.gn++;
    if (now > calJob.until) finishCal();
  }

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
  // Evaluated here at full sensor rate rather than in the 12 Hz UI poll: a
  // real impact spike can be far shorter than 80 ms and would fall between
  // polls. Two signatures qualify as an impact. A sustained hard deceleration
  // uses a ~250 ms EMA, so one pothole sample cannot set it the way a single
  // instantaneous reading used to. A violent jolt at speed catches the hit
  // itself, at a level far above what braking or potholes produce.
  const lin = e.acceleration;
  if (lin && typeof lin.z === "number") {
    S.accel = -(lin.z || 0) / G;
    decelEMA += (S.accel - decelEMA) * (1 - Math.exp(-dt / 0.25));
    if (decelEMA < -0.72) S.impactAt = now;
  }

  // --- jolts ---
  // Slow baseline removes the steady 1g and any mount angle, leaving the
  // spikes. Speed gating keeps handling the phone out of the log.
  const dev = mag - G;
  joltBase += (dev - joltBase) * 0.02;
  const spike = Math.abs(dev - joltBase);
  if (spike > 22 && S.speed > 15) S.impactAt = now;
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

/* Compass. alpha is the device's rotation about vertical; the mount makes its
   absolute value meaningless, which is exactly what calibrating while facing
   north fixes — whatever alpha reads at that moment becomes the reference,
   bracket angle and all. Corrected for screen rotation so a flipped landscape
   mount stays consistent. */
/* True once the shell's compass is driving this, so the DOM events can be
   left alone rather than fighting it at a tenth of the rate. */
let nativeHeading = false;
export const nativeCompass = () => nativeHeading;

function orient(e) {
  let a = e.alpha;
  if (typeof a !== "number" || Number.isNaN(a)) return;
  try { a = (a + ((screen.orientation && screen.orientation.angle) || 0)) % 360; } catch (err) { /* keep raw */ }
  S.compassAlpha = a;

  if (calJob) {
    const rad = a * Math.PI / 180;
    calJob.sinA += Math.sin(rad); calJob.cosA += Math.cos(rad); calJob.an++;
    if (performance.now() > calJob.until) finishCal();
  }

  const cal = settings.cal;
  if (!cal || cal.northAlpha == null) return;
  const now = performance.now();
  const staleFix = !S.lastFix || now - S.lastFix > 4000;
  if (S.speed >= 8 && !staleFix) return;            // GPS course owns it while moving
  const target = (cal.northAlpha - a + 360) % 360;
  const d = ((target - S.heading + 540) % 360) - 180;
  // Shortest arc, smoothed. The native source arrives about ten times as
  // often, so it can afford a much shorter time constant without jitter.
  S.heading = (S.heading + d * (nativeHeading ? 0.35 : 0.12) + 360) % 360;
}

/* One guided pass: bike upright on level ground, front wheel facing north,
   phone in its bracket, held still. Captures the at-rest gravity vector (the
   bracket's orientation), the compass reference for north, and zeroes the
   lean integrator. */
export function calibrateMount(ms = 2000) {
  return new Promise((resolve) => {
    calJob = { gx: 0, gy: 0, gz: 0, gn: 0, sinA: 0, cosA: 0, an: 0,
               until: performance.now() + ms, resolve };
    setTimeout(() => { if (calJob) finishCal(); }, ms + 600);   // sensors may be silent
  });
}

function finishCal() {
  const c = calJob;
  calJob = null;
  if (!c) return;
  let g = null, pitch = null;
  if (c.gn) {
    g = [c.gx / c.gn, c.gy / c.gn, c.gz / c.gn];
    const mag = Math.hypot(g[0], g[1], g[2]) || 1;
    // Angle between gravity and the screen plane: 0 = screen perfectly
    // vertical in the bracket, 90 = lying flat.
    pitch = Math.round(Math.asin(clamp(Math.abs(g[2]) / mag, 0, 1)) * 180 / Math.PI);
  }
  const northAlpha = c.an
    ? (Math.atan2(c.sinA / c.an, c.cosA / c.an) * 180 / Math.PI + 360) % 360
    : null;
  calibrateLean();
  c.resolve({
    ok: c.gn > 0 || c.an > 0,
    gravity: g ? g.map((v) => +v.toFixed(3)) : null,
    pitch,
    northAlpha: northAlpha === null ? null : +northAlpha.toFixed(1),
    // Which compass produced the reference. The two sources can sit a constant
    // offset apart, so a calibration taken on one is not valid on the other —
    // recording it is what lets diagnostics say so instead of the rider
    // discovering it as a map that points somewhere plausible but wrong.
    src: nativeHeading ? "native" : "web",
    when: Date.now()
  });
}

export async function startMotion() {
  const DME = window.DeviceMotionEvent;
  if (!DME) return false;
  if (motionOn) return true;
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
  motionOn = true;
  if (!orientOn) {
    orientOn = true;
    // The shell's rotation-vector sensor is the same quantity from the source
    // at roughly ten times the rate, and without a bridge crossing per DOM
    // event. It emits in the alpha convention, so it feeds the same function
    // and calibration works unchanged.
    if (window.NMAXShell && typeof window.NMAXShell.headingStart === "function") {
      window.__nmaxHeading = (deg) => orient({ alpha: +deg });
      try { window.NMAXShell.headingStart(); nativeHeading = true; } catch (e) { nativeHeading = false; }
    }
    if (!nativeHeading) {
      const DOE = window.DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission === "function") {
        try { await DOE.requestPermission(); } catch (e) { /* compass optional */ }
      }
      // Android fires the absolute variant; the plain one is a fallback that at
      // least keeps relative turns coherent between GPS fixes.
      window.addEventListener("deviceorientationabsolute", orient, { passive: true });
      window.addEventListener("deviceorientation", (e) => { if (e.absolute !== false) orient(e); }, { passive: true });
    }
  }
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
