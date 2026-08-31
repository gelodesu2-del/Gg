/* Dashboard rendering. Called once per frame; every write is cheap or
   short-circuited, because this runs while the phone is also holding a GPS
   fix, a Bluetooth radio and a map. */

import { CFG, S, settings } from "./state.js";
import { nearestRough } from "./trips.js";
import * as nav from "./nav.js";
import * as mapview from "./mapview.js";
import * as alerts from "./alerts.js";

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/* Segments in the shift bar. The single row spans the whole dash, so it
   carries the resolution the two-leg version needed 32 for. */
const SEGS = 28;

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
let segCache = [];

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
  $("shift").innerHTML = Array.from({ length: SEGS }, () => '<span class="seg"></span>').join("");

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

  // Speed limit: a roundel under the GPS chip, and the speed itself turns with
  // it, so it reads from whichever half of the screen the eye is already on.
  const over = S.gpsOk && S.speed > settings.speedLimit + 2;
  if (memo.slim !== over) {
    memo.slim = over;
    $("limit").classList.toggle("over", over);
    $("speed").classList.toggle("over", over);
  }
  if (memo.limshow !== true) { memo.limshow = true; $("limit").hidden = false; }
  write($("limit-n"), "textContent", settings.speedLimit, "slimn");

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

  // The sweep runs left to right along the top border. Driven by RPM once a
  // dongle answers; until then by GPS speed, so the bar lives from day one
  // instead of sitting dark until hardware arrives.
  const segs = $("shift").children;
  const N = segs.length;
  let frac = null;
  if (S.rpm !== null) frac = clamp((S.rpm - 3000) / 6300, 0, 1);
  else if (S.gpsOk) frac = clamp(S.speed / 115, 0, 1);
  let lit = frac === null ? 0 : Math.round(frac * N);

  // Warm-up advisor: while the coolant is below target the sweep is capped at
  // a ceiling that rises with temperature — "don't thrash it cold" as a
  // visible limit instead of advice. Needs the dongle: no temp, no ceiling.
  const cold = S.temp !== null && S.temp < CFG.warmC;
  if (cold) {
    const ceil = Math.round(N * (0.28 + 0.5 * clamp((S.temp - 30) / (CFG.warmC - 30), 0, 1)));
    lit = Math.min(lit, ceil);
  }
  if (memo.warm !== cold) { memo.warm = cold; $("warm").classList.toggle("on", cold); }
  for (let i = 0; i < N; i++) {
    const on = i < lit;
    const col = !on ? TH.off : i < N * 0.6 ? TH.neon : i < N * 0.85 ? TH.gold : TH.red;
    if (segCache[i] === col) continue;
    segCache[i] = col;
    segs[i].style.background = col;
    segs[i].style.boxShadow = on ? "0 0 .55em " + col : "none";
  }

  // Engine data, signal by signal — the NMAX's ECU may answer RPM and temp
  // while refusing fuel, and one missing gauge must not blank the others.
  const live = (id, on) => {
    if (memo["lv" + id] === on) return;
    memo["lv" + id] = on;
    const el = $(id).closest(".obd");
    if (el) el.classList.toggle("live", on);
  };

  live("rpm", S.rpm !== null);
  setNum($("rpm"), S.rpm === null ? "—" : Math.round(S.rpm / 10) * 10);

  live("range", S.fuel !== null);
  if (S.fuel === null) {
    write($("range"), "textContent", "—", "rng");
    attr($("range-ring"), "r", "0", "rr");
  } else {
    const range = S.fuel * CFG.kmPerL;
    write($("range"), "textContent", Math.round(range) + " km", "rng");
    attr($("range-ring"), "r", clamp(18 + range / 210 * 74, 14, 96).toFixed(1), "rr");
  }

  live("clt", S.temp !== null);
  if (S.temp === null) {
    write($("clt"), "textContent", "—", "clt");
  } else {
    write($("clt"), "textContent", Math.round(S.temp) + "°C", "clt");
    const hot = S.temp > 108, warmish = S.temp > 100;
    const col = hot ? TH.red : warmish ? TH.gold : "";
    if (memo.cltc !== col) { memo.cltc = col; $("clt").style.color = col; }
  }

  live("volts", S.volts !== null);
  write($("volts"), "textContent", S.volts === null ? "—" : S.volts.toFixed(1) + " V", "volt");

  renderTurn(now);
  renderBand();
  renderAlertBlock();

  // rough road ahead. Published on S so the alerts list can read it too.
  if (now - roughAt > 2500) { roughAt = now; rough = nearestRough(); }
  S.nearJolt = rough;
  const show = !!rough && S.speed > 12;
  if (memo.hole !== show) { memo.hole = show; $("holewarn").classList.toggle("on", show); }
  if (show) write($("holewarn"), "textContent", "Rough road · " + Math.round(rough.d / 5) * 5 + " m", "holet");
}

