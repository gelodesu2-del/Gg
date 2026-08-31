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
let lastHeadingAt = 0;
let lastHeading = 0;
let destMarker = null;
let bikeMarker = null;      // stands in for the centre overlay while browsing
let markPins = [];
let onTap = null;

/* The map is greyscale by design and does not follow the theme. Points of
   interest are removed entirely — a dash needs the road network, not
   restaurant pins. This applies to raster tiles only: set a Map ID and Google
   takes styling into the cloud console instead. */
export function themeStyles() {
  const light = document.getElementById("app").dataset.mode === "light";

  /* The map itself is neutral: black through grey, no accent anywhere in it.
     Colour on this screen means "the app is telling you something" — the
     route, the destination pin, a hazard, the shift bar. A map tinted with
     the same hue competes with all of that, and at a glance the eye cannot
     tell a lit road from a lit instrument. So the ramp below is pure value:
     the ground is nearly black, and each step up to arterial and highway is a
     step in brightness only. */
  const g = (n) => {
    const v = light ? 255 - n : n;
    const h = Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    return "#" + h + h + h;
  };
  const STROKE = light ? "#F2F4F6" : "#040609";
  // Water is the one thing allowed off the grey axis, and barely: a cold cast
  // is what stops a river reading as another block of buildings.
  const WATER = light ? "#C9D6E0" : "#0A0F15";
  const WATER_LABEL = light ? "#5A6A78" : "#42525E";

  return [
    { elementType: "geometry", stylers: [{ color: g(7) }] },
    { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: STROKE }, { weight: 4 }] },
    { elementType: "labels.text.fill", stylers: [{ color: g(105) }] },

    { featureType: "poi", stylers: [{ visibility: "off" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
    { featureType: "administrative", elementType: "geometry", stylers: [{ color: g(36) }] },
    { featureType: "administrative.land_parcel", stylers: [{ visibility: "off" }] },
    { featureType: "administrative.neighborhood", stylers: [{ visibility: "off" }] },

    { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: g(10) }] },
    { featureType: "landscape.man_made", elementType: "geometry", stylers: [{ color: g(16) }] },
    { featureType: "poi.park", elementType: "geometry", stylers: [{ color: g(22) }] },

    // A wide jump from block to road is what makes the network readable at
    // speed; casing keeps two touching roads from merging into one shape.
    { featureType: "road", elementType: "geometry.fill", stylers: [{ color: g(52) }] },
    { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: g(26) }] },
    { featureType: "road.arterial", elementType: "geometry.fill", stylers: [{ color: g(78) }] },
    { featureType: "road.arterial", elementType: "geometry.stroke", stylers: [{ color: g(36) }] },
    { featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: g(116) }] },
    { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: g(52) }] },
    { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: g(140) }] },
    { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: g(168) }] },

    { featureType: "water", elementType: "geometry", stylers: [{ color: WATER }] },
    { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: WATER_LABEL }] }
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
  // Tilt is what a vector map buys over raster tiles: buildings stand up and
  // the road ahead gets more pixels than the road behind. Raster ignores it.
  if (vector) { opts.mapId = settings.mapId; opts.heading = 0; opts.tilt = TILT; }
  else { opts.styles = themeStyles(); }

  map = new google.maps.Map(document.getElementById("gmap"), opts);
  map.addListener("dragstart", () => {
    follow = false;
    if (window.__nmaxMapFollow) window.__nmaxMapFollow(false);
    showBikeMarker(true);
  });
  // The library's own click event, so the projection is its problem rather
  // than ours — the raster path rotates its container with CSS, and pixel
  // maths of our own would have to undo that.
  map.addListener("click", (e) => {
    if (!onTap || !e || !e.latLng) return;
    onTap(e.latLng.lat(), e.latLng.lng());
  });
  document.getElementById("map-none").classList.add("hide");
  document.getElementById("map-slot").classList.add("live");
  if (vector) {
    rotor.style.transform = "";               // the camera turns instead
    // Asserted again after construction. The constructor takes tilt as a
    // request, and a map that is still deciding whether it can render vector
    // tiles can drop it; setTilt on a live map does not get dropped.
    setTimeout(() => { try { map.setTilt(TILT); } catch (e) { /* raster after all */ } }, 400);
  }
}

/* Why the map is flat, when it is. Vector rendering — and therefore tilt, and
   therefore raised buildings — is only available with a Map ID, and a Map ID
   moves styling into the Cloud console: an inline styles array is ignored the
   moment one is set. Diagnostics says which of the two the rider is getting. */
export function mapMode() {
  if (!map) return "";
  if (!vector) return "flat — no Map ID set, so the map is raster tiles";
  let tilt = null;
  try { tilt = map.getTilt(); } catch (e) { /* not ready */ }
  return tilt ? "3D · " + Math.round(tilt) + "° · styled in Cloud console"
              : "Map ID set but still flat — check vector rendering is on for it";
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
  showBikeMarker(!on);
}

