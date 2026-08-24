/* Picks a map provider.

   OpenStreetMap is the default because it needs nothing: no account, no key,
   no card. Google is kept for the day billing is enabled — it has live traffic
   and richer places, which OSM does not. */

import { settings } from "./state.js";
import * as google from "./gmap.js";
import * as osm from "./osm.js";

const pick = () => (settings.mapProvider === "google" ? google : osm);
let active = null;

export function load() {
  active = pick();
  if (active === google && !settings.mapKey) {
    const el = document.getElementById("map-none");
    el.classList.remove("hide");
    el.textContent = "Google selected but no key set. Settings has an OpenStreetMap option that needs neither.";
    return false;
  }
  return active.load();
}

export function update(now) {
  if (active) active.update(now);
}

/* Google needs the container spun because raster tiles ignore setHeading;
   MapLibre rotates itself and keeps labels upright. */
export function usesCssRotor() {
  return active ? (active.usesCssRotor ? active.usesCssRotor() : true) : true;
}

export function ready() { return !!active && active.ready(); }

export function setDestination(d) {
  if (active && active.setDestination) active.setDestination(d);
}

export function swap() {
  if (osm.destroy) osm.destroy();
  const slot = document.getElementById("map-slot");
  slot.classList.remove("live");
  document.getElementById("gmap").innerHTML = "";
  document.getElementById("map-none").classList.remove("hide");
  document.getElementById("map-none").textContent = "Loading map…";
  document.getElementById("map-rotor").style.transform = "";
  // Google's SDK cannot be unloaded once injected, so a swap back to it needs
  // a reload; OSM can be torn down and rebuilt in place.
  if (settings.mapProvider === "google" && document.getElementById("gmaps-js")) location.reload();
  else load();
  document.getElementById("map-attr").hidden = settings.mapProvider === "google";
}
