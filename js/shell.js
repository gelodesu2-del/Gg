/* Chrome around the two panes: paging, tabs, settings, themes, wake lock. */

import { S, settings, save } from "./state.js";
import * as dash from "./dash.js";
import * as logs from "./logs.js";
import * as sensors from "./sensors.js";
import * as spotify from "./spotify.js";
import * as gmap from "./gmap.js";
import * as sos from "./sos.js";

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
  logs.render();
}

export function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("on"), 2600);
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
  $("set-close").addEventListener("click", () => layer(""));
  $("cal-btn").addEventListener("click", () => { sensors.calibrateLean(); toast("Lean zeroed"); });
  $("inv-sw").addEventListener("click", (e) => togSwitch(e.currentTarget, "invertLean"));
  $("crash-sw").addEventListener("click", (e) => togSwitch(e.currentTarget, "crashDetect"));
  $("wake-sw").addEventListener("click", (e) => { const on = togSwitch(e.currentTarget, "wakeLock"); wake(on); });
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
  $("ice-test").addEventListener("click", () => {
    if (!sos.contacts().length) { toast("Assign a contact first"); return; }
    sos.send(sos.compose(S.lat, S.lng, { test: true }));
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
      spotifyId: $("sp-id").value.trim(),
      setupDone: true
    });
    layer("");
    gmap.load();
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

  // ---- crash ----
  $("crash-cancel").addEventListener("click", () => { layer(""); S.crashArmed = false; });

  if (settings.wakeLock) wake(true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && settings.wakeLock) wake(true);
  });

  setTheme(settings.theme);
  goto(0);
}

function togSwitch(el, key) {
  const on = !el.classList.contains("on");
  el.classList.toggle("on", on);
  el.setAttribute("aria-pressed", String(on));
  save({ [key]: on });
  return on;
}

function syncSettings() {
  $("inv-sw").classList.toggle("on", settings.invertLean);
  $("crash-sw").classList.toggle("on", settings.crashDetect);
  $("wake-sw").classList.toggle("on", settings.wakeLock);
  $("lim-in").value = settings.speedLimit;
  $("ice-tpl").value = sos.template();
  $("ice-pick").hidden = !sos.pickerSupported();
  renderContacts();
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

  $("ice-note").textContent = !list.length
    ? "Assign at least one."
    : sos.pickerSupported()
      ? "Sends to all " + list.length + ", though some messaging apps take only the first."
      : "This browser has no contact picker, so numbers are entered by hand.";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function syncSetup() {
  $("map-key").value = settings.mapKey || "";
  $("sp-id").value = settings.spotifyId || "";
}

export { goto, syncSetup };