/* While following, the bike is at the centre of the map and the fixed overlay
   arrow is exactly right. The moment the map is dragged, that arrow stops
   meaning "you are here" and starts looking like an icon being dragged around
   — so it is swapped for a real marker pinned to the ground. */
function showBikeMarker(on) {
  const slot = document.getElementById("map-slot");
  if (slot) slot.classList.toggle("browsing", on);
  if (!map || !window.google) return;
  if (!on) {
    if (bikeMarker) { bikeMarker.setMap(null); bikeMarker = null; }
    return;
  }
  if (S.lat === null) return;
  const pos = { lat: S.lat, lng: S.lng };
  if (bikeMarker) { bikeMarker.setPosition(pos); return; }
  bikeMarker = new google.maps.Marker({
    position: pos, map, zIndex: 60,
    icon: {
      path: google.maps.SymbolPath.CIRCLE, scale: 6,
      fillColor: accent(), fillOpacity: 1, strokeColor: "#0A0C10", strokeWeight: 2
    }
  });
}

/* Tagged spots. Redrawn wholesale — there are at most a couple of hundred and
   they only change on a tap. */
export function setMarks(list, onPick) {
  if (!map || !window.google) return;
  for (const m of markPins) m.setMap(null);
  markPins = [];
  for (const mk of list) {
    const pin = new google.maps.Marker({
      position: { lat: mk.lat, lng: mk.lng }, map, zIndex: 50,
      icon: {
        path: "M -7 -4 q 3.5 -4 7 0 q 3.5 4 7 0 M -7 0 q 3.5 -4 7 0 q 3.5 4 7 0 M -7 4 q 3.5 -4 7 0 q 3.5 4 7 0",
        strokeColor: mint(), strokeWeight: 2.2, strokeOpacity: 1, fillOpacity: 0, scale: 1.1
      }
    });
    pin.addListener("click", () => { if (onPick) onPick(mk.id); });
    markPins.push(pin);
  }
}

export function setTapHandler(fn) { onTap = fn; }
export function following() { return follow; }

export function update(now) {
  if (!map) return;
  if (!follow) {                        // browsing: the marker still follows the bike
    if (bikeMarker && S.lat !== null) bikeMarker.setPosition({ lat: S.lat, lng: S.lng });
    return;
  }

  if (vector) {
    // setHeading eases the camera rather than jumping it, so calling it every
    // frame queues animations behind each other and the map lags the bike.
    // Twenty times a second is past what the eye resolves on a map anyway.
    let d = Math.abs(S.heading - lastHeading);
    if (d > 180) d = 360 - d;
    if (d > 1 && now - lastHeadingAt > 50) {
      lastHeading = S.heading;
      lastHeadingAt = now;
      map.setHeading(S.heading);              // labels stay upright
    }
  } else if (rotor) {
    // A CSS transform is cheap enough to write every frame, and the compositor
    // does not queue them the way the camera does.
    rotor.style.transform = "rotate(" + (-S.heading).toFixed(1) + "deg)";
  }

  // Recentring is throttled: Maps eases on its own, and calling this every
  // frame only burns battery.
  if (S.lat !== null && now - lastCenter > 250) {
    lastCenter = now;
    map.setCenter({ lat: S.lat, lng: S.lng });
  }

  // Leaving the line by more than ~150 m earns a fresh route. Checked at a
  // walking pace of once per 20 s — Directions calls are billable.
  if (routeDest && now - routeCheckAt > 20000) {
    routeCheckAt = now;
    if (!routePath && !dirError) requestRoute();          // first attempt failed on no-fix
    else if (routePath && offRouteM() > 150) requestRoute();
  }
}

/* ---------- routing ----------
   The homing arrow says which way the destination lies; the route says which
   roads get there. Drawn as our own themed polyline rather than Google's
   DirectionsRenderer, which drags its default blue and its own markers in.
   Needs the (legacy) Directions API enabled AND listed in the key's API
   restrictions — the same trap Places fell into, so refusals are kept for
   diagnostics instead of failing silently. */
let dirSvc = null;
let routeLine = null;
let routeGlow = null;
/* Camera pitch on a vector map. 45 is Google's ceiling for a raised-building
   view; anything less and the extrusions barely read at a glance. */
const TILT = 45;

let routePath = null;
let routeMeta = null;
let routeSteps = [];
let routeDest = null;
let routeCheckAt = 0;
let dirError = null;

function token(name, fallback, a) {
  let rgb = fallback;
  try {
    rgb = getComputedStyle(document.getElementById("app")).getPropertyValue(name).trim() || fallback;
  } catch (e) { /* default */ }
  return a ? "rgba(" + rgb + "," + a + ")" : "rgb(" + rgb + ")";
}
function accent(a) { return token("--neon-rgb", "0,245,140", a); }
function mint(a) { return token("--mint-rgb", "124,255,196", a); }