/* The block where fuel used to be: the worst thing the bike is saying, and a
   count of how many need answering. */
function renderAlertBlock() {
  const s = alerts.summary();
  write($("al-t"), "textContent", s.text, "alt");
  if (memo.alsev !== s.sev) { memo.alsev = s.sev; $("alerts-btn").dataset.sev = s.sev; }
  const n = s.count + alerts.unread();
  if (memo.aln !== n) {
    memo.aln = n;
    $("al-n").hidden = n === 0;
    $("al-n").textContent = n;
  }
}

/* The manoeuvre card. With a route it shows the next turn; with only a pin
   dropped it falls back to the compass bearing, which is still the honest
   answer to "which way now". */
const MANEUVER = {
  left:   "M10 4L4 10l6 6v-4h5a3 3 0 013 3v5h4v-5a7 7 0 00-7-7h-5V4z",
  right:  "M14 4l6 6-6 6v-4H9a3 3 0 00-3 3v5H2v-5a7 7 0 017-7h5V4z",
  arrive: "M12 2a7 7 0 00-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6.5a2.5 2.5 0 010 5z",
  ahead:  "M12 2l7 19-7-5-7 5z"
};

function renderTurn(now) {
  const step = mapview.nextStep ? mapview.nextStep() : null;
  const home = nav.homing();
  const showTurn = !!(step || home);
  if (memo.turnShown !== showTurn) { memo.turnShown = showTurn; $("turn").hidden = !showTurn; }
  if (!showTurn) return;

  if (step) {
    const kind = /left/i.test(step.maneuver) ? "left"
               : /right/i.test(step.maneuver) ? "right"
               : /destination|arrive/i.test(step.maneuver) ? "arrive" : "ahead";
    attr($("turn-p"), "d", MANEUVER[kind], "turnp");
    if (memo.turnRot !== "0") { memo.turnRot = "0"; $("turn-i").style.transform = ""; }
    write($("turn-d"), "textContent", nav.fmtDistance(step.m), "turnd");
    write($("turn-s"), "textContent", step.road || "", "turns");
  } else {
    attr($("turn-p"), "d", MANEUVER.ahead, "turnp");
    const rot = "rotate(" + home.relative.toFixed(0) + "deg)";
    if (memo.turnRot !== rot) { memo.turnRot = rot; $("turn-i").style.transform = rot; }
    write($("turn-d"), "textContent", nav.fmtDistance(home.m), "turnd");
    write($("turn-s"), "textContent", home.label, "turns");
  }
}

/* The band along the bottom. Trip figures by default; a phone notification
   borrows the slot for a few seconds and then gives it straight back. */
function renderBand() {
  const note = alerts.current();
  const showNote = !!note;
  if (memo.bandNote !== showNote) {
    memo.bandNote = showNote;
    $("slot-note").hidden = !showNote;
    $("slot-trip").hidden = showNote;
  }
  if (showNote) {
    write($("n-app"), "textContent", (note.app || "?").slice(0, 1).toUpperCase(), "napp");
    write($("n-k"), "textContent", note.app || "Phone", "nk");
    write($("n-t"), "textContent", note.title || note.app || "", "nt");
    write($("n-m"), "textContent", note.body || "", "nm");
    write($("n-age"), "textContent", alerts.fmtAge(note.at), "nage");
    return;
  }

  const ri = mapview.routeInfo();
  const hasRoute = !!ri;
  if (memo.bandEta !== hasRoute) {
    memo.bandEta = hasRoute;
    $("ts-eta").hidden = !hasRoute;
    $("ts-left").hidden = !hasRoute;
  }
  if (hasRoute) {
    // Date.now, not the frame timestamp: an arrival time built from
    // milliseconds-since-page-load lands in 1970.
    const at = new Date(Date.now() + ri.s * 1000);
    write($("eta"), "textContent",
      String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0"), "eta");
    write($("dleft"), "textContent", nav.fmtDistance(ri.m), "dleft");
  }
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
