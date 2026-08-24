/* Emergency messaging.

   No web app can send an SMS on its own — there is no API for it on any
   platform, by design. What this does is compose the message and hand it to
   the messaging app with recipients and body already filled in, so the rider
   taps send once. That is the whole honest extent of it.

   Contacts come from the Contact Picker API where the browser has it (Chrome
   on Android), which means no contacts permission and no address book access —
   the picker runs in the browser's own UI and returns only what was chosen. */

import { settings, save } from "./state.js";

export const MAX_CONTACTS = 3;

/* How the alert leaves the phone.

   SMS is the default on purpose: it is the only one that works with no data,
   which is exactly the situation a crash can leave you in. Viber and the share
   sheet are richer but both need a connection, and neither can address a
   specific person from a link — Viber's scheme prefills the text and then asks
   who to send it to. */
export const CHANNELS = [
  { id: "sms",   label: "SMS",   note: "Works with no data. Most reliable when it matters." },
  { id: "share", label: "Share", note: "Android share sheet — Viber, Messenger, anything installed." },
  { id: "viber", label: "Viber", note: "Opens Viber with the text ready; you pick who." }
];

export const channel = () => settings.alertChannel || "sms";
export const shareSupported = () => !!(navigator.share && window.isSecureContext);

/* Viber exposes no way to prefill a message to a given number — chat?number=
   opens the thread but drops any text. forward?text= keeps the message, which
   for an emergency is the half that matters, and costs one tap to choose the
   recipient. */
export const viberHref = (body) => "viber://forward?text=" + encodeURIComponent(body);

/* Whether the chosen channel has everything it needs. Only SMS addresses a
   person from the link, so only SMS requires a saved contact. */
export function ready() {
  return channel() === "sms" ? contacts().length > 0 : true;
}

/* Keep only characters a dialer will accept. Notably the leading + must
   survive: percent-encoding it breaks some messaging apps. */
export const cleanTel = (t) => String(t || "").replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");

export function contacts() {
  return (settings.contacts || []).filter((c) => c && c.tel);
}

export function addContact(c) {
  const tel = cleanTel(c.tel);
  if (!tel) return false;
  const list = contacts();
  if (list.some((x) => x.tel === tel)) return false;
  if (list.length >= MAX_CONTACTS) return false;
  list.push({ name: (c.name || "Contact").trim().slice(0, 40), tel });
  save({ contacts: list });
  return true;
}

export function removeContact(tel) {
  save({ contacts: contacts().filter((c) => c.tel !== tel) });
}

export function pickerSupported() {
  return !!(navigator.contacts && typeof navigator.contacts.select === "function" && window.isSecureContext);
}

/* Must be called straight from a user gesture — the picker is dismissed
   otherwise. Returns null on cancel or on any browser without it. */
export async function pick() {
  if (!pickerSupported()) return null;
  try {
    const props = await navigator.contacts.getProperties();
    if (!props.includes("tel")) return null;
    const want = props.includes("name") ? ["name", "tel"] : ["tel"];
    const sel = await navigator.contacts.select(want, { multiple: false });
    if (!sel || !sel.length) return null;
    const c = sel[0];
    const tel = (c.tel || []).find(Boolean);
    if (!tel) return null;
    return { name: (c.name || []).find(Boolean) || "Contact", tel };
  } catch (e) {
    return null;                       // cancelled, or blocked by the browser
  }
}

export function template() {
  return settings.smsTemplate || "I may have crashed. Last known position: {link}";
}

export function compose(lat, lng, { test = false } = {}) {
  const link = lat === null || lat === undefined
    ? "location unavailable"
    : "https://maps.google.com/?q=" + lat.toFixed(5) + "," + lng.toFixed(5);
  const body = template().replace(/\{link\}/g, link);
  return test ? "[TEST — no emergency] " + body : body;
}

/* Recipients joined with a comma. Google Messages handles a multi-recipient
   sms: link; some third-party apps take only the first, which is why the
   contact at the top of the list is the one that matters. */
export function href(body) {
  const to = contacts().map((c) => c.tel).join(",");
  return "sms:" + to + "?body=" + encodeURIComponent(body);
}

/* Hand the message off.

   navigator.share needs transient user activation, so an auto-fire at the end
   of the crash countdown is rejected by the browser. That is why the crash
   screen always ends on a real button as well: the automatic attempt is best
   effort, the button is the guarantee. */
export async function deliver(body) {
  const ch = channel();

  if (ch === "share") {
    if (!shareSupported()) return "unsupported";
    try {
      await navigator.share({ text: body });
      return "sent";
    } catch (e) {
      return e && e.name === "AbortError" ? "cancelled" : "blocked";
    }
  }

  if (ch === "viber") {
    location.href = viberHref(body);
    return "opened";
  }

  if (!contacts().length) return "nocontact";
  location.href = href(body);
  return "opened";
}

export function send(body) {
  if (!contacts().length) return false;
  location.href = href(body);
  return true;
}
