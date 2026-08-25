/* Service worker.

   Two jobs: make the dash open instantly and survive a dead spot, and stop the
   webfont failing twice. Orbitron rendered as notdef boxes on a real phone, so
   once a font file has been fetched successfully it is kept for good.

   The rule that matters most is what this does NOT touch. Spotify and Google
   Maps traffic must reach the network untouched — a cached playback state or a
   stale map tile is worse than no answer at all. */

const CACHE = "nmax-v16";
const FONT_HOSTS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];

const SHELL = [
  "./", "./index.html", "./css/app.css",
  "./js/app.js", "./js/state.js", "./js/store.js", "./js/sensors.js",
  "./js/trips.js", "./js/spotify.js", "./js/gmap.js", "./js/sos.js",
  "./js/dash.js", "./js/logs.js", "./js/shell.js",
  "./js/osm.js", "./js/mapview.js", "./js/nav.js", "./js/obd.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png"
];

/* Everything the app cannot boot without. If any of these failed to cache,
   activating would delete the old good cache and leave an index.html whose
   module imports 404 offline — a blank dash until signal returns. Icons and
   fonts may fail without consequence; these may not. */
const CORE = SHELL.filter((u) => u.endsWith(".js") || u.endsWith(".css") || u.endsWith("index.html") || u === "./");

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(async (c) => {
        await Promise.allSettled(SHELL.map((u) => c.add(u)));
        for (const u of CORE) {
          if (!(await c.match(u))) throw new Error("core asset failed to cache: " + u);
        }
      })
      .then(() => self.skipWaiting())
  );
});

/* The page asks what is running so diagnostics can show it, and a bug report
   can name a version rather than "the latest, I think". */
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "version" && e.source) {
    e.source.postMessage({ type: "version", cache: CACHE });
  }
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
  // back as ?code=…, is never answered from cache — but a launch must not
  // hang on a weak link either. The cached shell wins after three seconds,
  // and location.search survives it, so the OAuth exchange still runs.
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      const net = fetch(req).catch(() => null);
      const first = await Promise.race([net, new Promise((r) => setTimeout(() => r("timeout"), 3000))]);
      if (first && first !== "timeout") return first;
      const hit = await caches.match("./index.html");
      if (hit) return hit;
      return (await net) || Response.error();
    })());
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
