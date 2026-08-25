/* ELM327 over Bluetooth LE.

   Two transports behind one queue. The APK's WebView has no Web Bluetooth, so
   the native shell exposes a BLE bridge (NMAXShell.bt*) and reports back
   through window.__nmaxBt; in a plain browser, navigator.bluetooth covers the
   same ground and lets the whole protocol run without the phone.

   The ELM327 is a modem at heart: one command at a time, answer terminated by
   a ">" prompt. Yamaha's bus is K-line, which ATSP0 auto-detects — the first
   engine query can sit in SEARCHING for several seconds, so the probe timeout
   is generous and later ones are not.

   PIDs are probed directly instead of trusting the 0100 support bitmask —
   small-bike ECUs are exactly where the bitmask lies. Fuel (012F) is the one
   expected to be missing; each signal stands alone so a missing fuel gauge
   does not cost the tachometer. */

import { CFG, S, settings, save } from "./state.js";
import * as store from "./store.js";

export const status = {
  state: "idle",          // idle | scanning | connecting | init | probing | polling | error
  transport: null,
  device: "",
  pids: { rpm: null, temp: null, fuel: null },   // null = unknown, true/false = probed
  volts: null,
  error: ""
};

let onChange = () => {};
export function setOnChange(fn) { onChange = fn; }
function set(patch) { Object.assign(status, patch); try { onChange(status); } catch (e) {} }

/* ---------------- transports ---------------- */

const shellT = {
  name: "shell",
  ok() { return !!(window.NMAXShell && typeof window.NMAXShell.btConnect === "function"); },
  scan() { window.NMAXShell.btScan(); },
  stopScan() { try { window.NMAXShell.btStopScan(); } catch (e) {} },
  connect(addr) { window.NMAXShell.btConnect(addr); },
  disconnect() { try { window.NMAXShell.btDisconnect(); } catch (e) {} },
  write(s) { window.NMAXShell.btWrite(s); }
};

const UART_SERVICES = [0xfff0, 0xffe0, 0x18f0, "6e400001-b5a3-f393-e0a9-e50e24dcca9e"];
let webGatt = null, webTx = null;

const webT = {
  name: "webbt",
  ok() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); },
  async pickAndConnect() {
    const dev = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true, optionalServices: UART_SERVICES
    });
    set({ state: "connecting", device: dev.name || "BLE device" });
    dev.addEventListener("gattserverdisconnected", () => events.state("disconnected"));
    webGatt = await dev.gatt.connect();
    const svcs = await webGatt.getPrimaryServices();
    let rx = null, tx = null;
    for (const svc of svcs) {
      const chars = await svc.getCharacteristics();
      let n = null, w = null;
      for (const ch of chars) {
        if (ch.properties.notify) n = n || ch;
        if (ch.properties.write || ch.properties.writeWithoutResponse) w = w || ch;
      }
      if (n && w) { rx = n; tx = w; break; }
    }
    if (!rx || !tx) throw new Error("no UART characteristics");
    webTx = tx;
    rx.addEventListener("characteristicvaluechanged", (e) => {
      events.rx(new TextDecoder("latin1").decode(e.target.value));
    });
    await rx.startNotifications();
    events.state("connected");
  },
  disconnect() { try { if (webGatt) webGatt.disconnect(); } catch (e) {} webGatt = null; webTx = null; },
  write(s) {
    if (!webTx) return;
    const b = new Uint8Array([...s].map((c) => c.charCodeAt(0)));
    (webTx.properties.writeWithoutResponse ? webTx.writeValueWithoutResponse(b) : webTx.writeValue(b)).catch(() => {});
  }
};

let tr = null;
export const hasShell = () => shellT.ok();
export const hasWeb = () => webT.ok();

/* ---------------- command queue ---------------- */

let rxBuf = "";
let pending = null;
let reconnectT = null;
let pollT = null;
let scanCb = () => {};

