/* Persistence. Everything lives on this phone; nothing is uploaded.
   Every accessor is guarded — private windows and blocked site data
   throw on access rather than returning empty. */

const PREFIX = "nmax.";

export function get(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

export function set(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;                 // quota or blocked storage: carry on in memory
  }
}

export function del(key) {
  try { localStorage.removeItem(PREFIX + key); } catch (e) { /* nothing to do */ }
}

/* Append to a capped list, oldest dropped first. Used for trips and
   potholes, which would otherwise grow without bound. */
export function push(key, item, cap = 500) {
  const list = get(key, []);
  list.unshift(item);
  if (list.length > cap) list.length = cap;
  set(key, list);
  return list;
}
