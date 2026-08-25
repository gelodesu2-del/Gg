/* Dashboard rendering. Called once per frame; every write is cheap or
   short-circuited, because this runs while the phone is also holding a GPS
   fix, a Bluetooth radio and a map. */

import { CFG, S, settings } from "./state.js";
import { nearestRough } from "./trips.js";
import * as nav from "./nav.js";
import * as mapview from "./mapview.js";

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const PIPS = 12;

let TH = {};
let roughAt = 0;
let rough = null;

/* Every write below used to happen 60 times a second whether or not the value
   had changed. Profiling on a throttled CPU put that at roughly a third of the
   frame budget, so each one is now gated on the value actually moving. */
const memo = Object.create(null);
function write(el, prop, val, key) {
  if (memo[key] === val) return;
  memo[key] = val;
  el[prop] = val;
}
function attr(el, name, val, key) {
  if (memo[key] === val) return;
  memo[key] = val;
  el.setAttribute(name, val);
}
let segCache = [], pipCache = [];

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
  segCache = [];
  pipCache = [];
  for (const k in memo) delete memo[k];
  return TH;
}

/* Orbitron has proportional digits, so each character gets a box sized to the
   widest glyph the loaded font actually has, measured rather than guessed. */
/* Orbitron rendered as notdef boxes on a real phone — the family resolved but
   no glyphs came with it. Rather than trust that it loaded, check, and switch
   the whole app to a face we have seen work if it did not. */
export function verifyNumerals(force) {
  // document.fonts.check reports true whenever the family is merely declared,
  // which it was on the phone that rendered notdef boxes. Measuring is the
  // only reliable signal: if a string of digits comes out exactly as wide as
  // the generic fallback, the face never actually took.
  let ok = false;
  try {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;left:-9999px;top:0;white-space:pre;font-size:100px";
    probe.textContent = "0123456789";
    document.body.appendChild(probe);
    probe.style.fontFamily = "monospace";
    const base = probe.getBoundingClientRect().width;
    probe.style.fontFamily = '"Orbitron", monospace';
    const test = probe.getBoundingClientRect().width;
    probe.remove();
    ok = Math.abs(test - base) > 1 && test > 0;
  } catch (e) {
    ok = false;
  }
  // Detecting a font that loads but renders blanks is not reliably possible,
  // so the setting can override this either way.
  if (force === "safe") ok = false;
  if (force === "orbitron") ok = true;
  document.getElementById("app").dataset.font = ok ? "orbitron" : "fallback";
  return ok;
}

export function calibrateDigits() {
  const fam = document.getElementById("app").dataset.font === "fallback"
    ? getComputedStyle(document.documentElement).getPropertyValue("--f-num-safe")
    : "Orbitron, sans-serif";
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;left:-9999px;top:0;white-space:pre;font-size:200px;font-family:" + fam;
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
  $("shift-v").innerHTML = Array.from({ length: 12 }, () => '<span class="seg"></span>').join("");
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

  // Rebuilding these through innerHTML every frame cost about 25% of the
  // budget on its own. Two nodes, moved by attribute instead.
  $("peaks").innerHTML =
    '<circle class="pk" id="pk-l" r="2.8" opacity="0"/><circle class="pk" id="pk-r" r="2.8" opacity="0"/>';
  segCache = [];
  pipCache = [];
}

/* Runs every frame: only what the eye tracks continuously. */
export function renderFast() {
  const a = clamp(S.lean, -LEAN.max, LEAN.max);
  const [px0, py0] = lpt(0, LEAN.r), [px1, py1] = lpt(a, LEAN.r);
  const d = Math.abs(a) < 0.4 ? ""
    : `M${px0.toFixed(2)} ${py0.toFixed(2)}A${LEAN.r} ${LEAN.r} 0 0 ${a > 0 ? 1 : 0} ${px1.toFixed(2)} ${py1.toFixed(2)}`;
  attr($("lean-arc"), "d", d, "arcd");
  attr($("lean-glow"), "d", d, "glowd");
  attr($("lean-mark"), "transform", `rotate(${a.toFixed(1)} ${LEAN.cx} ${LEAN.cy})`, "mark");

  const hot = Math.abs(a) > 40;
  attr($("lean-arc"), "stroke", hot ? TH.gold : TH.neon, "arcc");
  attr($("lean-glow"), "stroke", hot ? "rgba(255,184,51,.26)" : TH.glow(".26"), "glowc");
  write($("lean-val"), "textContent", String(Math.abs(Math.round(a))).padStart(2, "0") + "°", "lv");
  write($("lean-side"), "textContent", a < -2 ? "LEFT" : a > 2 ? "RIGHT" : "UPRIGHT", "ls");
}