function clearRoute() {
  if (routeLine) { routeLine.setMap(null); routeLine = null; }
  if (routeGlow) { routeGlow.setMap(null); routeGlow = null; }
  routePath = null;
  routeMeta = null;
  routeSteps = [];
}

function requestRoute() {
  if (!map || !routeDest || S.lat === null) return;
  if (!google.maps.DirectionsService) { dirError = "DirectionsService missing"; return; }
  dirSvc = dirSvc || new google.maps.DirectionsService();
  // TWO_WHEELER routes a scooter rather than a car — Google supports it in the
  // Philippines, and it uses roads a car cannot. departureTime is what actually
  // switches on live traffic: without it the ETA is free-flow and the route is
  // not traffic-optimised at all.
  dirSvc.route({
    origin: { lat: S.lat, lng: S.lng },
    destination: { lat: routeDest.lat, lng: routeDest.lng },
    travelMode: google.maps.TravelMode.TWO_WHEELER,
    drivingOptions: { departureTime: new Date(), trafficModel: "bestguess" },
    provideRouteAlternatives: true
  }, (res, status) => {
    if (status !== "OK" || !res.routes || !res.routes.length) {
      dirError = String(status);          // REQUEST_DENIED = not on the key's allowed list
      return;
    }
    dirError = null;
    clearRoute();
    const route = res.routes[0];
    routePath = route.overview_path;
    routeGlow = new google.maps.Polyline({
      map, path: routePath, strokeColor: accent(".22"), strokeOpacity: 1, strokeWeight: 11, zIndex: 39, clickable: false
    });
    routeLine = new google.maps.Polyline({
      map, path: routePath, strokeColor: accent(), strokeOpacity: .92, strokeWeight: 4.5, zIndex: 40, clickable: false
    });
    const leg = route.legs && route.legs[0];
    routeMeta = leg ? {
      m: leg.distance ? leg.distance.value : 0,
      // duration_in_traffic is only present once departureTime was sent.
      s: leg.duration_in_traffic ? leg.duration_in_traffic.value
        : leg.duration ? leg.duration.value : 0
    } : null;
    routeSteps = (leg && leg.steps ? leg.steps : []).map((st) => ({
      lat: st.start_location.lat(),
      lng: st.start_location.lng(),
      endLat: st.end_location.lat(),
      endLng: st.end_location.lng(),
      m: st.distance ? st.distance.value : 0,
      maneuver: st.maneuver || "",
      road: plain(st.instructions)
    }));
  });
}

/* Google returns the instruction as HTML. The dash writes it with textContent,
   so the tags have to come out here rather than be trusted downstream. */
function plain(html) {
  if (!html) return "";
  const t = document.createElement("div");
  t.innerHTML = html;
  return (t.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
}

/* The step the rider is currently on: the last one whose start is already
   behind them. Distance is to the end of that step — the point they act at. */
export function nextStep() {
  if (!routeSteps.length || S.lat === null) return null;
  const cosLat = Math.cos(S.lat * Math.PI / 180);
  const dist = (aLat, aLng) => {
    const dx = (aLng - S.lng) * 111320 * cosLat, dy = (aLat - S.lat) * 110540;
    return Math.sqrt(dx * dx + dy * dy);
  };
  let best = 0, bestD = Infinity;
  for (let i = 0; i < routeSteps.length; i++) {
    const d = dist(routeSteps[i].lat, routeSteps[i].lng);
    if (d < bestD) { bestD = d; best = i; }
  }
  const st = routeSteps[best];
  return {
    m: Math.round(dist(st.endLat, st.endLng)),
    maneuver: st.maneuver,
    road: st.road
  };
}

/* Cheap planar distance in metres to the nearest route vertex — good enough
   to know the rider has left the line. */
function offRouteM() {
  if (!routePath || S.lat === null) return 0;
  const cosLat = Math.cos(S.lat * Math.PI / 180);
  let best = Infinity;
  for (let i = 0; i < routePath.length; i += 2) {
    const p = routePath[i];
    const dx = (p.lng() - S.lng) * 111320 * cosLat;
    const dy = (p.lat() - S.lat) * 110540;
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

export function routeInfo() { return routeMeta; }
export function routeStatus() { return dirError; }

export function setDestination(d) {
  routeDest = d || null;
  dirError = null;
  clearRoute();
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
  requestRoute();
}

/* Called when the theme changes. Vector maps take their styling from the
   cloud console, so only the raster path can follow the theme at runtime. */
export function restyle() {
  if (map && !vector) map.setOptions({ styles: themeStyles() });
  if (routeLine) routeLine.setOptions({ strokeColor: accent() });
  if (routeGlow) routeGlow.setOptions({ strokeColor: accent(".22") });
}

export function usesCssRotor() { return !vector; }
export function isVector() { return vector; }
export function ready() { return !!map; }
