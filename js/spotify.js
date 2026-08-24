/* Spotify remote.

   Authorisation Code with PKCE — no client secret, which is the only flow
   safe to run in a browser. The dash does not play anything itself; it drives
   whichever device is already active, normally the Spotify app on this phone.

   Two conditions worth stating plainly: reading what is playing works on a
   free account, but play, pause and skip return 403 without Premium. And the
   redirect must be an https address, which is why this app is hosted rather
   than opened from a file. */

import * as store from "./store.js";
import { S, settings } from "./state.js";

const AUTH = "https://accounts.spotify.com/authorize";
const TOKEN = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";
const SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing";

const redirectUri = () => location.origin + location.pathname;

function rand(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
}

async function challenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function connect() {
  if (!settings.spotifyId) return false;
  const verifier = rand(48);
  store.set("sp.verifier", verifier);
  const params = new URLSearchParams({
    client_id: settings.spotifyId,
    response_type: "code",
    redirect_uri: redirectUri(),
    code_challenge_method: "S256",
    code_challenge: await challenge(verifier),
    scope: SCOPES
  });
  location.href = AUTH + "?" + params;
  return true;
}

/* Called once at boot. Swaps ?code=… for tokens and cleans the URL so a
   refresh does not try to reuse a spent code. */
export async function handleRedirect() {
  const code = new URLSearchParams(location.search).get("code");
  if (!code) return false;
  const verifier = store.get("sp.verifier", null);
  history.replaceState({}, "", redirectUri());
  if (!verifier || !settings.spotifyId) return false;

  const ok = await exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: settings.spotifyId,
    code_verifier: verifier
  });
  store.del("sp.verifier");
  return ok;
}

async function exchange(body) {
  try {
    const res = await fetch(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body)
    });
    if (!res.ok) return false;
    const j = await res.json();
    store.set("sp.token", {
      access: j.access_token,
      refresh: j.refresh_token || store.get("sp.token", {}).refresh,
      expires: Date.now() + (j.expires_in - 60) * 1000
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function token() {
  const t = store.get("sp.token", null);
  if (!t) return null;
  if (Date.now() < t.expires) return t.access;
  if (!t.refresh) return null;
  const ok = await exchange({
    grant_type: "refresh_token",
    refresh_token: t.refresh,
    client_id: settings.spotifyId
  });
  return ok ? store.get("sp.token", {}).access : null;
}

export function connected() { return !!store.get("sp.token", null); }

export function disconnect() {
  store.del("sp.token");
  S.spotify = null;
}

async function call(path, method = "GET") {
  const access = await token();
  if (!access) return null;
  try {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: "Bearer " + access }
    });
    if (res.status === 204) return { empty: true };
    if (res.status === 403) return { forbidden: true };   // almost always "not Premium"
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

export async function poll() {
  const j = await call("/me/player/currently-playing");
  if (!j || j.empty || !j.item) { S.spotify = connected() ? { idle: true } : null; return; }
  const art = (j.item.album && j.item.album.images || []).slice(-2)[0];
  S.spotify = {
    title: j.item.name,
    artist: (j.item.artists || []).map((a) => a.name).join(", "),
    art: art ? art.url : null,
    ms: j.progress_ms || 0,
    dur: j.item.duration_ms || 1,
    playing: !!j.is_playing
  };
}

export const play  = () => call("/me/player/play", "PUT");
export const pause = () => call("/me/player/pause", "PUT");
export const next  = () => call("/me/player/next", "POST");
export const prev  = () => call("/me/player/previous", "POST");

export async function toggle() {
  if (S.spotify && S.spotify.playing) { await pause(); } else { await play(); }
  await poll();
}
