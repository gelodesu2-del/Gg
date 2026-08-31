/* Chrome around the two panes: paging, tabs, settings, themes, wake lock. */

import { S, settings, save } from "./state.js";
import * as dash from "./dash.js";
import * as logs from "./logs.js";
import * as sensors from "./sensors.js";
import * as spotify from "./spotify.js";
import * as mapview from "./mapview.js";
import * as sos from "./sos.js";
import * as nav from "./nav.js";
import * as obd from "./obd.js";
import * as alerts from "./alerts.js";
import * as marks from "./marks.js";
import * as speedlimit from "./speedlimit.js";
import { SERVICE_DEFAULTS } from "./state.js";

const $ = (id) => document.getElementById(id);
/* name, two preview chips, mode. The mode is what flips the ground tokens —
   a light theme is dark accents sitting on paper instead of neon on black. */
const THEMES = [
  ["emerald",  "#00F58C", "#FFB833", "dark"],
  ["ion",      "#00F0FF", "#FF2E97", "dark"],
  ["amber",    "#FFB020", "#FF7A1A", "dark"],
  ["violet",   "#A97BFF", "#FF7ADF", "dark"],
  ["mono",     "#E8EDF2", "#B0B8C2", "dark"],
  ["crimson",  "#FF4757", "#FFB833", "dark"],
  ["daylight", "#00794A", "#B26B00", "light"],
  ["paper",    "#22303C", "#8A6D3B", "light"],
  ["sunburst", "#A85400", "#963200", "light"],
  ["sakura",   "#B0225C", "#7A4A00", "light"]
];

let page = 0, sx = 0, sy = 0, axis = null, dx = 0, wakeRef = null;

export function setTheme(name) {
  const def = THEMES.find((t) => t[0] === name) || THEMES[0];
  $("app").dataset.theme = def[0];
  $("app").dataset.mode = def[3];
  save({ theme: def[0] });
  dash.readTheme();
  document.querySelectorAll(".cs-card").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.theme === def[0])));
  mapview.restyle();          // the map follows the theme, mode included
  logs.render();
}

export function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("on"), 2600);
}

/* A tap target rather than a toast: an update the rider never notices is the
   same as no update, and reloading mid-ride should be their choice. */
export function updateReady() {
  const el = $("update");
  if (!el || el.classList.contains("on")) return;
  el.classList.add("on");
}

/* ---------- back button ----------
   Layers and the logs page each push a history entry when they open, so the
   system back button (or gesture) pops them instead of leaving the app — the
   WebView shell's goBack() lands here. The crash overlay is deliberately
   exempt: dismissing that must be an explicit tap on its own buttons. */
let layerPushed = false;
let pagePushed = false;
let suppressPop = false;

function openLayers() {
  const on = document.querySelector(".layer.on");
  return on ? on.id.replace("layer-", "") : "";
}

export function layer(name) {
  document.querySelectorAll(".layer").forEach((l) => l.classList.toggle("on", l.id === "layer-" + name));
  if (name && name !== "crash") {
    if (!layerPushed) { try { history.pushState({ nmax: "layer" }, ""); } catch (e) {} layerPushed = true; }
  } else if (!name && layerPushed) {
    layerPushed = false;
    suppressPop = true;
    try { history.back(); } catch (e) { suppressPop = false; }
  }
}

window.addEventListener("popstate", () => {
  if (suppressPop) { suppressPop = false; return; }
  const open = openLayers();
  if (open === "crash") {
    // Put the entry back: back must not dismiss a crash prompt.
    try { history.pushState({ nmax: "layer" }, ""); } catch (e) {}
    return;
  }
  if (open) {
    layerPushed = false;
    document.querySelectorAll(".layer").forEach((l) => l.classList.remove("on"));
    return;
  }
  if (page === 1) { pagePushed = false; goto(0); }
});

function goto(p) {
  const prev = page;
  page = Math.max(0, Math.min(1, p));
  if (page === 1 && prev !== 1 && !pagePushed) {
    try { history.pushState({ nmax: "page" }, ""); } catch (e) {}
    pagePushed = true;
  } else if (page === 0 && prev === 1 && pagePushed) {
    pagePushed = false;
    suppressPop = true;
    try { history.back(); } catch (e) { suppressPop = false; }
  }
  $("pager").style.transform = "translateX(" + (-page * 100) + "%)";
  [...$("dots").children].forEach((d, i) => d.classList.toggle("on", i === page));
  // The native shell needs this to know what its back gesture should do.
  try { if (window.NMAXShell) window.NMAXShell.setPage(page); } catch (e) { /* web only */ }
  if (page === 1) logs.render();
}
window.__nmaxGoto = goto;

async function wake(on) {
  try {
    if (on && "wakeLock" in navigator) wakeRef = await navigator.wakeLock.request("screen");
    else if (wakeRef) { await wakeRef.release(); wakeRef = null; }
  } catch (e) { /* denied or unsupported; the dash still runs */ }
}

