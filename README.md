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
| Map | Google Maps JS API |
| Music | Spotify Web API |

Anything needing engine data shows a dash until the dongle is connected.

---

## Setup

### 1. Host it

Push this repo and turn on GitHub Pages (Settings → Pages → deploy from
branch). You get an HTTPS address, which both Google and Spotify require.

### 2. Google Maps key

1. [Google Cloud console](https://console.cloud.google.com/) → new project
2. Enable **Maps JavaScript API**
3. Credentials → create an API key
4. **Restrict it** to HTTP referrers, and add your Pages address

An unrestricted key on a public page is the one mistake here that costs real
money. For one rider on one phone the usage itself sits far inside the free
tier.

### 3. Spotify client ID

1. [Spotify developer dashboard](https://developer.spotify.com/dashboard) → create an app
2. Add your Pages address as a **Redirect URI** (exactly, including any trailing path)
3. Copy the Client ID

Playback control requires **Spotify Premium**. On a free account the dash shows
what is playing but the transport buttons do nothing — that is Spotify's
restriction, not a bug here.

### 4. On the phone

Open the address in Chrome, paste both keys into the setup screen, grant
location and motion, then **Add to Home Screen**. It opens fullscreen with no
browser chrome.

---

## Honest limitations

- **Crash detection cannot send an SMS by itself.** No web app can. It detects
  the impact, counts down, and opens your messaging app with the location
  prefilled — you still tap send. A fully automatic alert needs a webhook
  (Telegram bot or similar); say the word and it is about thirty lines.
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