const events = {
  scan(payload) {
    const i = payload.indexOf("|");
    scanCb({ name: payload.slice(0, i) || "(unnamed)", addr: payload.slice(i + 1) });
  },
  state(s) {
    if (s === "connected") { onConnected(); return; }
    if (s === "disconnected" || s.startsWith("error")) {
      stopPolling();
      const wanted = status.state !== "idle";
      set({ state: s.startsWith("error") ? "error" : "idle", error: s.startsWith("error") ? s.slice(6) : "" });
      S.rpm = null; S.temp = null; S.fuel = null; S.volts = null;
      // A dongle that dropped mid-ride is worth chasing; one the rider
      // disconnected is not.
      if (wanted && settings.obdAddr && !reconnectT) {
        reconnectT = setTimeout(() => { reconnectT = null; connectSaved(); }, 10000);
      }
    }
  },
  rx(text) {
    rxBuf += text;
    const i = rxBuf.indexOf(">");
    if (i < 0) return;
    const chunk = rxBuf.slice(0, i);
    rxBuf = rxBuf.slice(i + 1);
    if (pending) { const p = pending; pending = null; clearTimeout(p.timer); p.resolve(chunk); }
  }
};

window.__nmaxBt = (type, data) => { if (events[type]) events[type](String(data == null ? "" : data)); };

function cmd(c, timeoutMs) {
  return new Promise((resolve) => {
    if (!tr) { resolve(null); return; }
    rxBuf = "";
    pending = { resolve, timer: setTimeout(() => { if (pending) { pending = null; resolve(null); } }, timeoutMs || 1500) };
    tr.write(c + "\r");
  });
}

/* ---------------- protocol ---------------- */

const hexAfter = (resp, marker) => {
  if (!resp) return null;
  const clean = resp.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (clean.includes("NODATA") || clean.includes("UNABLETOCONNECT") || clean.includes("ERROR")) return null;
  const i = clean.lastIndexOf(marker);
  if (i < 0) return null;
  const hex = clean.slice(i + marker.length).replace(/[^0-9A-F]/g, "");
  return hex.length >= 2 ? hex : null;
};

async function onConnected() {
  set({ state: "init", error: "" });
  await cmd("ATZ", 3500);
  for (const c of ["ATE0", "ATL0", "ATS0", "ATH0", "ATSP0"]) await cmd(c, 1500);

  // First engine query wakes the bus — SEARCHING can take a while on K-line.
  set({ state: "probing" });
  await cmd("0100", 9000);

  const probe = async (pid) => {
    for (let i = 0; i < 2; i++) {
      const h = hexAfter(await cmd("01" + pid, 3000), "41" + pid);
      if (h) return true;
    }
    return false;
  };
  const pids = {
    rpm: await probe("0C"),
    temp: await probe("05"),
    fuel: await probe("2F")
  };
  set({ state: "polling", pids });
  startPolling();
}

let pollN = 0;
function startPolling() {
  stopPolling();
  pollT = setInterval(async () => {
    if (pending || !tr) return;
    pollN++;
    if (status.pids.rpm && pollN % 6 !== 0) {
      const h = hexAfter(await cmd("010C", 1200), "410C");
      if (h && h.length >= 4) {
        S.rpm = parseInt(h.slice(0, 4), 16) / 4;
        logBelt(S.rpm);
      }
      return;
    }
    // Temp gets two of every four slow slots: it drives the warm-up ceiling,
    // and a five-second-stale coolant reading makes that feature feel broken.
    const slot = ["temp", "fuel", "temp", "volts"][Math.floor(pollN / 6) % 4];
    if (slot === "temp" && status.pids.temp) {
      const h = hexAfter(await cmd("0105", 1500), "4105");
      if (h) S.temp = parseInt(h.slice(0, 2), 16) - 40;
    } else if (slot === "fuel" && status.pids.fuel) {
      const h = hexAfter(await cmd("012F", 1500), "412F");
      if (h) S.fuel = +(parseInt(h.slice(0, 2), 16) / 255 * CFG.tank).toFixed(2);
    } else {
      const r = await cmd("ATRV", 1500);
      const m = r && /([0-9]+\.?[0-9]*)V/i.exec(r);
      if (m) { S.volts = status.volts = +m[1]; logVolts(status.volts); set({}); }
    }
  }, 320);
}