export function init() {
  // ---- colors menu ----
  const card = ([n, a, b]) =>
    '<button class="cs-card" type="button" data-theme="' + n + '" aria-pressed="false">' +
    '<span class="cs-strip"><i style="background:' + a + '"></i><i style="background:' + b + '"></i></span>' +
    '<span class="nm">' + n + "</span></button>";
  $("cs-dark").innerHTML = THEMES.filter((t) => t[3] === "dark").map(card).join("");
  $("cs-light").innerHTML = THEMES.filter((t) => t[3] === "light").map(card).join("");
  document.querySelectorAll(".cs-card").forEach((b) => b.addEventListener("click", () => setTheme(b.dataset.theme)));
  $("colors-btn").addEventListener("click", () => layer("colors"));
  $("cs-close").addEventListener("click", () => layer("settings"));

  // ---- pager: horizontal drags page, vertical ones scroll the logs ----
  const pager = $("pager");
  pager.addEventListener("pointerdown", (e) => {
    if (e.target.closest("input,button,.logs-tabs,.layer")) return;
    sx = e.clientX; sy = e.clientY; axis = null; dx = 0;
    pager.setPointerCapture(e.pointerId);
  });
  pager.addEventListener("pointermove", (e) => {
    if (!pager.hasPointerCapture(e.pointerId)) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (axis === null) {
      if (Math.abs(mx) < 6 && Math.abs(my) < 6) return;
      axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
      if (axis === "x") pager.classList.add("drag");
      else { pager.releasePointerCapture(e.pointerId); return; }
    }
    if (axis !== "x") return;
    dx = mx;
    const w = pager.getBoundingClientRect().width || 1;
    pager.style.transform = "translateX(" + Math.max(-100, Math.min(0, -page * 100 + dx / w * 100)) + "%)";
  });
  const end = (e) => {
    if (pager.hasPointerCapture(e.pointerId)) pager.releasePointerCapture(e.pointerId);
    pager.classList.remove("drag");
    if (axis === "x") {
      const w = pager.getBoundingClientRect().width || 1;
      goto(Math.abs(dx) > w * 0.16 ? page + (dx < 0 ? 1 : -1) : page);
    }
    axis = null; dx = 0;
  };
  pager.addEventListener("pointerup", end);
  pager.addEventListener("pointercancel", end);
  $("dots").addEventListener("click", () => goto(page === 0 ? 1 : 0));
  // A swipe from the left edge is the system back gesture, so the logs need a
  // control that does not depend on one.
  $("logs-back").addEventListener("click", () => goto(0));

  // ---- logs tabs ----
  document.querySelectorAll(".logs-tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".logs-tabs button").forEach((o) => o.setAttribute("aria-selected", String(o === b)));
      document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("on", p.dataset.tab === b.dataset.tab));
    }));

  // ---- settings ----
  $("gear").addEventListener("click", () => { if (page === 1) goto(0); syncSettings(); layer("settings"); });
  $("update").addEventListener("click", () => location.reload());
  $("set-close").addEventListener("click", () => layer(""));
  // Long-press on the dial stays the quick lean-zero; the settings button
  // opens the full pass that also captures north and the bracket angle.
  const recal = () => { sensors.calibrateLean(); sensors.resetPeaks(); toast("Lean zeroed — hold the bike upright when you do this"); };
  // ---- OBD ----
  const obdRow = () => {
    $("obd-btn").textContent = obd.connected() || obd.status.state === "connecting" ? "Disconnect" : "Connect";
    $("obd-sub").textContent =
      obd.status.state === "polling" ? (obd.status.device || "connected") + " · live" :
      obd.status.state === "idle" ? "ELM327 over Bluetooth LE" :
      obd.status.state + (obd.status.error ? " — " + obd.status.error : "");
  };
  obd.setOnChange(() => { obdRow(); renderObdStatus(); });
  $("obd-btn").addEventListener("click", async () => {
    if (obd.connected() || obd.status.state === "connecting") { obd.disconnect(); obdRow(); return; }
    if (obd.hasShell()) {
      $("obd-list").innerHTML = "";
      layer("obd");
      renderObdStatus();
      obd.startScan((dev) => {
        if ([...$("obd-list").children].some((r) => r.dataset.addr === dev.addr)) return;
        const row = document.createElement("button");
        row.className = "s-row"; row.type = "button"; row.dataset.addr = dev.addr;
        // Both kinds land in one list; the tag says which radio answered, so a
        // dongle that shows up only after pairing is recognisable as classic.
        row.innerHTML = '<span class="nm">' + escapeHtml(dev.name) +
          (dev.kind === "spp" ? ' <span class="tag">paired</span>' : "") +
          '</span><span class="rc">' + escapeHtml(dev.addr) + "</span>";
        row.addEventListener("click", () => { obd.stopScan(); obd.connectTo(dev.addr, dev.name, dev.kind); });
        $("obd-list").appendChild(row);
      });
    } else if (obd.hasWeb()) {
      await obd.connectWeb();       // the browser shows its own device chooser
      obdRow();
    } else {
      toast("No Bluetooth available here");
    }
  });
  /* ---- phone notifications ---- */
  /* The grant lives in Android's own settings screen — an app cannot award
     itself notification access — so this row sends the rider there and then
     re-reads the answer when they come back. */
  function noteRow() {
    const shell = alerts.hasShell();
    const on = shell && alerts.listenerOn();
    $("note-btn").textContent = !shell ? "App only" : on ? "On" : "Off";
    $("note-btn").disabled = !shell;
    $("note-sub").textContent = !shell
      ? "Needs the installed app, not a browser tab"
      : on ? "Messages and calls appear on the map"
           : "Opens Android's notification access screen";
  }
  $("note-btn").addEventListener("click", () => { alerts.openListenerSettings(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) noteRow(); });
  noteRow();

  /* ---- alerts ---- */
  $("alerts-btn").addEventListener("click", () => { renderAlerts(); layer("alerts"); alerts.markRead(); });
  $("al-close").addEventListener("click", () => layer(""));
  $("al-clear").addEventListener("click", () => { alerts.clearPhone(); renderAlerts(); });
  $("slot-note").addEventListener("click", () => { renderAlerts(); layer("alerts"); alerts.markRead(); });
  alerts.setOnChange(() => { if (openLayers() === "alerts") renderAlerts(); });

  function row(sev, title, sub, age) {
    const el = document.createElement("div");
    el.className = "al-item " + sev;
    el.innerHTML = '<span class="al-ib"><span class="al-it"></span><span class="al-is"></span></span>' +
                   '<span class="al-ia"></span>';
    // Notification text comes from other people's apps: it is set as text,
    // never parsed as markup.
    el.querySelector(".al-it").textContent = title;
    el.querySelector(".al-is").textContent = sub;
    el.querySelector(".al-ia").textContent = age;
    return el;
  }

  function fill(host, items, empty) {
    host.innerHTML = "";
    if (!items.length) {
      const e = document.createElement("div");
      e.className = "al-empty";
      e.textContent = empty;
      host.appendChild(e);
      return;
    }
    for (const it of items) host.appendChild(it);
  }

  function renderAlerts() {
    const b = alerts.bike();
    fill($("al-bike"), b.map((a) => row(a.sev, a.t, a.s, "")),
         "Nothing to report. Warm-up, service and road warnings appear here as they happen.");
    $("al-cb").textContent = b.length ? b.length + " active" : "clear";

    const ph = alerts.phone();
    fill($("al-phone"), ph.map((n) => row(n.read ? "info" : "crit",
      (n.app ? n.app + " · " : "") + (n.title || ""), n.body, alerts.fmtAge(n.at))),
      alerts.hasShell()
        ? (alerts.listenerOn()
            ? "Nothing yet. Messages and calls land here as they arrive."
            : "Notification access is off. Settings \u2192 Phone notifications turns it on.")
        : "Phone notifications need the app, not a browser tab.");
    $("al-cp").textContent = ph.length ? ph.length + " today" : "none";
  }

  $("obd-close").addEventListener("click", () => { obd.stopScan(); layer("settings"); });
  $("obd-forget").addEventListener("click", () => { obd.disconnect(); toast("Forgotten"); layer("settings"); });

  function renderObdStatus() {
    const st = obd.status;
    const el = $("obd-status");
    if (!el) return;
    el.innerHTML =
      st.state === "scanning" ? "Scanning… tap your dongle when it appears. " +
        "Nothing after ten seconds? Pair it in Android\u2019s Bluetooth settings " +
        "first (PIN 1234), then scan again." :
      st.state === "connecting" ? "Connecting to <b>" + escapeHtml(st.device) + "</b>…" :
      st.state === "init" ? "Waking the dongle…" :
      st.state === "probing" ? "Talking to the ECU over <b>" + escapeHtml(st.proto || "auto") +
        "</b>" + (st.probeStep ? " (" + st.probeStep + ")" : "") +
        " — first contact takes about ten seconds, and a bus that will not " +
        "answer costs a minute of trying the rest." :
      st.state === "polling" ? "<b>" + escapeHtml(st.device || "Connected") + "</b> · RPM " + tick(st.pids.rpm) +
        " · temp " + tick(st.pids.temp) + " · fuel " + tick(st.pids.fuel) +
        (st.volts ? " · " + st.volts.toFixed(1) + " V" : "") :
      st.state === "error" ? "Failed: " + escapeHtml(st.error || "unknown") : "";
  }
  const tick = (v) => (v === true ? "✓" : v === false ? "✗" : "…");

  $("cal-btn").addEventListener("click", () => { $("cal-status").textContent = ""; layer("cal"); });
  $("cal-close").addEventListener("click", () => layer("settings"));
  $("cal-start").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    $("cal-status").textContent = "Sampling — hold everything still…";
    const r = await sensors.calibrateMount(2000);
    btn.disabled = false;
    if (!r.ok) {
      $("cal-status").textContent = "No sensor data arrived. Grant motion access in setup first.";
      return;
    }
    save({ cal: r });
    sensors.resetPeaks();
    $("cal-status").innerHTML =
      "Done. Lean zeroed · bracket at <b>" + (r.pitch === null ? "?" : r.pitch + "°") + "</b> from vertical · " +
      (r.northAlpha === null
        ? "no compass on this phone — heading stays GPS-only."
        : "north captured at <b>" + Math.round(r.northAlpha) + "°</b>. The map now holds its heading at a standstill.");
    renderDiag();
  });
  // Long-press the lean dial itself: after remounting the bracket nobody
  // should have to find a settings row to re-zero. The pager captures the
  // pointer for its swipe handling, which fires a synthetic pointerleave on
  // the dial — so cancellation watches the window and real movement instead.
  {
    let t = 0, sx = 0, sy = 0;
    const dial = document.querySelector(".cell.lean");
    const cancel = () => { clearTimeout(t); t = 0; };
    dial.addEventListener("pointerdown", (e) => {
      sx = e.clientX; sy = e.clientY;
      clearTimeout(t);
      t = setTimeout(recal, 900);
    });
    window.addEventListener("pointerup", cancel);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("pointermove", (e) => {
      if (t && Math.hypot(e.clientX - sx, e.clientY - sy) > 12) cancel();
    });
  }
  $("inv-sw").addEventListener("click", (e) => togSwitch(e.currentTarget, "invertLean"));
  $("crash-sw").addEventListener("click", (e) => togSwitch(e.currentTarget, "crashDetect"));
  $("wake-sw").addEventListener("click", (e) => { const on = togSwitch(e.currentTarget, "wakeLock"); wake(on); });
  $("map-btn").addEventListener("click", (e) => {
    const order = ["auto", "google", "osm"];
    const next = order[(order.indexOf(settings.mapProvider) + 1) % order.length];
    if (next === "google" && !settings.mapKey) { toast("Google needs a key. Set one in Keys first."); return; }
    save({ mapProvider: next });
    e.currentTarget.textContent = mapLabel();
    mapview.swap();
    renderDiag();
  });
  $("edge-btn").addEventListener("click", (e) => {
    const order = ["off", "curved", "wide"];
    const next = order[(order.indexOf(settings.edgeInset) + 1) % order.length];
    save({ edgeInset: next });
    $("app").dataset.edge = next;
    e.currentTarget.textContent = next[0].toUpperCase() + next.slice(1);
    renderDiag();
  });
  $("font-btn").addEventListener("click", (e) => {
    const order = ["auto", "orbitron", "safe"];
    const next = order[(order.indexOf(settings.numeralFont) + 1) % order.length];
    save({ numeralFont: next });
    e.currentTarget.textContent = next === "auto" ? "Auto" : next === "safe" ? "Safe" : "Orbitron";
    dash.verifyNumerals(next);
    dash.calibrateDigits();
    renderDiag();
  });
  $("fx-sw").addEventListener("click", (e) => {
    $("app").dataset.fx = togSwitch(e.currentTarget, "effects") ? "on" : "off";
  });
  $("lim-in").addEventListener("change", (e) => save({ speedLimit: Math.max(20, Math.min(140, +e.target.value || 60)) }));
  $("rl-sw").addEventListener("click", (e) => { togSwitch(e.currentTarget, "roadLimits"); });
  $("odo-in").addEventListener("change", (e) => {
    save({ odoOffset: Math.max(0, Math.min(9999999, Math.round(+e.target.value) || 0)) });
    logs.render();
  });
  $("keys-btn").addEventListener("click", () => { layer("setup"); syncSetup(); });

  /* ---- service editor ---- */
  /* The row's index is its identity: names are editable in principle and
     positions are not, so nothing here is keyed on the label. */
  let svcIdx = -1;

  $("svc").addEventListener("click", (e) => {
    const row = e.target.closest("[data-svc]");
    if (!row) return;
    svcIdx = +row.dataset.svc;
    openSvc();
  });

  function openSvc() {
    const item = logs.service()[svcIdx];
    if (!item) return;
    const odo = logs.odoNow();
    const left = item.every - Math.max(0, odo - (item.last || 0));
    $("svc-name").textContent = String(item.n).toUpperCase();
    $("svc-state").textContent = (left <= 0
      ? "Overdue by " + Math.round(-left).toLocaleString("en-US") + " km."
      : "Due in " + Math.round(left).toLocaleString("en-US") + " km.") +
      " Odometer reads " + odo.toLocaleString("en-US") + " km.";
    $("svc-every").value = item.every;
    $("svc-last").value = item.last || 0;
    layer("svc");
  }

  function writeSvc(patch) {
    const list = logs.service().map((it, i) => (i === svcIdx ? Object.assign({}, it, patch) : it));
    logs.saveService(list);
    logs.render();
    openSvc();
  }

  $("svc-now").addEventListener("click", () => {
    if (svcIdx < 0) return;
    writeSvc({ last: logs.odoNow() });
    toast("Marked done at " + logs.odoNow().toLocaleString("en-US") + " km");
  });
  $("svc-save").addEventListener("click", () => {
    if (svcIdx < 0) return;
    const every = Math.max(100, Math.min(200000, Math.round(+$("svc-every").value) || 1000));
    const last = Math.max(0, Math.min(9999999, Math.round(+$("svc-last").value) || 0));
    writeSvc({ every: every, last: last });
    toast("Saved");
  });
  $("svc-reset").addEventListener("click", () => {
    if (svcIdx < 0) return;
    const def = SERVICE_DEFAULTS[svcIdx];
    if (!def) return;
    writeSvc({ every: def.every });
    toast("Interval back to " + def.every.toLocaleString("en-US") + " km");
  });
  $("svc-close").addEventListener("click", () => layer(""));

  // ---- emergency contacts ----
  $("ice-pick").addEventListener("click", async () => {
    const c = await sos.pick();
    if (!c) { toast(sos.pickerSupported() ? "No contact chosen" : "Picker unavailable — add manually"); return; }
    toast(sos.addContact(c) ? "Added " + c.name : "Already listed, or list full");
    renderContacts();
  });
  $("ice-add").addEventListener("click", () => {
    const box = $("ice-manual");
    box.hidden = !box.hidden;
    if (!box.hidden) $("ice-name").focus();
  });
  $("ice-save").addEventListener("click", () => {
    const ok = sos.addContact({ name: $("ice-name").value, tel: $("ice-tel").value });
    if (!ok) { toast("Need a number, and room on the list"); return; }
    $("ice-name").value = ""; $("ice-tel").value = "";
    $("ice-manual").hidden = true;
    renderContacts();
  });
  $("ice-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".rm");
    if (!btn) return;
    sos.removeContact(btn.dataset.tel);
    renderContacts();
  });
  $("ice-tpl").addEventListener("change", (e) => {
    const v = e.target.value.trim();
    save({ smsTemplate: v || undefined });
    if (!v) e.target.value = sos.template();
  });
  $("ice-test").addEventListener("click", async () => {
    if (!sos.ready()) { toast("Assign a contact first"); return; }
    const r = await sos.deliver(sos.compose(S.lat, S.lng, { test: true }));
    if (r === "unsupported") toast("No share sheet in this browser");
    else if (r === "blocked") toast("Share was blocked");
  });
  $("ch-btns").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    save({ alertChannel: b.dataset.ch });
    renderChannels();
    renderContacts();
  });

  // ---- setup ----
  $("grant-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;          // null after the await resolves
    const gps = sensors.startGPS();
    const mot = await sensors.startMotion();
    btn.textContent = gps && mot ? "Granted" : gps ? "GPS only" : "Denied";
    btn.classList.toggle("ok", gps && mot);
  });
  $("setup-done").addEventListener("click", () => {
    save({
      mapKey: $("map-key").value.trim(),
      mapId: $("map-id").value.trim(),
      spotifyId: $("sp-id").value.trim(),
      setupDone: true
    });
    layer("");
    // Grant is skippable, so Start must also start the sensors — both are
    // idempotent, so tapping Grant first costs nothing.
    sensors.startGPS();
    sensors.startMotion();
    mapview.load();
    wake(settings.wakeLock);
    toast("Ready");
  });

  // ---- spotify ----
  $("sp-connect").addEventListener("click", async () => {
    if (!settings.spotifyId) { toast("Add a Spotify client ID in settings"); return; }
    await spotify.connect();
  });
  $("m-play").addEventListener("click", () => spotify.toggle());
  $("m-next").addEventListener("click", async () => { await spotify.next(); setTimeout(spotify.poll, 400); });
  $("m-prev").addEventListener("click", async () => { await spotify.prev(); setTimeout(spotify.poll, 400); });

  // ---- map follow / recenter ----
  // The map notifies on a drag; the button resumes following.
  /* ---- tagging spots on the map ---- */
  /* Two taps: the button arms it, the map places it. Tapping an existing mark
     removes it instead, which is the only sane thing a second tap on the same
     spot could mean. */
  let tagging = false;

  function setTagging(on) {
    tagging = on;
    $("tag-btn").setAttribute("aria-pressed", String(on));
    $("map-slot").classList.toggle("tagging", on);
  }

  function drawMarks() {
    mapview.setMarks(marks.all(), (id) => {
      marks.remove(id);
      drawMarks();
      toast("Mark removed");
    });
  }

  $("tag-btn").addEventListener("click", () => {
    if (!mapview.ready()) { toast("Map is not up yet"); return; }
    setTagging(!tagging);
    if (tagging) toast("Tap the spot on the map");
  });

  mapview.setTapHandler((lat, lng) => {
    if (!tagging) return;
    setTagging(false);
    const existing = marks.at(lat, lng, 25);
    if (existing) { marks.remove(existing.id); drawMarks(); toast("Mark removed"); return; }
    marks.add(lat, lng);
    drawMarks();
    toast("Marked · " + marks.count() + " on the map");
  });
  marks.setOnChange(drawMarks);
  // Registers whatever was saved from previous rides. The map is not up yet,
  // so this only parks the list with mapview — which pushes it the moment a
  // provider is ready. Without this call a reload showed no marks until one
  // was added or removed.
  drawMarks();

  window.__nmaxMapFollow = (on) => { $("recenter-btn").hidden = on; };
  $("recenter-btn").addEventListener("click", () => {
    mapview.setFollow(true);
    $("recenter-btn").hidden = true;
  });

  // ---- destination search ----
  $("search-btn").addEventListener("click", () => { layer("search"); showResults(null); $("s-input").focus(); });
  $("s-close").addEventListener("click", () => layer(""));
  $("s-pinhere").addEventListener("click", () => {
    if (S.lat === null) { toast("No GPS fix yet"); return; }
    $("s-pinbar").hidden = false;
    $("s-pinname").value = "";
    $("s-pinname").focus();
  });
  $("s-pincancel").addEventListener("click", () => { $("s-pinbar").hidden = true; });
  $("s-pinsave").addEventListener("click", () => {
    const label = $("s-pinname").value.trim();
    if (!label) { toast("Give it a name"); return; }
    const ok = nav.addPin({ label, lat: S.lat, lng: S.lng });
    $("s-pinbar").hidden = true;
    toast(ok ? "Pinned " + label : "Already pinned, or the list is full");
    showResults(null);
  });
  $("s-clear").addEventListener("click", () => {
    nav.clear();
    mapview.setDestination(null);
    showResults(null);
    syncNav();
    toast("Destination cleared");
  });
  $("s-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("s-input").value;
    if (q.trim().length < 3) { showMsg("Type at least three characters."); return; }
    showMsg("Searching…");
    const hits = await nav.search(q);
    if (hits === null) { showMsg("Search failed — check the connection."); return; }
    if (nav.placesStatus()) console.info("Places fell back:", nav.placesStatus());
    if (!hits.length) { showMsg("Nothing found near you."); return; }
    showResults(hits);
  });
  $("s-results").addEventListener("click", (e) => {
    const pinBtn = e.target.closest(".pin");
    if (pinBtn) {
      e.stopPropagation();
      const d = JSON.parse(pinBtn.closest(".s-row").dataset.d);
      if (nav.isPinned(d)) { nav.removePin(d.lat, d.lng); toast("Unpinned"); }
      else { toast(nav.addPin(d) ? "Pinned " + d.label : "Pin list is full"); }
      showResults(lastHits);
      return;
    }
    const row = e.target.closest(".s-row");
    if (!row) return;
    const d = JSON.parse(row.dataset.d);
    nav.setDestination(d);
    mapview.setDestination(d);
    syncNav();
    layer("");
    toast("Heading for " + d.label);
  });

  // ---- crash ----
  $("crash-cancel").addEventListener("click", () => {
    layer("");
    S.crashArmed = false;
    S.crashReady = false;
    S.crashCancel = true;           // tells the watcher to drop its timers too
    $("layer-crash").dataset.phase = "count";
  });
  // The automatic attempt can be refused for want of user activation, so the
  // screen always ends on a button that cannot be.
  $("crash-send").addEventListener("click", async () => {
    const r = await sos.deliver($("crash-body").textContent);
    if (r === "sent" || r === "opened") { layer(""); S.crashReady = false; $("layer-crash").dataset.phase = "count"; }
    else if (r === "nocontact") toast("No contact assigned");
  });

  if (settings.wakeLock) wake(true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && settings.wakeLock) wake(true);
  });

  $("app").dataset.fx = settings.effects ? "on" : "off";
  $("app").dataset.edge = settings.edgeInset;
  syncNav();
  const d0 = nav.destination();
  if (d0) setTimeout(() => mapview.setDestination(d0), 2500);   // after the map is up
  setTheme(settings.theme);
  goto(0);
}

