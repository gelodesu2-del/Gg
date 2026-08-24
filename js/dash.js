/* Dashboard rendering. Called once per frame; every write is cheap or
   short-circuited, because this runs while the phone is also holding a GPS
   fix, a Bluetooth radio and a map. */

import { CFG, S, settings } from "./state.js";
import { nearestRough } from "./trips.js";

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const PIPS = 12;

let TH = {};
let roughAt = 0;
let rough = null;

export function readTheme() {
  const cs = getComputedStyle(document.getElementById("app"));
  const g = (n) => cs.getPropertyValue(n).trim();
  TH = {
    neon: "rgb(" + g("--neon-rgb") + ")",
    gold: "rgb(" + g("--gold-rgb") + ")",
    red: "rgb(" + g("--red-rgb") + ")",
    mint: "rgb(" + g("--mint-rgb") + ")",
    off: g("--off") || "#12151B",
    glow: (a) => "rgba(" + g("--neon-rgb") + "," + a + ")"
  };
  return TH;
}

/* Orbitron has proportional digits, so each character gets a box sized to the
   widest glyph the loaded font actually has, measured rather than guessed. */
export function calibrateDigits() {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;left:-9999px;top:0;white-space:pre;font-family:Orbitron,sans-serif;font-size:200px";
  document.body.appendChild(probe);
  const widest = (w) => {
    probe.style.fontWeight = w;
    let m = 0;
    for (let d = 0; d <= 9; d++) { probe.textContent = String(d); m = Math.max(m, probe.getBoundingClientRect().width); }
    return m / 200;
  };
  const w7 = widest(700), w8 = widest(800);
  probe.style.fontWeight = 700;
  probe.textContent = ".";
  const dot = probe.getBoundingClientRect().width / 200;
  probe.remove();
  const r = document.documentElement.style;
  r.setProperty("--dw", w7.toFixed(4) + "em");
  r.setProperty("--dw8", w8.toFixed(4) + "em");
  r.setProperty("--dotw", dot.toFixed(4) + "em");
}

function setNum(el, str) {
  str = String(str);
  if (el.dataset.v === str) return;
  el.dataset.v = str;
  let h = "";
  for (const c of str) h += '<i data-c="' + c + '">' + c + "</i>";
  el.innerHTML = h;
}

const LEAN = { cx: 100, cy: 80, r: 70, max: CFG.leanMax };
const lpt = (deg, rad) => [
  LEAN.cx + rad * Math.cos((deg - 90) * Math.PI / 180),
  LEAN.cy + rad * Math.sin((deg - 90) * Math.PI / 180)
];

export function build() {
  $("shift").innerHTML = Array.from({ length: 20 }, () => '<span class="seg"></span>').join("");
  $("pips").innerHTML = Array.from({ length: PIPS }, () => '<span class="pip"></span>').join("");

  const [x0, y0] = lpt(-LEAN.max, LEAN.r), [x1, y1] = lpt(LEAN.max, LEAN.r);
  $("lean-track").setAttribute("d",
    `M${x0.toFixed(2)} ${y0.toFixed(2)}A${LEAN.r} ${LEAN.r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`);

  let t = "";
  [-45, -30, -15, 0, 15, 30, 45].forEach((v) => {
    const [a1, b1] = lpt(v, 56), [a2, b2] = lpt(v, v === 0 ? 46 : 50);
    t += `<line x1="${a1.toFixed(1)}" y1="${b1.toFixed(1)}" x2="${a2.toFixed(1)}" y2="${b2.toFixed(1)}"/>`;
  });
  $("lean-ticks").innerHTML = t;
}

