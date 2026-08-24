/* Destination search and homing.

   Two geocoders, tried in order. Google Places is far better at businesses —
   the small, new and informally named places Nominatim simply does not carry —
   so it goes first whenever a Maps key is present. Nominatim is the fallback,
   and remains the whole story when there is no key: free, no account, strong
   on streets, barangays and landmarks.

   The fallback is silent by design. If the Places API has not been enabled on
   the project the call fails, Nominatim answers instead, and search keeps
   working rather than presenting an error the rider cannot act on mid-ride.

   Turn-by-turn is deliberately not built here. Handing the destination to the
   Google Maps app gives voice guidance, live traffic and rerouting for free,
   all of which beat anything this dash could draw. What the dash keeps is the
   thing you actually glance at mid-ride: how far, and which way. */

import { S, settings } from "./state.js";
import * as store from "./store.js";
import { haversine } from "./sensors.js";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const PLACES = "https://places.googleapis.com/v1/places:searchText";

/* The fallback is silent on purpose while riding, which makes it useless while
   setting up: every search quietly works and nobody can tell Places is not
   answering. The last failure is kept so diagnostics can name it. */
let lastPlacesError = null;
export function placesStatus() { return lastPlacesError; }
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

/* Pins are places kept on purpose, as opposed to recents, which are just the
   last few things searched. They survive clearing a destination. */
export function pins() { return store.get("pins", []); }

export function addPin(d) {
  const list = pins();
  if (list.some((p) => Math.abs(p.lat - d.lat) < 1e-5 && Math.abs(p.lng - d.lng) < 1e-5)) return false;
  if (list.length >= 12) return false;
  list.unshift({ label: (d.label || "Pin").trim().slice(0, 32), lat: d.lat, lng: d.lng, pinned: true });
  store.set("pins", list);
  return true;
}

export function removePin(lat, lng) {
  store.set("pins", pins().filter((p) => !(Math.abs(p.lat - lat) < 1e-5 && Math.abs(p.lng - lng) < 1e-5)));
}

export function isPinned(d) {
  return pins().some((p) => Math.abs(p.lat - d.lat) < 1e-5 && Math.abs(p.lng - d.lng) < 1e-5);
}

export async function search(query) {
  const q = query.trim();
  if (q.length < 3) return [];
  if (settings.mapKey) {
    const viaGoogle = await placesSearch(q);
    if (viaGoogle && viaGoogle.length) return viaGoogle;
  }
  return nominatimSearch(q);
}

/* Places API (New) — the only Places endpoint that allows browser calls, and
   the same key the map already uses. Returns null on any failure so the
   caller falls through rather than surfacing an error. */
async function placesSearch(q) {
  try {
    const body = {
      textQuery: q,
      maxResultCount: 6,
      ...(S.lat !== null ? {
        locationBias: { circle: { center: { latitude: S.lat, longitude: S.lng }, radius: 30000 } }
      } : {})
    };
    const res = await fetch(PLACES, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": settings.mapKey,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      let why = "";
      try {
        const e = await res.json();
        why = (e.error && (e.error.status || e.error.message)) || "";
      } catch (_) { /* not JSON */ }
      lastPlacesError = res.status + (why ? " " + String(why).slice(0, 80) : "");
      return null;
    }
    const j = await res.json();
    if (!j.places) { lastPlacesError = "no results field"; return null; }
    lastPlacesError = null;
    return j.places.map((p) => ({
      label: (p.displayName && p.displayName.text) || shortName(p.formattedAddress || ""),
      full: p.formattedAddress || "",
      lat: p.location.latitude,
      lng: p.location.longitude,
      src: "g"
    }));
  } catch (e) {
    // A CORS rejection surfaces here with no detail, and that is itself the
    // signal: the key is not allowed to call this API.
    lastPlacesError = "blocked (" + (e && e.name ? e.name : "network") + ")";
    return null;
  }
}

async function nominatimSearch(q) {
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
      lng: parseFloat(r.lon),
      src: "n"
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