function stopPolling() { if (pollT) { clearInterval(pollT); pollT = null; } pollN = 0; }

/* ---------------- public flow ---------------- */

export function startScan(cb) {
  if (!shellT.ok()) return false;
  tr = shellT;
  scanCb = cb;
  set({ state: "scanning", transport: "shell" });
  shellT.scan();
  return true;
}
export function stopScan() { if (tr === shellT) shellT.stopScan(); }

export function connectTo(addr, name) {
  if (!shellT.ok()) return;
  tr = shellT;
  save({ obdAddr: addr, obdName: name || "" });
  set({ state: "connecting", transport: "shell", device: name || addr, error: "" });
  shellT.connect(addr);
}

export function connectSaved() {
  if (settings.obdAddr && shellT.ok()) connectTo(settings.obdAddr, settings.obdName);
}

export async function connectWeb() {
  if (!webT.ok()) return false;
  tr = webT;
  set({ transport: "webbt", error: "" });
  try { await webT.pickAndConnect(); return true; }
  catch (e) { set({ state: "error", error: e.message || "cancelled" }); return false; }
}

export function disconnect() {
  if (reconnectT) { clearTimeout(reconnectT); reconnectT = null; }
  stopPolling();
  save({ obdAddr: "", obdName: "" });
  if (tr) tr.disconnect();
  set({ state: "idle", device: "", error: "" });
  S.rpm = null; S.temp = null; S.fuel = null; S.volts = null;
}

export const connected = () => status.state === "polling" || status.state === "probing" || status.state === "init";

/* ---------------- weekly health logs ----------------
   Belt: RPM samples while holding 55-65 km/h — the stretch shows as the same
   speed costing more revs over the weeks. Battery: the lowest voltage seen
   each week, which sags as a battery dies. Buffered in memory, flushed lazily. */

let beltBuf = null, beltDirty = false, lastBeltAt = 0, lastFlush = 0;

function weekKey(t) {
  const d = new Date(t || Date.now());
  const jan = new Date(d.getFullYear(), 0, 1);
  const wk = Math.ceil((((d - jan) / 864e5) + jan.getDay() + 1) / 7);
  return d.getFullYear() + "-W" + String(wk).padStart(2, "0");
}

function logBelt(rpm) {
  const now = Date.now();
  if (now - lastBeltAt < 1000 || S.speed < 55 || S.speed > 65) return;
  lastBeltAt = now;
  if (!beltBuf) beltBuf = store.get("belt", {});
  const wk = weekKey();
  const arr = beltBuf[wk] || (beltBuf[wk] = []);
  if (arr.length < 400) { arr.push(Math.round(rpm)); beltDirty = true; }
  if (now - lastFlush > 15000) flushHealth();
}

function logVolts(v) {
  const all = store.get("batt", {});
  const wk = weekKey();
  if (all[wk] == null || v < all[wk]) { all[wk] = v; store.set("batt", all); }
}

export function flushHealth() {
  lastFlush = Date.now();
  if (beltDirty && beltBuf) { store.set("belt", beltBuf); beltDirty = false; }
}

export function beltWeeks() {
  if (!beltBuf) beltBuf = store.get("belt", {});
  return Object.keys(beltBuf).sort().map((k) => {
    const a = beltBuf[k].slice().sort((x, y) => x - y);
    return { week: k, n: a.length, median: a.length ? a[a.length >> 1] : 0 };
  }).filter((w) => w.n >= 5);
}
export function battWeeks() {
  const all = store.get("batt", {});
  return Object.keys(all).sort().map((k) => ({ week: k, min: all[k] }));
}