export function render(now) {
  // ---- speed ----
  setNum($("speed"), S.gpsOk ? Math.round(S.speed) : "––");
  $("lock").textContent = !S.gpsOk ? "…" : (now - S.lastFix > 6000 ? "LOST" : "LOCK");
  $("hdg").textContent = S.gpsOk ? String(Math.round(S.heading)).padStart(3, "0") + "°" : "—";

  // ---- speed limit, soft ----
  $("slim").classList.toggle("on", S.gpsOk && S.speed > settings.speedLimit + 2);
  $("slim-n").textContent = settings.speedLimit;

  // ---- lean ----
  const a = clamp(S.lean, -LEAN.max, LEAN.max);
  const [px0, py0] = lpt(0, LEAN.r), [px1, py1] = lpt(a, LEAN.r);
  const d = Math.abs(a) < 0.4 ? ""
    : `M${px0.toFixed(2)} ${py0.toFixed(2)}A${LEAN.r} ${LEAN.r} 0 0 ${a > 0 ? 1 : 0} ${px1.toFixed(2)} ${py1.toFixed(2)}`;
  const hot = Math.abs(a) > 40;
  $("lean-arc").setAttribute("d", d);
  $("lean-glow").setAttribute("d", d);
  $("lean-arc").setAttribute("stroke", hot ? TH.gold : TH.neon);
  $("lean-glow").setAttribute("stroke", hot ? "rgba(255,184,51,.26)" : TH.glow(".26"));
  $("lean-mark").setAttribute("transform", `rotate(${a.toFixed(2)} ${LEAN.cx} ${LEAN.cy})`);
  $("lean-val").textContent = String(Math.abs(Math.round(a))).padStart(2, "0") + "°";
  $("lean-side").textContent = a < -2 ? "LEFT" : a > 2 ? "RIGHT" : "UPRIGHT";

  let pk = "";
  if (S.maxL > 3) { const [x, y] = lpt(-Math.min(S.maxL, LEAN.max), LEAN.r); pk += `<circle class="pk" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.8" opacity=".55"/>`; }
  if (S.maxR > 3) { const [x, y] = lpt(Math.min(S.maxR, LEAN.max), LEAN.r); pk += `<circle class="pk" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.8" opacity=".55"/>`; }
  $("peaks").innerHTML = pk;
  $("peak-l").textContent = "L " + String(Math.round(S.maxL)).padStart(2, "0");
  $("peak-r").textContent = "R " + String(Math.round(S.maxR)).padStart(2, "0");

  // ---- engine data, absent until a dongle answers ----
  const segs = $("shift").children;
  if (S.rpm === null) {
    for (const el of segs) { el.style.background = TH.off; }
    setNum($("rpm"), "—");
    setNum($("fuel-v"), "—");
    for (const el of $("pips").children) el.style.background = TH.off;
    $("range").textContent = "—";
    $("clt").textContent = "—";
    $("range-ring").setAttribute("r", "0");
    $("warm").classList.remove("on");
  }

  // ---- rough road ahead ----
  if (now - roughAt > 1500) { roughAt = now; rough = nearestRough(); }
  const show = !!rough && S.speed > 12;
  $("holewarn").classList.toggle("on", show);
  if (show) $("holewarn").textContent = "Rough road · " + Math.round(rough.d / 5) * 5 + " m";
}

/* Spotify block. Kept out of the frame loop — it only changes when a poll
   comes back, which is every few seconds. */
export function renderSpotify() {
  const sp = S.spotify;
  const media = $("media");
  if (!sp) { media.dataset.sp = "off"; return; }
  media.dataset.sp = "on";
  if (sp.idle) {
    $("m-t").textContent = "Nothing playing";
    $("m-a").textContent = "—";
    $("m-prog").style.width = "0%";
    return;
  }
  $("m-t").textContent = sp.title;
  $("m-a").textContent = sp.artist;
  $("m-time").textContent = Math.floor(sp.ms / 60000) + ":" + String(Math.floor(sp.ms / 1000) % 60).padStart(2, "0");
  $("m-prog").style.width = (sp.ms / sp.dur * 100).toFixed(1) + "%";
  $("m-icon").setAttribute("d", sp.playing ? "M7 5h4v14H7zM13 5h4v14h-4z" : "M8 5v14l11-7z");
  const art = $("m-art");
  if (sp.art && art.dataset.url !== sp.art) {
    art.dataset.url = sp.art;
    art.style.backgroundImage = 'url("' + sp.art + '")';
  }
}
