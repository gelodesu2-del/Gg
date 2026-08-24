/* Destination search and homing.

   Geocoding is Nominatim, which is free, needs no key and works whichever map
   provider is selected — so search does not become another thing to enable and
   pay for. Its usage policy asks for light, human-paced traffic: requests are
   debounced and only fire on submit, never per keystroke.

   Turn-by-turn is deliberately not built here. Handing the destination to the
   Google Maps app gives voice guidance, live traffic and rerouting for free,
   all of which beat anything this dash could draw. What the dash keeps is the
   thing you actually glance at mid-ride: how far, and which way. */

import { S } from "./state.js";
import * as store from "./store.js";
import { haversine } from "./sensors.js";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
let dest = store.get("dest", null);

export function destination() { return dest; }

export function setDestination(d) {
  dest = d;
  store.set("dest", d);
  if (d) {
    const recents = store.get("recents", []).filter((r) => r.label !== d.label);
    recents.unshift(d);
    if (recents.length > 8) recents.length = 8;
    store.set("recents", recents);
  }
}

export function clear() { dest = null; store.del("dest"); }
export function recents() { return store.get("recents", []); }

export async function search(query) {
  const q = query.trim();
  if (q.length < 3) return [];
  const url = NOMINATIM + "?" + new URLSearchParams({
    q, format: "jsonv2", limit: "6", addressdetails: "0",
    // Bias to where the rider is, so "Ayala" finds the near one.
    ...(S.lat !== null ? { viewbox: box(), bounded: "0" } : {})
  });
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const j = await res.json();
    return j.map((r) => ({
      label: shortName(r.display_name),
      full: r.display_name,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon)
    }));
  } catch (e) {
    return null;
  }
}

function box() {
  const d = 0.45;                       // roughly 50 km, enough for one metro
  return [S.lng - d, S.lat + d, S.lng + d, S.lat - d].map((n) => n.toFixed(4)).join(",");
}

/* Nominatim returns the full postal chain. The first two parts are what a
   rider would recognise; the province and postcode are noise on a dash. */
function shortName(s) {
  return s.split(",").slice(0, 2).join(",").trim();
}

/* Distance in metres and the bearing to steer, relative to current heading —
   so the arrow points where the destination actually is from the saddle. */
export function homing() {
  if (!dest || S.lat === null) return null;
  const here = { lat: S.lat, lng: S.lng };
  const m = haversine(here, dest);

  const φ1 = S.lat * Math.PI / 180, φ2 = dest.lat * Math.PI / 180;
  const Δλ = (dest.lng - S.lng) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;

  return { m, bearing, relative: (bearing - S.heading + 540) % 360 - 180, label: dest.label };
}

export function fmtDistance(m) {
  return m < 950 ? Math.round(m / 10) * 10 + " m" : (m / 1000).toFixed(m < 9500 ? 1 : 0) + " km";
}

/* Hands the destination to the Maps app for actual navigation. */
export function navigateHref() {
  if (!dest) return null;
  return "https://www.google.com/maps/dir/?api=1&travelmode=two_wheeler&destination=" +
         encodeURIComponent(dest.lat + "," + dest.lng);
}