function mapLabel() {
  return settings.mapProvider === "auto"
    ? "Auto · " + (mapview.providerName() === "google" ? "Google" : "OSM")
    : settings.mapProvider === "google" ? "Google" : "OpenStreetMap";
}

function showMsg(text) {
  $("s-results").innerHTML = '<div class="s-msg">' + escapeHtml(text) + "</div>";
}

let lastHits = null;

const PIN_SVG = '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 00-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6a2.5 2.5 0 010 5.5z"/></svg>';

/* Passing null shows the standing lists — pins first, then recents. Passing a
   result set shows that instead, with pins still reachable by their toggles. */
function showResults(hits) {
  lastHits = hits;
  const rows = (list, cls) => list.map((d) => {
    const km = S.lat === null ? "" : '<span class="km">' + nav.fmtDistance(haversineTo(d)) + "</span>";
    const on = nav.isPinned(d) ? " on" : "";
    const src = d.src === "n" ? '<span class="rc">osm</span>' : "";
    return '<button class="s-row" type="button" data-d=\'' + escapeHtml(JSON.stringify({ label: d.label, lat: d.lat, lng: d.lng })) + '\'>' +
      '<span class="nm">' + escapeHtml(d.label) + "</span>" + km + src +
      '<span class="pin' + on + '" role="button" aria-label="Pin">' + PIN_SVG + "</span></button>";
  }).join("");

  if (hits) {
    $("s-results").innerHTML = hits.length
      ? '<div class="s-sec">Results</div>' + rows(hits)
      : '<div class="s-msg">Nothing found.</div>';
    return;
  }

  const pins = nav.pins(), rec = nav.recents().filter((r) => !nav.isPinned(r));
  let html = "";
  if (pins.length) html += '<div class="s-sec">Pinned</div>' + rows(pins);
  if (rec.length) html += '<div class="s-sec">Recent</div>' + rows(rec);
  $("s-results").innerHTML = html || '<div class="s-msg">No pins yet. Search for a place, or tap Pin here to save where you are.</div>';
}

