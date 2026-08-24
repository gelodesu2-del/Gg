/* Google Maps, heading-up.

   Raster maps do not honour setHeading, so rotation is done by spinning an
   oversized container under a fixed viewport — the rotor is 190% of the panel
   so its corners never come into view. The bike marker is drawn in the SVG
   overlay above it and never moves. */

import { S, settings } from "./state.js";

let map = null;
let rotor = null;
let lastCenter = 0;

const DARK = [
  { elementType: "geometry", stylers: [{ color: "#0b0d10" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0b0d10" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#5c6570" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#1a1f26" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#242b34" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#2e3742" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#6a747f" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#070f16" }] },
  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#0e1418" }] }
];

export function load() {
  if (!settings.mapKey) return false;
  if (document.getElementById("gmaps-js")) return true;
  window.__nmaxMapReady = init;
  const s = document.createElement("script");
  s.id = "gmaps-js";
  s.async = true;
  s.src = "https://maps.googleapis.com/maps/api/js?key=" +
          encodeURIComponent(settings.mapKey) + "&callback=__nmaxMapReady&loading=async";
  s.onerror = () => { document.getElementById("map-none").textContent = "Map key rejected"; };
  document.head.appendChild(s);
  return true;
}

function init() {
  rotor = document.getElementById("map-rotor");
  map = new google.maps.Map(document.getElementById("gmap"), {
    center: { lat: S.lat ?? 14.55, lng: S.lng ?? 121.03 },
    zoom: 17,
    disableDefaultUI: true,
    gestureHandling: "none",
    keyboardShortcuts: false,
    clickableIcons: false,
    backgroundColor: "#030406",
    styles: DARK
  });
  document.getElementById("map-none").classList.add("hide");
  document.getElementById("map-slot").classList.add("live");
}

/* Called from the frame loop. Recentring is throttled — Maps does its own
   easing and calling it at 60fps just burns battery for no visible gain. */
export function update(now) {
  if (!map || !rotor) return;
  // Raster tiles ignore setHeading, so heading-up means spinning the container.
  rotor.style.transform = "rotate(" + (-S.heading).toFixed(1) + "deg)";
  if (S.lat !== null && now - lastCenter > 250) {
    lastCenter = now;
    map.setCenter({ lat: S.lat, lng: S.lng });
  }
}

export function ready() { return !!map; }
export function usesCssRotor() { return true; }
