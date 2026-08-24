# NMAX Dash

A landscape instrument cluster for a Yamaha NMAX v3, running as a hosted web app
on an Android phone mounted to the bars.

This is the **phone-only half**: everything that works with no dongle plugged
into the bike. GPS speed, lean angle from the gyroscope, pothole logging, trip
history, road scoring, Spotify, and a heading-up Google Map. The OBD layer —
RPM, fuel, coolant — lands once the ELM327 test confirms which PIDs the ECU
actually answers.

---

## What works without the dongle

| | Source |
|---|---|
| Speed, heading, position | GPS |
| Lean angle, peak hold | Gyroscope + accelerometer |
| Pothole detection, jolt scoring | Accelerometer |
| Trips, distance, route history | GPS |
| Crash detection | Accelerometer + GPS |
| Emergency contacts | Contact Picker API |
| Map | Google Maps JS API |
| Music | Spotify Web API |

Anything needing engine data shows a dash until the dongle is connected.

---

## Setup

### 1. Host it

Both Google and Spotify require an HTTPS address, so the app has to be served
rather than opened from a file. Either host works; Cloudflare is the better
fit.

**Cloudflare Pages** *(recommended)*

1. [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → Create → Pages → Connect to Git
2. Pick this repo and the branch you want to serve
3. Framework preset **None**, build command **empty**, output directory **`/`**
4. Deploy

You get `https://<project>.pages.dev`, and every push redeploys. It is faster
than the alternative from the Philippines — Cloudflare has edge presence in
Manila — it serves any branch without merging, and `_headers` in this repo is
applied automatically. If the crash webhook ever gets built, Cloudflare
Functions can host it on the same domain.

**One trap:** Cloudflare gives every preview build its own URL
(`abc123.<project>.pages.dev`). Spotify matches redirect URIs exactly and does
not accept wildcards, so **log in only from the production URL**, or add each
preview URL you actually use to the Spotify dashboard.

**GitHub Pages**

Settings → Pages → deploy from a branch. Gives
`https://<user>.github.io/<repo>/`. Simpler, one URL, no preview-URL trap,
slightly slower from Manila.

### 2. The map

**OpenStreetMap is the default and needs nothing** — no account, no key, no
card. Tiles come from CARTO's dark vector basemap, rendered with MapLibre.
Because the style is vector rather than raster, the map rotates natively and
**street labels stay upright** instead of turning over with the world, which
the Google path could not do.

Attribution to OpenStreetMap and CARTO appears on the map. That is a licence
condition, not decoration — leave it there.

What OSM gives up against Google: **no live traffic**, and thinner data for
shops and landmarks. Roads are well covered. For a dash showing where you are,
neither loss matters much; for finding a place, Google is better.

Skip the rest of this section unless you want Google specifically.

### 2b. Google Maps (optional)

Google brings live traffic and better places data. It costs a billing account
and, for the best result, one extra step.

**The map follows your theme.** Roads, labels and water are all mixed from the
active accent toward a near-black ground, so switching to crimson turns the map
crimson. Points of interest are removed — a dash needs the road network, not
restaurant pins.

**Map ID (recommended).** Without one, Google serves raster tiles, which ignore
heading entirely — so heading-up means spinning the container, and **street
labels turn upside down with the world**. With a vector Map ID the map rotates
through its own camera and labels stay upright.

Google Cloud → Map Management → **Create Map ID** → type **JavaScript**,
rendering **Vector**. Paste it into setup field 3.

The trade: a Map ID takes its styling from the cloud console, so the map can no
longer follow your theme at runtime. Upright labels or theme-matched colours,
not both. Leave the Map ID blank to keep the theming.

1. [Google Cloud console](https://console.cloud.google.com/) → new project
2. Enable **Maps JavaScript API**
3. Credentials → create an API key
4. **Restrict it** to HTTP referrers, and add your deployed address

An unrestricted key on a public page is the one mistake here that costs real
money. For one rider on one phone the usage itself sits far inside the free
tier.

### 3. Spotify client ID

1. [Spotify developer dashboard](https://developer.spotify.com/dashboard) → create an app
2. Add your deployed address as a **Redirect URI**, exactly — scheme, host and
   any trailing path must match character for character
3. Copy the Client ID

Playback control requires **Spotify Premium**. On a free account the dash shows
what is playing but the transport buttons do nothing — that is Spotify's
restriction, not a bug here.

### 4. Emergency contacts

Settings → **Emergency contacts**. *From contacts* opens Chrome's own contact
picker, so the app never gets address book permission and never sees anyone you
did not choose — it returns just the name and number you tapped. Browsers
without the picker fall back to typing a number by hand.

Up to three. Edit the message if you want it in another language; `{link}` is
replaced with a Google Maps link to your last known position. **Send test
message** composes a real one prefixed `[TEST — no emergency]` so you can check
the whole path before you ever need it.

**Alert via** picks the channel:

| | Behaviour |
|---|---|
| **SMS** *(default)* | Addresses your saved contacts directly. The only one that works with **no data**. |
| **Share** | Android share sheet — Viber, Messenger, WhatsApp, Telegram, whatever is installed. |
| **Viber** | Opens Viber with the message already written; you tap the recipient. |

SMS is the default deliberately. A crash can leave you somewhere with no
signal for data but enough for a text, and it is the only channel that can
address a specific person from a link. Viber's URL scheme has no way to
prefill a message to a given number — `chat?number=` opens the thread but
drops the text, so the app uses `forward?text=`, which keeps the message that
matters and costs one tap to choose who gets it.

### 5. Install it

Open the address in Chrome on the phone. Menu → **Install app** (or *Add to
Home Screen*). It installs as a real app: its own icon and name in the
launcher, its own window in the app switcher, fullscreen with no browser
chrome, locked to landscape, and a service worker that keeps it opening
without signal.

That is a Progressive Web App rather than an APK. A packaged APK would need
Android build tooling and a signing key; for a single rider the installed PWA
behaves the same day to day.

Then paste both keys into the setup screen and grant location and motion.

### Destination search

The magnifier on the map opens search. Geocoding is **Nominatim**, which is
free and needs no key, so search works on either map provider. Results are
biased toward where you are, and recent destinations are kept.

Pick one and the dash shows a **homing chip**: distance and an arrow pointing
where the destination actually lies from the saddle, rotating as you turn. A
pin drops on the map.

Turn-by-turn is deliberately not built in. **Navigate in Maps** hands the
destination to the Google Maps app, which gives voice guidance, live traffic
and rerouting — all better than this dash could draw, and free. What the dash
keeps is the part you glance at: how far, and which way.

### Fit

Tuned for a **OnePlus 12** (3168×1440, 2.20:1, curved edges, 120 Hz):

- **Edge margin** pulls content in from the curve, which Android does not
  report through `env()` — that only covers cutouts. Default *Curved*; *Off*
  and *Wide* are in settings.
- The pager dots sit above centre. Held sideways the punch-hole camera is at
  the vertical middle of one edge, which is exactly where they used to be.
- The fast loop is capped near 60 fps. A 120 Hz panel would otherwise run it
  twice as often for motion no rider can see, at twice the battery.

### Troubleshooting

Settings has a **diagnostics** block reporting which font is in use, the map
state, GPS lock and screen size — everything otherwise invisible on a phone
with no devtools attached.

- **Map shows "For development purposes only"** — billing is not enabled on the
  Google Cloud project. The map degrades to a watermarked, unstyled version
  until a billing account is attached. Settings → **Map** → *OpenStreetMap*
  avoids the requirement entirely.
- **Digits show as empty boxes** — the webfont resolved without its glyphs.
  Settings → **Numerals** → *Safe* switches to a face that is already working.
  *Auto* measures at boot and picks on its own.
- **The dash stutters** — Settings → **Screen effects** off.

---

## Honest limitations

- **Crash detection cannot send an SMS by itself.** No web app can, on any
  platform. It detects the impact, counts down twelve seconds, then hands your
  messaging app a message with recipients and position already filled in — you
  tap send. A fully automatic alert needs a webhook (Telegram bot or similar);
  say the word and it is about thirty lines.
- **The alert always ends on a button.** `navigator.share` requires a real user
  gesture, so a share fired automatically at the end of the countdown is
  refused by the browser. The countdown therefore ends on an **Send alert**
  screen with the message shown: the automatic attempt is best effort, the
  button is the guarantee.
- **Viber and the share sheet need data.** SMS does not. That is why it is
  the default.
- **Multi-recipient SMS is inconsistent.** The link addresses everyone on the
  list, which Google Messages handles; some third-party messaging apps take
  only the first recipient. Put the person who must always get it at the top.
- **Lean angle decays in very long steady corners.** A bike in a balanced turn
  is in equilibrium, so the accelerometer cannot see the lean and the estimate
  leans on the gyroscope, which drifts. It is accurate through transitions and
  normal riding, which is where you actually look at it.
- **Lean needs the mount to stay put.** Calibrate upright once, and recalibrate
  if the clamp slips — a slipping mount reads as a permanent lean.
- **Maps and Spotify need a connection.** Sensors, logging and trips do not.
- **The app must be online to load.** After install it caches, so it opens
  without signal.

---

## Layout

```
_headers          Cloudflare Pages caching and security headers
.nojekyll         stops GitHub Pages running the files through Jekyll
index.html        markup for both panes
css/app.css       everything visual, themes included
js/state.js       config, live state, persistence
js/store.js       localStorage wrapper
js/sensors.js     GPS, motion, lean filter, jolt detection
js/trips.js       trip recording and road scoring
js/spotify.js     PKCE OAuth and Web API
js/gmap.js        Google Maps loader, heading-up rotor
js/dash.js        dashboard rendering
js/logs.js        logs rendering
js/shell.js       pager, tabs, settings, themes, fullscreen
js/app.js         bootstrap and frame loop
```

Everything is stored on the phone. Nothing is uploaded, and there is no account
beyond Spotify's own login.
