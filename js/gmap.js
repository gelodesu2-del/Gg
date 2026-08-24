/* Google Maps.

   Two rendering paths, because they behave very differently.

   With a Map ID that has vector rendering enabled, the map rotates itself
   through the camera and street labels stay upright — the same behaviour the
   OpenStreetMap path gets for free. Styling then lives in the cloud console,
   and any inline styles array is ignored.

   Without one, tiles are raster. Raster maps ignore heading entirely, so
   heading-up means spinning an oversized container underneath a fixed
   viewport — which turns the labels over with the world. That is the cost of
   skipping the Map ID, and it is worth knowing before choosing. */

import { S, settings } from "./state.js";

let map = null;
let rotor = null;
let vector = false;
let lastCenter = 0;
let lastHeading = 0;
let destMarker = null;

/* The map is styled from the live theme rather than a fixed palette, so
   switching to crimson turns the roads crimson too. Everything is mixed from
   the accent toward a near-black ground: roads climb in brightness with their
   importance, labels sit above them, and points of interest are removed
   entirely — a dash needs the road network, not restaurant pins.

   Google's styling cannot do glow, so the cyber read comes from the ratios:
   a very dark ground, a narrow band of accent-tinted roads, and labels bright
   enough to catch but not to compete with the cluster. */
function mix(rgb, k, base) {
  const b = base || [4, 6, 9];
  return "#" + rgb.map((c, i) => Math.round(b[i] + (c - b[i]) * k)
    .toString(16).padStart(2, "0")).join("");
}

export function themeStyles() {
  let rgb = [0, 245, 140];
  try {
    const v = getComputedStyle(document.getElementById("app")).getPropertyValue("--neon-rgb");
    const p = v.split(",").map((n) => parseInt(n, 10));
    if (p.length === 3 && p.every((n) => !isNaN(n))) rgb = p;
  } catch (e) { /* fall back to the default accent */ }

  const WATER_BASE = [3, 9, 15];        // water leans blue rather than neutral

  return [
    // Ground sits almost black. Everything above it is a deliberate step up,
    // and roads have to clear the blocks they run between or the labels end
    // up floating over nothing — which is exactly how the first pass read.
    { elementType: "geometry", stylers: [{ color: mix(rgb, 0.02) }] },
    { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#040609" }, { weight: 4 }] },
    { elementType: "labels.text.fill", stylers: [{ color: mix(rgb, 0.45) }] },

    { featureType: "poi", stylers: [{ visibility: "off" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
    { featureType: "administrative", elementType: "geometry", stylers: [{ color: mix(rgb, 0.14) }] },
    { featureType: "administrative.land_parcel", stylers: [{ visibility: "off" }] },
    { featureType: "administrative.neighborhood", stylers: [{ visibility: "off" }] },

    { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: mix(rgb, 0.025) }] },
    { featureType: "landscape.man_made", elementType: "geometry", stylers: [{ color: mix(rgb, 0.045) }] },
    { featureType: "poi.park", elementType: "geometry", stylers: [{ color: mix(rgb, 0.07) }] },

    // The jump from block to road is what makes the network readable at a
    // glance, so it is a wide one. Casing separates touching roads.
    { featureType: "road", elementType: "geometry.fill", stylers: [{ color: mix(rgb, 0.24) }] },
    { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: mix(rgb, 0.11) }] },
    { featureType: "road.arterial", elementType: "geometry.fill", stylers: [{ color: mix(rgb, 0.38) }] },
    { featureType: "road.arterial", elementType: "geometry.stroke", stylers: [{ color: mix(rgb, 0.16) }] },
    { featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: mix(rgb, 0.58) }] },
    { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: mix(rgb, 0.24) }] },
    { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: mix(rgb, 0.72) }] },
    { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: mix(rgb, 0.88) }] },

    { featureType: "water", elementType: "geometry", stylers: [{ color: mix(rgb, 0.11, WATER_BASE) }] },
    { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: mix(rgb, 0.40, WATER_BASE) }] }
  ];
}

/* Google answers an auth failure with a grey panel and writes the real reason
   to the console, which is useless on a phone with no devtools attached.
   These are the codes it emits, translated into the thing to go and fix. */
const MAP_ERRORS = {
  BillingNotEnabledMapError: "Billing is not enabled on the Google Cloud project. Maps needs a card on file even inside the free tier.",
  ApiNotActivatedMapError: "Maps JavaScript API is not enabled on the project — that exact API, not just any Maps one.",
  RefererNotAllowedMapError: "This address is not in the key's allowed referrers. Add it and give it a few minutes.",
  InvalidKeyMapError: "That key is not valid. Check for a stray space when pasting.",
  ExpiredKeyMapError: "That key has expired.",
  MissingKeyMapError: "No key was sent.",
  RefererDeniedMapError: "The referrer was denied for this key.",
  ApiTargetBlockedMapError: "The key is restricted to other APIs. Allow Maps JavaScript API under API restrictions.",
  InvalidMapIdError: "That Map ID is not valid for this project. Leave it blank to fall back to raster tiles.",
  ScriptBlocked: "Could not reach Google's servers. Check the connection.",
  AuthFailure: "Google refused the key — usually billing, or the API not being enabled."
};

