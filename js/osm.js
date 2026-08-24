/* OpenStreetMap via MapLibre, with CARTO's dark vector basemap.

   No account, no key, no card. The style is vector rather than raster, which
   buys something the Google path never had: the map rotates natively through
   setBearing, so street labels stay upright instead of turning upside down
   with the world. Attribution is a licence condition, not decoration. */

import { S } from "./state.js";

const STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const LIB_JS = "https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js";
const LIB_CSS = "https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css";

let map = null;
let lastCenter = 0;
let lastBearing = 0;

function fail(msg) {
  const el = document.getElementById("map-none");
  if (el) { el.classList.remove("hide"); el.textContent = msg; }
  document.getElementById("map-slot").classList.remove("live");
}

export function load() {
  if (map || document.getElementById("maplibre-js")) return true;

  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = LIB_CSS;
  document.head.appendChild(css);

  const s = document.createElement("script");
  s.id = "maplibre-js";
  s.src = LIB_JS;
  s.async = true;
  s.onload = init;
  s.onerror = () => fail("Could not load the map library. Check the connection.");
  document.head.appendChild(s);
  return true;
}

function init() {
  if (!window.maplibregl) { fail("Map library did not initialise."); return; }
  try {
    map = new maplibregl.Map({
      container: "gmap",
      style: STYLE,
      center: [S.lng ?? 121.03, S.lat ?? 14.55],
      zoom: 16.5,
      bearing: 0,
      interactive: false,          // the rider never pans it; the bike does
      attributionControl: false,   // shown as a chip instead, to fit the dash
      fadeDuration: 0
    });
    map.on("load", () => {
      document.getElementById("map-none").classList.add("hide");
      document.getElementById("map-slot").classList.add("live");
      document.getElementById("map-attr").hidden = false;
    });
    map.on("error", (e) => {
      if (!map.isStyleLoaded()) fail("Map style could not be reached.");
    });
  } catch (e) {
    fail("Map failed to start: " + e.message);
  }
}

/* Vector rotation happens inside the map, so the CSS rotor stays at zero and
   labels keep their orientation. */
export function update(now) {
  if (!map) return;
  if (Math.abs(S.heading - lastBearing) > 0.8) {
    lastBearing = S.heading;
    map.setBearing(S.heading);
  }
  if (S.lat !== null && now - lastCenter > 250) {
    lastCenter = now;
    map.setCenter([S.lng, S.lat]);
  }
}

let destMarker = null;

export function setDestination(d) {
  if (!map || !window.maplibregl) return;
  if (destMarker) { destMarker.remove(); destMarker = null; }
  if (!d) return;
  const el = document.createElement("div");
  el.className = "dest-pin";
  destMarker = new maplibregl.Marker({ element: el }).setLngLat([d.lng, d.lat]).addTo(map);
}

export function usesCssRotor() { return false; }
export function ready() { return !!map; }

export function destroy() {
  if (map) { try { map.remove(); } catch (e) { /* already gone */ } map = null; }
  document.getElementById("map-attr").hidden = true;
}
