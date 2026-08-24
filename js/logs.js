/* Logs rendering. Rebuilt on demand rather than per frame — the underlying
   data only changes when a trip closes or a theme swaps. */

import { settings, SERVICE_DEFAULTS } from "./state.js";
import * as store from "./store.js";
import * as trips from "./trips.js";
import { readTheme } from "./dash.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n) => n.toLocaleString("en-US");
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function when(ts) {
  const d = new Date(ts);
  return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()] +
         " · " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

/* Route thumbnail from the recorded points, normalised into the box. */
function thumb(pts, colour) {
  if (!pts || pts.length < 2) return '<div class="thumb"></div>';
  const lats = pts.map((p) => p[0]), lngs = pts.map((p) => p[1]);
  const y0 = Math.min(...lats), y1 = Math.max(...lats);
  const x0 = Math.min(...lngs), x1 = Math.max(...lngs);
  const sx = (x1 - x0) || 1e-6, sy = (y1 - y0) || 1e-6;
  const s = Math.max(sx, sy);
  const P = pts.map((p) => (6 + ((p[1] - x0) / s) * 84).toFixed(1) + " " + (40 - ((p[0] - y0) / s) * 34).toFixed(1));
  return '<svg class="thumb" viewBox="0 0 96 46" preserveAspectRatio="none" aria-hidden="true">' +
         '<polyline points="' + P.join(" ") + '" fill="none" stroke="' + colour + '" stroke-width="1.6" opacity=".85"/></svg>';
}

export function render() {
  const TH = readTheme();
  const all = trips.trips();

  // ---- this week ----
  const weekAgo = Date.now() - 7 * 864e5;
  const wk = all.filter((t) => t.start > weekAgo);
  const km = wk.reduce((s, t) => s + (t.km || 0), 0);
  const min = wk.reduce((s, t) => s + (t.min || 0), 0);
  const lean = wk.length ? Math.max(...wk.map((t) => t.maxLean || 0)) : 0;
  $("wk").innerHTML =
    card("This week", km.toFixed(1), "km") +
    card("Rides", wk.length, "") +
    card("Time", Math.floor(min / 60) + ":" + String(min % 60).padStart(2, "0"), "") +
    card("Max lean", Math.round(lean), "°");

  $("trips").innerHTML = all.length
    ? all.slice(0, 40).map((t) =>
        '<article class="trip">' + thumb(t.pts, TH.neon) +
        '<div><span class="when">' + when(t.start) + "</span>" +
        '<span class="dist">' + (t.km || 0).toFixed(1) + " km · " + (t.min || 0) + ' min</span>' +
        '<span class="st">avg <b>' + (t.avg || 0) + "</b> · max <b>" + Math.round(t.maxSpeed || 0) +
        "</b> · lean <b>" + Math.round(t.maxLean || 0) + "°</b> · " + (t.jolts || 0) + " jolts</span></div></article>"
      ).join("")
    : '<div class="empty"><b>No rides yet.</b>A trip opens once you have been moving for a few seconds and closes after a two-minute stop, so traffic lights will not shred one commute into twenty.</div>';

  // ---- roads ----
  const rs = trips.routes();
  if (rs.length < 2) {
    $("verdict").innerHTML = rs.length
      ? "One route scored so far. <i>Ride an alternative a couple of times and this compares them.</i>"
      : "<i>Nothing to compare yet. Routes need at least two runs of the same start and end before the average means anything.</i>";
    $("routes").innerHTML = "";
  } else {
    const best = rs[0], worst = rs[rs.length - 1];
    const maxJ = worst.score || 1;
    $("verdict").innerHTML =
      "<b>" + esc(best.name) + "</b> is " + Math.round((1 - best.score / maxJ) * 100) +
      "% smoother than <b>" + esc(worst.name) + "</b> — " +
      (best.avgKm - worst.avgKm >= 0 ? "+" : "") + (best.avgKm - worst.avgKm).toFixed(1) + " km and " +
      (best.avgMin - worst.avgMin >= 0 ? "+" : "") + (best.avgMin - worst.avgMin) + " min. " +
      "<i>Based on " + rs.reduce((s, r) => s + r.rides, 0) + " logged rides.</i>";
    $("routes").innerHTML = rs.map((r) => {
      const c = r.score > maxJ * 0.75 ? TH.red : r.score > maxJ * 0.45 ? TH.gold : TH.neon;
      return '<div class="route' + (r === best ? " best" : "") + '">' +
        '<div class="rhead"><span class="rname">' + esc(r.name) +
        (r === best ? "<em>smoothest</em>" : "") + "</span>" +
        '<span class="rscore">' + r.score.toFixed(1) + "<small>jolts/km</small></span></div>" +
        '<div class="rbar"><i style="width:' + (r.score / maxJ * 100).toFixed(1) + "%;background:" + c + '"></i></div>' +
        '<div class="rmeta"><b>' + r.avgKm.toFixed(1) + " km</b> · <b>" + r.avgMin + " min</b> · " + r.rides + " rides</div></div>";
    }).join("");
  }

  const spots = trips.roughSpots();
  $("rough").innerHTML = spots.length
    ? spots.map((g) =>
        '<div class="rrow"><span class="g">' + g.lat.toFixed(4) + ", " + g.lng.toFixed(4) +
        '</span><span class="n">' + g.n + "</span></div>").join("")
    : '<div class="empty"><b>Nothing logged.</b>Every hard vertical jolt gets pinned to where it happened. Ride the same roads for a week and the worst stretches surface here on their own.</div>';

  // ---- service ----
  const odo = Math.round(trips.odometer() + (settings.odoOffset || 0));
  $("odo").innerHTML = fmt(odo) + "<small>km</small>";
  const svc = store.get("service", SERVICE_DEFAULTS);
  $("svc").innerHTML = svc.map((s) => {
    const done = Math.max(0, odo - (s.last || 0));
    const pct = done / s.every * 100;
    const left = s.every - done;
    const cls = pct >= 100 ? " over" : pct >= 85 ? " warn" : "";
    const due = left <= 0 ? "overdue by " + fmt(-left) + " km" : "due in " + fmt(left) + " km";
    return '<div class="svcrow' + cls + '"><div class="svchead"><span class="n">' + esc(s.n) + "</span>" +
      '<span class="due">' + due + "</span></div>" +
      '<div class="svcbar"><i style="width:' + Math.min(100, pct).toFixed(1) + '%"></i></div></div>';
  }).join("");
}

function card(k, v, u) {
  return '<div class="wkc"><span class="k">' + k + '</span><span class="v">' + v +
         (u ? "<small>" + u + "</small>" : "") + "</span></div>";
}
