/* Configuration, live state, and the settings that outlive a session. */

import * as store from "./store.js";

export const CFG = {
  tank: 7.1,              // litres, NMAX v3
  kmPerL: 47,             // used for range once fuel is readable
  leanMax: 48,            // dial travel each way
  joltThreshold: 5.0,     // m/s^2 of vertical deviation that counts as a hit
  joltMinSpeed: 8,        // km/h — ignore jolts while parked or handling the phone
  joltDebounce: 400,      // ms between recorded hits
  warmC: 60,              // coolant target, once OBD lands
  crashDecel: 8,          // m/s^2 sustained deceleration
  crashStillMs: 30000,    // no movement after the hit before we prompt
  crashCountdown: 12      // seconds to cancel
};

/* Live values. Anything sourced from OBD stays null until a dongle is
   connected — null renders as a dash, which is honest, where 0 would lie. */
export const S = {
  speed: 0, heading: 0, lat: null, lng: null, accuracy: null,
  gpsOk: false, lastFix: 0,
  lean: 0, leanRaw: 0, maxL: 0, maxR: 0, accel: 0,
  rpm: null, fuel: null, temp: null, volts: null,
  moving: false, tripId: null,
  spotify: null,
  nearJolt: null
};

const defaults = {
  theme: "emerald",
  invertLean: false,
  wakeLock: true,
  effects: true,
  edgeInset: "curved",
  numeralFont: "auto",
  crashDetect: true,
  contacts: [],
  alertChannel: "sms",
  smsTemplate: "I may have crashed. Last known position: {link}",
  speedLimit: 60,
  mapProvider: "osm",
  mapKey: "",
  spotifyId: "",
  odoOffset: 0,
  setupDone: false
};

export const settings = Object.assign({}, defaults, store.get("settings", {}));

/* An earlier build stored a single bare number. Fold it into the list so the
   setting is not silently lost on upgrade. */
if (settings.iceNumber && !settings.contacts.length) {
  settings.contacts = [{ name: "Emergency contact", tel: settings.iceNumber }];
  delete settings.iceNumber;
  store.set("settings", settings);
}

export function save(patch) {
  Object.assign(settings, patch);
  store.set("settings", settings);
}

export const SERVICE_DEFAULTS = [
  { n: "Engine oil",        every: 3000,  last: 0 },
  { n: "V-belt",            every: 24000, last: 0 },
  { n: "Rollers / weights", every: 24000, last: 0 },
  { n: "Gear oil",          every: 12000, last: 0 },
  { n: "Spark plug",        every: 10000, last: 0 },
  { n: "Air filter",        every: 15000, last: 0 },
  { n: "Valve clearance",   every: 24000, last: 0 },
  { n: "Coolant",           every: 24000, last: 0 }
];