/* Runs a dozen times a second: everything a rider reads rather than watches. */
export function renderSlow(now) {
  setNum($("speed"), S.gpsOk ? Math.round(S.speed) : "––");
  write($("lock"), "textContent", !S.gpsOk ? "…" : (now - S.lastFix > 6000 ? "LOST" : "LOCK"), "lock");

  const over = S.gpsOk && S.speed > settings.speedLimit + 2;
  if (memo.slim !== over) { memo.slim = over; $("slim").classList.toggle("on", over); }
  write($("slim-n"), "textContent", settings.speedLimit, "slimn");

  // peak hold
  const L = S.maxL > 3 ? Math.min(S.maxL, LEAN.max) : null;
  const R = S.maxR > 3 ? Math.min(S.maxR, LEAN.max) : null;
  if (memo.pkl !== L) {
    memo.pkl = L;
    const e = $("pk-l");
    if (L === null) e.setAttribute("opacity", "0");
    else { const [x, y] = lpt(-L, LEAN.r); e.setAttribute("cx", x.toFixed(1)); e.setAttribute("cy", y.toFixed(1)); e.setAttribute("opacity", ".55"); }
  }
  if (memo.pkr !== R) {
    memo.pkr = R;
    const e = $("pk-r");
    if (R === null) e.setAttribute("opacity", "0");
    else { const [x, y] = lpt(R, LEAN.r); e.setAttribute("cx", x.toFixed(1)); e.setAttribute("cy", y.toFixed(1)); e.setAttribute("opacity", ".55"); }
  }
  write($("peak-l"), "textContent", "L " + String(Math.round(S.maxL)).padStart(2, "0"), "pl");
  write($("peak-r"), "textContent", "R " + String(Math.round(S.maxR)).padStart(2, "0"), "pr");

  // The sweep: across the top, then down the right edge. Driven by RPM once
  // a dongle answers; until then by GPS speed, so the bar lives from day one
  // instead of sitting dark until hardware arrives.
  const segs = [...$("shift").children, ...$("shift-v").children];
  const N = segs.length;
  let frac = null;
  if (S.rpm !== null) frac = clamp((S.rpm - 3000) / 6300, 0, 1);
  else if (S.gpsOk) frac = clamp(S.speed / 115, 0, 1);
  const lit = frac === null ? 0 : Math.round(frac * N);
  for (let i = 0; i < N; i++) {
    const on = i < lit;
    const col = !on ? TH.off : i < N * 0.6 ? TH.neon : i < N * 0.85 ? TH.gold : TH.red;
    if (segCache[i] === col) continue;
    segCache[i] = col;
    segs[i].style.background = col;
    segs[i].style.boxShadow = on ? "0 0 .55em " + col : "none";
  }

  // engine data, absent until a dongle answers. Written once, not every frame.
  if (S.rpm === null) {
    const pips = $("pips").children;
    for (let i = 0; i < pips.length; i++) {
      if (pipCache[i] === TH.off) continue;
      pipCache[i] = TH.off;
      pips[i].style.background = TH.off;
      pips[i].style.boxShadow = "none";
    }
    setNum($("rpm"), "—");
    setNum($("fuel-v"), "—");
    write($("range"), "textContent", "—", "rng");
    write($("clt"), "textContent", "—", "clt");
    attr($("range-ring"), "r", "0", "rr");
    if (memo.warm !== false) { memo.warm = false; $("warm").classList.remove("on"); }
  }

  // destination homing — how far, and which way from the saddle
  const home = nav.homing();
  if (memo.toShown !== !!home) { memo.toShown = !!home; $("to-chip").hidden = !home; }
  if (home) {
    // Road distance and time when a route came back; straight-line otherwise.
    const ri = mapview.routeInfo();
    write($("to-dist"), "textContent",
      ri ? nav.fmtDistance(ri.m) + " · " + Math.max(1, Math.round(ri.s / 60)) + " min"
         : nav.fmtDistance(home.m), "tod");
    write($("to-name"), "textContent", home.label, "ton");
    // transform as an attribute does not apply to an outer <svg>; CSS does.
    const rot = "rotate(" + home.relative.toFixed(0) + "deg)";
    if (memo.toa !== rot) { memo.toa = rot; $("to-arrow").style.transform = rot; }
  }

  // rough road ahead
  if (now - roughAt > 2500) { roughAt = now; rough = nearestRough(); }
  const show = !!rough && S.speed > 12;
  if (memo.hole !== show) { memo.hole = show; $("holewarn").classList.toggle("on", show); }
  if (show) write($("holewarn"), "textContent", "Rough road · " + Math.round(rough.d / 5) * 5 + " m", "holet");
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
