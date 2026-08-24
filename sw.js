/* Service worker.

   Two jobs: make the dash open instantly and survive a dead spot, and stop the
   webfont failing twice. Orbitron rendered as notdef boxes on a real phone, so
   once a font file has been fetched successfully it is kept for good.

   The rule that matters most is what this does NOT touch. Spotify and Google
   Maps traffic must reach the network untouched — a cached playback state or a
   stale map tile is worse than no answer at all. */

const CACHE = "nmax-v6";
const FONT_HOSTS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];

const SHELL = [
  "./", "./index.html", "./css/app.css", "./manifest.webmanifest",
  "./js/app.js", "./js/state.js", "./js/store.js", "./js/sensors.js",
  "./js/trips.js", "./js/spotify.js", "./js/gmap.js", "./js/sos.js",
  "./js/dash.js", "./js/logs.js", "./js/shell.js",
  "./js/osm.js", "./js/mapview.js", "./js/nav.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // One bad entry should not fail the whole install and leave no worker.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = FONT_HOSTS.includes(url.origin);
  if (!sameOrigin && !isFont) return;              // API traffic passes straight through

  // Navigations go to the network first so the Spotify redirect, which comes
  // back as ?code=…, is never answered from cache.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("./index.html")));
    return;
  }

  // Fonts never change once fetched, so cache wins outright.
  if (isFont) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && (res.ok || res.type === "opaque")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // Shell: serve instantly from cache, refresh behind it, so a push lands on
  // the next launch without needing a version bump here.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
