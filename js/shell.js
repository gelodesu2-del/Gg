/* Chrome around the two panes: paging, tabs, settings, themes, wake lock. */

import { S, settings, save } from "./state.js";
import * as dash from "./dash.js";
import * as logs from "./logs.js";
import * as sensors from "./sensors.js";
import * as spotify from "./spotify.js";
import * as mapview from "./mapview.js";
import * as sos from "./sos.js";
import * as nav from "./nav.js";

const $ = (id) => document.getElementById(id);
const THEMES = [
  ["emerald", "#00F58C", "#FFB833"], ["ion", "#00F0FF", "#FF2E97"],
  ["amber", "#FFB020", "#FF7A1A"],   ["violet", "#A97BFF", "#FF7ADF"],
  ["mono", "#E8EDF2", "#B0B8C2"],    ["crimson", "#FF4757", "#FFB833"]
];

let page = 0, sx = 0, sy = 0, axis = null, dx = 0, wakeRef = null;

export function setTheme(name) {
  $("app").dataset.theme = name;
  save({ theme: name });
  dash.readTheme();
  document.querySelectorAll(".sw-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.theme === name)));
  mapview.restyle();          // the map follows the theme too
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

export function layer(name) {
  document.querySelectorAll(".layer").forEach((l) => l.classList.toggle("on", l.id === "layer-" + name));
}

function goto(p) {
  page = Math.max(0, Math.min(1, p));
  $("pager").style.transform = "translateX(" + (-page * 100) + "%)";
  [...$("dots").children].forEach((d, i) => d.classList.toggle("on", i === page));
  if (page === 1) logs.render();
}

async function wake(on) {
  try {
    if (on && "wakeLock" in navigator) wakeRef = await navigator.wakeLock.request("screen");
    else if (wakeRef) { await wakeRef.release(); wakeRef = null; }
  } catch (e) { /* denied or unsupported; the dash still runs */ }
}

export function init() {
  // ---- theme swatches ----
  $("swatches").innerHTML = THEMES.map(([n, a, b]) =>
    '<button class="sw-btn" type="button" data-theme="' + n + '" title="' + n +
    '"><i style="background:' + a + '"></i><i style="background:' + b + '"></i></button>').join("");
  document.querySelectorAll(".sw-btn").forEach((b) => b.addEventListener("click", () => setTheme(b.dataset.theme)));

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

  // ---- logs tabs ----
  document.querySelectorAll(".logs-tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".logs-tabs button").forEach((o) => o.setAttribute("aria-selected", String(o === b)));
      document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("on", p.dataset.tab === b.dataset.tab));
    }));

  // ---- settings ----
  $("gear").addEventListener("click", () => { syncSettings(); layer("settings"); });
  $("update").addEventListener("click", () => location.reload());
  $("set-close").addEventListener("click", () => layer(""));
  $("cal-btn").addEventListener("click", () => { sensors.calibrateLean(); toast("Lean zeroed"); });
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
  $("keys-btn").addEventListener("click", () => { layer("setup"); syncSetup(); });

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
    const gps = sensors.startGPS();
    const mot = await sensors.startMotion();
    e.currentTarget.textContent = gps && mot ? "Granted" : gps ? "GPS only" : "Denied";
    e.currentTarget.classList.toggle("ok", gps && mot);
  });
  $("setup-done").addEventListener("click", () => {
    save({
      mapKey: $("map-key").value.trim(),
      mapId: $("map-id").value.trim(),
      spotifyId: $("sp-id").value.trim(),
      setupDone: true
    });
    layer("");
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
  $("map-btn").textContent = mapLabel();
  $("edge-btn").textContent = settings.edgeInset[0].toUpperCase() + settings.edgeInset.slice(1);
  $("font-btn").textContent = settings.numeralFont === "auto" ? "Auto"
    : settings.numeralFont === "safe" ? "Safe" : "Orbitron";
  $("lim-in").value = settings.speedLimit;
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
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function syncSetup() {
  $("map-key").value = settings.mapKey || "";
  $("map-id").value = settings.mapId || "";
  $("sp-id").value = settings.spotifyId || "";
}

export { goto, syncSetup };
