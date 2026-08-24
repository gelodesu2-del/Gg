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

sensors.setJoltHandler((hit) => trips.noteJolt(hit));

/* Crash detection. Detects the impact, gives twelve seconds to cancel, then
   hands a composed message to the messaging app — see sos.js for why that last
   step cannot be automatic. Does nothing at all with no contact assigned. */
function crashWatch(now) {
  // The rider said "I'm OK". Forget everything — a new prompt requires a
  // fresh impact, not the tail of this one. Without this, cancel left the
  // stillness timer set and the alarm re-armed on the next tick, forever.
  if (S.crashCancel) {
    S.crashCancel = false;
    S.impactAt = 0;
    stillSince = 0;
  }

  if (!settings.crashDetect || !sos.ready()) {
    // Detection can be switched off mid-countdown; do not leave a frozen
    // overlay behind when it is.
    if (S.crashArmed) { S.crashArmed = false; stillSince = 0; shell.layer(""); }
    return;
  }

  // A fix that stopped arriving counts as stillness: the crash most worth
  // catching is the one that leaves the phone face-down with no sky view,
  // where S.speed would otherwise freeze at its last riding value.
  const freshFix = S.lastFix && now - S.lastFix < 4000;
  const still = freshFix ? S.speed < 2 : true;

  if (still && S.impactAt && now - S.impactAt < 4000) {
    if (!stillSince) stillSince = now;
  } else if (!still) {
    stillSince = 0;
    if (S.impactAt && now - S.impactAt > 6000) S.impactAt = 0;
  }

  if (stillSince && !S.crashArmed && !S.crashReady && now - stillSince > CFG.crashStillMs) {
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
      S.impactAt = 0;
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
    // Trip time must use the interval between slow ticks, not the 16 ms
    // fast-frame dt — the old value under-counted moving time about 5x.
    const sdt = lastSlow ? Math.min((now - lastSlow) / 1000, 2) : 0;
    lastSlow = now;
    dash.renderSlow(now);
    trips.tick(now, sdt);
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

/* Installed apps hide the system status bar; a browser tab does not, and it
   lands on the speed. Checked rather than assumed. */
function detectInstalled() {
  // The native shell hides the system bars itself, so it counts as installed
  // even though a WebView reports display-mode: browser.
  const shell = / NMAXDashShell\//.test(navigator.userAgent);
  const standalone = shell ||
    (window.matchMedia && (matchMedia("(display-mode: fullscreen)").matches ||
                           matchMedia("(display-mode: standalone)").matches ||
                           matchMedia("(display-mode: minimal-ui)").matches)) ||
    window.navigator.standalone === true;
  document.getElementById("app").dataset.installed = standalone ? "yes" : "no";
  return standalone;
}

async function boot() {
  detectInstalled();
  if (window.matchMedia) {
    matchMedia("(display-mode: fullscreen)").addEventListener("change", detectInstalled);
  }
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
  window.addEventListener("pagehide", () => { trips.close(); trips.flushJolts(); });

  // Installs the app to the home screen and keeps it opening without signal.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").then((reg) => {
      // Without this the rider is always one launch behind: the cached copy
      // renders instantly while the new one downloads behind it, and only the
      // next cold start shows the change.
      reg.addEventListener("updatefound", () => {
        const fresh = reg.installing;
        if (!fresh) return;
        fresh.addEventListener("statechange", () => {
          if (fresh.state === "installed" && navigator.serviceWorker.controller) {
            shell.updateReady();
          }
        });
      });
      // Coming back to the app is the natural moment to look for one.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
      setTimeout(() => reg.update().catch(() => {}), 4000);
    }).catch(() => {});

    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "version") window.__swVersion = e.data.cache;
    });
    // On a first visit there is no controller yet, so ask again once one
    // takes over rather than reporting the build as unknown.
    const askVersion = () => {
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: "version" });
      }
    };
    askVersion();
    navigator.serviceWorker.addEventListener("controllerchange", askVersion);
    navigator.serviceWorker.ready.then(askVersion).catch(() => {});
  }
}

boot();
