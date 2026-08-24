/* Bootstrap and frame loop. */

import { CFG, S, settings } from "./state.js";
import * as dash from "./dash.js";
import * as logs from "./logs.js";
import * as shell from "./shell.js";
import * as sensors from "./sensors.js";
import * as trips from "./trips.js";
import * as spotify from "./spotify.js";
import * as gmap from "./gmap.js";

const $ = (id) => document.getElementById(id);

let lastPoll = 0;
let stillSince = 0;
let crashAt = 0;
let decelPeak = 0;

sensors.setJoltHandler((hit) => trips.noteJolt(hit));

/* Crash detection.

   A web app cannot send an SMS on its own — no API exists for it, on any
   platform. What this does is detect the impact, give you twelve seconds to
   cancel, then open your messaging app with the location already written. You
   still tap send. A genuinely automatic alert needs a webhook, which is a
   different piece of plumbing and a decision for later. */
function crashWatch(now) {
  if (!settings.crashDetect || !settings.iceNumber) return;

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
      stillSince = 0;
      decelPeak = 0;
      shell.layer("");
      const where = S.lat === null ? "location unknown"
        : "https://maps.google.com/?q=" + S.lat.toFixed(5) + "," + S.lng.toFixed(5);
      location.href = "sms:" + encodeURIComponent(settings.iceNumber) +
        "?body=" + encodeURIComponent("I may have crashed. Last known position: " + where);
    }
  }
}

function frame(now) {
  dash.render(now);
  gmap.update(now);
  trips.tick(now);
  crashWatch(now);

  if (spotify.connected() && now - lastPoll > 5000) {
    lastPoll = now;
    spotify.poll().then(dash.renderSpotify);
  }
  requestAnimationFrame(frame);
}

async function boot() {
  dash.build();
  shell.init();

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(dash.calibrateDigits).catch(() => dash.calibrateDigits());
  } else {
    dash.calibrateDigits();
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
    gmap.load();
  }

  logs.render();
  requestAnimationFrame(frame);

  // A trip left open by a hard close should not swallow the next one.
  window.addEventListener("pagehide", () => trips.close());
}

boot();
