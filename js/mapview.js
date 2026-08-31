/* Picks a map provider.

   OpenStreetMap is the default because it needs nothing: no account, no key,
   no card. Google is kept for the day billing is enabled — it has live traffic
   and richer places, which OSM does not. */

import { settings } from "./state.js";
import * as google from "./gmap.js";
import * as osm from "./osm.js";

/* "auto" means: use Google when it has been configured, otherwise the map
   that needs nothing. Explicit choices still win. */
function resolve() {
  if (settings.mapProvider === "google") return "google";
  if (settings.mapProvider === "osm") return "osm";
  return settings.mapKey ? "google" : "osm";
}
export function providerName() { return resolve(); }
const pick = () => (resolve() === "google" ? google : osm);
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

export function restyle() {
  if (active && active.restyle) active.restyle();
}

export function routeInfo() {
  return active && active.routeInfo ? active.routeInfo() : null;
}
export function routeStatus() {
  return active && active.routeStatus ? active.routeStatus() : null;
}
/* Whether the map is drawing in 3D, and why not when it is not. */
export function mapMode() {
  return active && active.mapMode ? active.mapMode() : "";
}

/* Turn-by-turn steps only exist where a directions service returned them —
   null on the OpenStreetMap side, which routes but does not narrate. */
export function nextStep() {
  return active && active.nextStep ? active.nextStep() : null;
}

export function setFollow(on) { if (active && active.setFollow) active.setFollow(on); }
export function following() { return active && active.following ? active.following() : true; }

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
  if (resolve() === "google" && document.getElementById("gmaps-js")) location.reload();
  else load();
  document.getElementById("map-attr").hidden = resolve() === "google";
}