function haversineTo(d) {
  const R = 6371000;
  const dLat = (d.lat - S.lat) * Math.PI / 180, dLng = (d.lng - S.lng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(S.lat * Math.PI / 180) * Math.cos(d.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function syncNav() {
  const href = nav.navigateHref();
  const a = $("s-nav");
  a.hidden = !href;
  if (href) a.href = href;
}

function togSwitch(el, key) {
  const on = !el.classList.contains("on");
  el.classList.toggle("on", on);
  el.setAttribute("aria-pressed", String(on));
  save({ [key]: on });
  return on;
}

/* Turns "it looks wrong" into something reportable, since none of this is
   visible from a phone without devtools attached. */
function renderDiag() {
  const app = $("app");
  const fontOk = app.dataset.font === "orbitron";
  const cs = getComputedStyle(document.documentElement);
  const mapEl = $("map-none");
  const mapState = $("map-slot").classList.contains("live")
    ? '<span class="ok">live</span>'
    : '<span class="bad">' + (mapEl.textContent || "not loaded").slice(0, 60) + "</span>";
  const gps = S.gpsOk ? '<span class="ok">lock</span>' : '<span class="bad">none</span>';
  $("diag").innerHTML =
    "<b>Numerals</b> " + (fontOk ? '<span class="ok">Orbitron</span>' : '<span class="bad">fallback — Orbitron did not load</span>') +
    " · <b>digit</b> " + cs.getPropertyValue("--dw").trim() +
    "<br><b>Map</b> " + mapLabel() + " · " + mapState +
    (mapview.providerName() === "google" ? (settings.mapId ? " · vector" : " · raster, labels rotate") : "") +
    "<br><b>GPS</b> " + gps + " · <b>motion</b> " + (S.lean !== 0 || S.leanRaw !== 0 ? '<span class="ok">yes</span>' : "no movement seen") +
    "<br><b>Spotify</b> " + (S.spotify ? '<span class="ok">connected</span>' : "not connected") +
    "<br><b>Places</b> " + (settings.mapKey
      ? (nav.placesStatus()
          ? '<span class="bad">' + escapeHtml(nav.placesStatus()) + "</span>"
          : '<span class="ok">ready</span>')
      : "no Maps key — using OpenStreetMap search") +
    "<br><b>Directions</b> " + (mapview.providerName() !== "google"
      ? "google map only"
      : (mapview.routeStatus()
          ? '<span class="bad">' + escapeHtml(mapview.routeStatus()) + "</span>"
          : (mapview.routeInfo() ? '<span class="ok">routed</span>' : "no destination"))) +
    "<br><b>OBD</b> " + (obd.status.state === "polling"
      ? '<span class="ok">' + escapeHtml(obd.status.device || "live") + "</span> · " +
        escapeHtml(obd.status.proto || "auto") + " · rpm " + (obd.status.pids.rpm ? "✓" : "✗") +
        " temp " + (obd.status.pids.temp ? "✓" : "✗") + " fuel " + (obd.status.pids.fuel ? "✓" : "✗") +
        (obd.status.volts ? " · " + obd.status.volts.toFixed(1) + " V" : "")
      : obd.status.state === "idle" ? "not connected" : escapeHtml(obd.status.state)) +
    "<br><b>Map mode</b> " + (mapview.providerName() !== "google"
      ? "OpenStreetMap — flat by design"
      : escapeHtml(mapview.mapMode() || "loading")) +
    "<br><b>Marks</b> " + (marks.count() ? marks.count() + " placed" : "none placed") +
    "<br><b>Notifications</b> " + (!alerts.hasShell()
      ? "app only"
      : alerts.listenerOn() ? '<span class="ok">on</span>' : "access not granted") +
    "<br><b>Speed limit</b> " + escapeHtml(speedlimit.status()) +
    "<br><b>Compass</b> " + (sensors.nativeCompass()
      ? '<span class="ok">native sensor</span>'
      : "browser events — slower") +
      (settings.cal && settings.cal.src && settings.cal.src !== (sensors.nativeCompass() ? "native" : "web")
        ? ' <span class="bad">· calibrated on the other source, recalibrate</span>' : "") +
    "<br><b>Mount</b> " + (settings.cal
      ? '<span class="ok">calibrated</span> · ' + (settings.cal.pitch ?? "?") + "° · north " +
        (settings.cal.northAlpha === null ? "n/a" : Math.round(settings.cal.northAlpha) + "°")
      : '<span class="bad">not calibrated — heading is GPS-only</span>') +
    "<br><b>Build</b> " + (window.__swVersion || "unknown") +
    "<br><b>Screen</b> " + innerWidth + "×" + innerHeight +
    " · dpr " + (devicePixelRatio || 1).toFixed(2) +
    " · " + (innerWidth / innerHeight).toFixed(2) + ":1" +
    "<br><b>Installed</b> " + (app.dataset.installed === "yes" ? '<span class="ok">yes</span>' : '<span class="bad">no — browser chrome is over the dash</span>') +
    "<br><b>Edge</b> " + settings.edgeInset + " · <b>refresh</b> " + (window.__hz || "?") + " Hz";
}

function syncSettings() {
  $("inv-sw").classList.toggle("on", settings.invertLean);
  $("crash-sw").classList.toggle("on", settings.crashDetect);
  $("wake-sw").classList.toggle("on", settings.wakeLock);
  $("fx-sw").classList.toggle("on", settings.effects);
  $("rl-sw").classList.toggle("on", settings.roadLimits !== false);
  $("map-btn").textContent = mapLabel();
  $("edge-btn").textContent = settings.edgeInset[0].toUpperCase() + settings.edgeInset.slice(1);
  $("font-btn").textContent = settings.numeralFont === "auto" ? "Auto"
    : settings.numeralFont === "safe" ? "Safe" : "Orbitron";
  $("lim-in").value = settings.speedLimit;
  $("odo-in").value = settings.odoOffset || 0;
  $("ice-tpl").value = sos.template();
  $("ice-pick").hidden = !sos.pickerSupported();
  renderChannels();
  renderContacts();
  renderDiag();
}

function renderChannels() {
  const cur = sos.channel();
  $("ch-btns").innerHTML = sos.CHANNELS
    .filter((c) => c.id !== "share" || sos.shareSupported())
    .map((c) => '<button type="button" data-ch="' + c.id + '" aria-pressed="' +
      (c.id === cur) + '">' + c.label + "</button>").join("");
}

function renderContacts() {
  const list = sos.contacts();
  $("ice-list").innerHTML = list.length
    ? list.map((c, i) =>
        '<div class="ice-row"><span class="nm">' + escapeHtml(c.name) + "</span>" +
        '<span class="tel">' + escapeHtml(c.tel) + "</span>" +
        (i === 0 ? '<span class="pri">first</span>' : "") +
        '<button class="rm" type="button" data-tel="' + escapeHtml(c.tel) +
        '" aria-label="Remove ' + escapeHtml(c.name) + '">&times;</button></div>').join("")
    : '<div class="ice-none">No contact assigned — crash detection has nobody to message.</div>';

  const ch = sos.CHANNELS.find((c) => c.id === sos.channel());
  $("ice-note").textContent =
    sos.channel() !== "sms"
      ? ch.note + " Contacts are only used by SMS."
      : !list.length
        ? "Assign at least one — SMS needs a recipient."
        : "Sends to all " + list.length + ", though some messaging apps take only the first.";
}

function escapeHtml(s) {
  // The apostrophe matters: place names go into single-quoted attributes, so
  // "McDonald's" was terminating the attribute early — breaking the tap on
  // any such result, and opening an injection route through crafted labels.
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function syncSetup() {
  $("map-key").value = settings.mapKey || "";
  $("map-id").value = settings.mapId || "";
  $("sp-id").value = settings.spotifyId || "";
}

export { goto, syncSetup };
