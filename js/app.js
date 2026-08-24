/* Bootstrap and frame loop. */

import { CFG, S, settings } from "./state.js";
import * as dash from "./dash.js";
import * as logs from "./logs.js";
import * as shell from "./shell.js";
import * as sensors from "./sensors.js";
import * as trips from "./trips.js";
import * as spotify from "./spotify.js";
import * as mapview from "./mapview.js";
import * as sos from "./sos.js";

const $ = (id) => document.getElementById(id);

let lastPoll = 0;
let stillSince = 0;
let crashAt = 0;
let decelPeak = 0;

sensors.setJoltHandler((hit) => trips.noteJolt(hit));

/* Crash detection. Detects the impact, gives twelve seconds to cancel, then
   hands a composed message to the messaging app — see sos.js for why that last
   step cannot be automatic. Does nothing at all with no contact assigned. */
function crashWatch(now) {
  if (!settings.crashDetect || !sos.ready()) return;

  if (S.accel < -CFG.crashDecel / 9.81) decelPeak = now;

  const still = S.speed < 2;
  if (still && decelPeak && now - decelPeak < 4000) {
    if (!stillSince) stillSince = now;
  } else if (!still) {
    stillSince = 0;
    if (now - decelPeak > 6000) decelPeak = 0;
  }

  if (stillSince && !S.crashArmed && now - stillSince > CFG.crashStillMs) {
    S.crashArmed = true;
    crashAt = now;
    shell.layer("crash");
  }

  if (S.crashArmed) {
    const left = CFG.crashCountdown - Math.floor((now - crashAt) / 1000);
    $("crash-n").textContent = Math.max(0, left);
    if (left <= 0) {
      S.crashArmed = false;
      S.crashReady = true;
      stillSince = 0;
      decelPeak = 0;
      const body = sos.compose(S.lat, S.lng);
      $("crash-body").textContent = body;
      $("layer-crash").dataset.phase = "ready";
      sos.deliver(body);            // best effort — the button is the guarantee
    }
  }
}

/* Two cadences. Lean and the map rotor track continuously because the eye
   follows them; everything else is read rather than watched, and updating it
   sixty times a second was most of the frame budget for no visible gain. */
const SLOW_MS = 80;
const FAST_MS = 15;            // the lean arc gains nothing above ~60 Hz
let lastSlow = 0, lastFrame = 0, lastFast = 0;

function frame(now) {
  requestAnimationFrame(frame);

  // A 120 Hz panel would otherwise run every one of these twice, doubling the
  // work and the battery draw for motion no rider can see.
  if (now - lastFast < FAST_MS) return;
  const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.25) : 0;
  lastFast = now;
  lastFrame = now;

  dash.renderFast();
  mapview.update(now);

  if (now - lastSlow >= SLOW_MS) {
    lastSlow = now;
    dash.renderSlow(now);
    trips.tick(now, dt);
    crashWatch(now);
    if (spotify.connected() && now - lastPoll > 5000) {
      lastPoll = now;
      spotify.poll().then(dash.renderSpotify);
    }
  }
}

/* Reported in diagnostics so a refresh-rate problem is visible rather than
   guessed at. */
function measureRefresh() {
  let n = 0;
  const t0 = performance.now();
  (function s() {
    if (++n < 40) requestAnimationFrame(s);
    else window.__hz = Math.round(1000 / ((performance.now() - t0) / n));
  })();
}

async function boot() {
  dash.build();
  shell.init();

  const settle = () => { dash.verifyNumerals(settings.numeralFont); dash.calibrateDigits(); };
  settle();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(settle).catch(settle);
    // A slow font can land after fonts.ready resolves; one late re-check is
    // cheaper than shipping a dash full of notdef boxes.
    setTimeout(settle, 2500);
  }

  const returned = await spotify.handleRedirect();
  if (returned) shell.toast("Spotify connected");
  if (spotify.connected()) spotify.poll().then(dash.renderSpotify);

  if (!settings.setupDone) {
    shell.layer("setup");
    shell.syncSetup();
  } else {
    sensors.startGPS();
    sensors.startMotion();
    mapview.load();
  }

  logs.render();
  measureRefresh();
  requestAnimationFrame(frame);

  // A trip left open by a hard close should not swallow the next one.
  window.addEventListener("pagehide", () => trips.close());

  // Installs the app to the home screen and keeps it opening without signal.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

boot();
