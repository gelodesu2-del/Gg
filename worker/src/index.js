/* Flood and road-closure feed for the NMAX dash.
 *
 * Traffic is not here on purpose. Google already routes around it with live
 * data, and no model is going to beat that. What no routing API has for Metro
 * Manila is flooding and short-notice closures — those live in prose, on MMDA
 * and PAGASA pages and in the news, which is exactly the shape of problem a
 * model is good at: read the mess, emit geofences.
 *
 * This is a separate Worker from the dash on purpose. The dash is static files
 * with no build step; bolting a function onto it would put a working
 * deployment at risk for a feature that is allowed to fail. If this Worker is
 * down, the dash simply has no hazards.
 *
 * Cost is controlled by the cache, not by a cron. A cron scanning for floods at
 * 3am while the bike is parked is most of the bill for none of the value, so
 * the model only runs when a rider actually asks and the cached answer has
 * aged out.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const CACHE_MINUTES = 20;
const GRID = 0.25;                 // ~25 km cells: one answer serves a metro area
const DEFAULT_MODEL = "claude-opus-5";

/* Where the model is allowed to read. Anything outside this list is not a
   source, it is a rumour. */
const SOURCES = [
  "mmda.gov.ph",
  "pagasa.dost.gov.ph",
  "dpwh.gov.ph",
  "ndrrmc.gov.ph",
  "gmanetwork.com",
  "inquirer.net",
  "philstar.com",
  "rappler.com",
  "abs-cbn.com",
  "manilatimes.net"
];

const Hazard = z.object({
  kind: z.enum(["flood", "closure"]),
  road: z.string().describe("The road or intersection, as a rider would name it"),
  area: z.string().describe("City or barangay, for disambiguation"),
  lat: z.number(),
  lng: z.number(),
  radius_m: z.number().describe("How far along the road the report plausibly extends"),
  severity: z.enum(["passable", "impassable", "unknown"]),
  reported: z.string().describe("ISO 8601 timestamp of the report itself, not of this reply"),
  confidence: z.enum(["low", "medium", "high"]),
  source: z.string().describe("URL of the page this came from")
});

const Report = z.object({
  hazards: z.array(Hazard),
  checked: z.string().describe("One short sentence naming what was actually found or not found")
});

const SYSTEM = `You compile road hazards for a motorcycle rider in Metro Manila.

Report only flooding and road closures. Never report traffic congestion — the
rider's map already handles that with live traffic data, and a congestion entry
here is noise that buries the entries that matter.

Rules that decide whether an entry is worth making:
- Only what is plausibly still true right now. A flood report from yesterday
  morning is history unless the source says it persists.
- Coordinates must be the actual road named in the report. If you cannot place
  a report on a specific stretch of road, leave it out rather than guessing a
  city centre.
- One entry per stretch of road. Two outlets covering the same flood is one
  hazard, not two.
- confidence "high" only for an official advisory (MMDA, PAGASA, DPWH, NDRRMC).
  News reporting is "medium". Anything you are inferring is "low".
- An empty list is the correct and common answer on a dry day. Say so in
  "checked" and return no hazards. Do not invent entries to look useful.

A rider will act on this at speed. A missed hazard costs them a wet ride; an
invented one sends them the long way round for nothing. Both are real costs.`;

function cell(lat, lng) {
  return (Math.round(lat / GRID) * GRID).toFixed(2) + "," +
         (Math.round(lng / GRID) * GRID).toFixed(2);
}

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({
      "content-type": "application/json; charset=utf-8",
      // The dash is served from another origin, and this answer is not secret.
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    }, extra || {})
  });
}

async function compile(env, lat, lng) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const messages = [{
    role: "user",
    content: "Search for flooding and road closures affecting motorcycle riders within " +
      "about 25 km of " + lat.toFixed(3) + ", " + lng.toFixed(3) + " (Metro Manila). " +
      "Today is " + new Date().toISOString().slice(0, 10) + ". " +
      "Check the official advisories first, then news. Report only what is still " +
      "in effect."
  }];

  // A server-tool turn can stop with pause_turn, which is not an error and not
  // an answer: push the paused turn back and let it carry on.
  for (let i = 0; i < 4; i++) {
    const res = await client.beta.messages.create({
      model: env.MODEL || DEFAULT_MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: zodOutputFormat(Report) },
      tools: [{
        type: "web_search_20260209",
        name: "web_search",
        max_uses: 8,
        allowed_domains: SOURCES
      }],
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: messages
    });

    if (res.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: res.content });
      continue;
    }
    if (res.stop_reason === "refusal") {
      return { hazards: [], checked: "The model declined this request.", usage: res.usage };
    }
    for (const block of res.content) {
      if (block.type === "text" && block.text) {
        try {
          const parsed = Report.parse(JSON.parse(block.text));
          return { hazards: parsed.hazards, checked: parsed.checked, usage: res.usage };
        } catch (e) {
          return { hazards: [], checked: "Could not read the model's answer.", usage: res.usage };
        }
      }
    }
    return { hazards: [], checked: "No answer returned.", usage: res.usage };
  }
  return { hazards: [], checked: "Gave up after four paused turns." };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type"
      }});
    }
    if (url.pathname !== "/hazards") return json({ error: "not found" }, 404);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "worker has no API key" }, 500);

    // Presence first: Number(null) is 0, and a missing fix would otherwise
    // pass validation and send a scan to the Gulf of Guinea.
    const rawLat = url.searchParams.get("lat"), rawLng = url.searchParams.get("lng");
    if (rawLat === null || rawLng === null || rawLat === "" || rawLng === "") {
      return json({ error: "lat and lng required" }, 400);
    }
    const lat = Number(rawLat), lng = Number(rawLng);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return json({ error: "lat and lng out of range" }, 400);
    }

    const key = "hz:" + cell(lat, lng);
    if (env.HAZARDS) {
      const hit = await env.HAZARDS.get(key, "json");
      if (hit && Date.now() - hit.at < CACHE_MINUTES * 60000) {
        return json({ at: hit.at, cached: true, hazards: hit.hazards, checked: hit.checked });
      }
    }

    let out;
    try {
      out = await compile(env, lat, lng);
    } catch (e) {
      // A failed scan must not look like "no hazards": say nothing was checked.
      return json({ at: Date.now(), hazards: [], checked: "", error: String(e && e.message || e) }, 502);
    }

    const body = { at: Date.now(), hazards: out.hazards, checked: out.checked };
    if (env.HAZARDS) {
      // TTL a little past the freshness window, so a stale entry cannot be
      // served but the namespace still tidies itself.
      await env.HAZARDS.put(key, JSON.stringify(body), { expirationTtl: CACHE_MINUTES * 60 * 3 });
    }
    return json(Object.assign({ cached: false }, body));
  }
};