function fail(code) {
  const el = document.getElementById("map-none");
  if (!el) return;
  el.classList.remove("hide");
  el.textContent = MAP_ERRORS[code] || ("Maps refused the key: " + code);
  document.getElementById("map-slot").classList.remove("live");
}

function watchForAuthErrors() {
  if (window.__nmaxMapWatch) return;
  window.__nmaxMapWatch = true;
  const original = console.error;
  console.error = function (...args) {
    const m = /Google Maps JavaScript API (?:error|warning):\s*(\w+)/.exec(args.join(" "));
    if (m) fail(m[1]);
    original.apply(console, args);
  };
  window.gm_authFailure = () => fail("AuthFailure");
}

export function load() {
  if (!settings.mapKey) return false;
  if (document.getElementById("gmaps-js")) return true;
  watchForAuthErrors();
  window.__nmaxMapReady = init;
  const s = document.createElement("script");
  s.id = "gmaps-js";
  s.async = true;
  s.src = "https://maps.googleapis.com/maps/api/js?key=" +
          encodeURIComponent(settings.mapKey) + "&callback=__nmaxMapReady&loading=async&v=weekly";
  s.onerror = () => fail("ScriptBlocked");
  document.head.appendChild(s);
  return true;
}

function init() {
  rotor = document.getElementById("map-rotor");
  vector = !!settings.mapId;

  const opts = {
    center: { lat: S.lat ?? 14.55, lng: S.lng ?? 121.03 },
    zoom: 17,
    disableDefaultUI: true,
    gestureHandling: "greedy",
    keyboardShortcuts: false,
    clickableIcons: false,
    backgroundColor: "#030406"
  };
  // A Map ID and an inline styles array are mutually exclusive: passing both
  // makes Google ignore the styles and warn about it.
  if (vector) { opts.mapId = settings.mapId; opts.heading = 0; opts.tilt = 0; }
  else { opts.styles = themeStyles(); }

  map = new google.maps.Map(document.getElementById("gmap"), opts);
  map.addListener("dragstart", () => {
    follow = false;
    if (window.__nmaxMapFollow) window.__nmaxMapFollow(false);
  });
  document.getElementById("map-none").classList.add("hide");
  document.getElementById("map-slot").classList.add("live");
  if (vector) rotor.style.transform = "";     // the camera turns instead
}

/* Follow mode: heading-up and centred on the bike. A touch on the map breaks
   it so the road ahead can be inspected; recenter resumes. */
let follow = true;

export function setFollow(on) {
  follow = on;
  if (!on) {
    // North-up while browsing — a frozen rotation with the world still
    // turning underneath is disorienting.
    if (vector && map) map.setHeading(0);
    else if (rotor) rotor.style.transform = "";
  }
}
export function following() { return follow; }

export function update(now) {
  if (!map || !follow) return;

  if (vector) {
    if (Math.abs(S.heading - lastHeading) > 0.8) {
      lastHeading = S.heading;
      map.setHeading(S.heading);              // labels stay upright
    }
  } else if (rotor) {
    rotor.style.transform = "rotate(" + (-S.heading).toFixed(1) + "deg)";
  }

  // Recentring is throttled: Maps eases on its own, and calling this every
  // frame only burns battery.
  if (S.lat !== null && now - lastCenter > 250) {
    lastCenter = now;
    map.setCenter({ lat: S.lat, lng: S.lng });
  }
}

export function setDestination(d) {
  if (!map || !window.google) return;
  if (destMarker) { destMarker.setMap(null); destMarker = null; }
  if (!d) return;
  destMarker = new google.maps.Marker({
    position: { lat: d.lat, lng: d.lng }, map,
    icon: {
      path: google.maps.SymbolPath.CIRCLE, scale: 7,
      fillColor: "#FFB833", fillOpacity: 1, strokeColor: "#0A0C10", strokeWeight: 2
    }
  });
}

/* Called when the theme changes. Vector maps take their styling from the
   cloud console, so only the raster path can follow the theme at runtime. */
export function restyle() {
  if (map && !vector) map.setOptions({ styles: themeStyles() });
}

export function usesCssRotor() { return !vector; }
export function isVector() { return vector; }
export function ready() { return !!map; }
