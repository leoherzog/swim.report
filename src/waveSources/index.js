// src/waveSources/index.js
// Registry of SUPPLEMENTAL fallback wave-height sources. These are consulted
// ONLY for beaches whose primary wave height (Open-Meteo marine batch + GLOS
// Seagull buoy gap-fill) came back null. They are an ORDERED FALLBACK, never
// additive and never double-counted: the first matching source that returns a
// finite wave height wins, and everything downstream (the flag's wave-height
// rule, the source badge) treats it exactly like the primary reading — only its
// provenance (the model id) differs.
//
// Rip-current signal deliberately does NOT belong here — it converges from
// three places already and the SRF client stays primary. This registry is
// wave-height ONLY.
//
// Runs cron-side ONLY (two-path rule): resolveSupplementalWaveFt fetches
// upstream and is reachable only from runWaveRefresh. The request path never
// imports this module's network code.
//
// Registering a source: author the source module, import it here, and append it
// to waveSources. The scaffolding (this file + the runWaveRefresh step-2b
// consult) does the rest — these are consulted ONLY when the primary
// Open-Meteo/GLOS wave height is null, in array order, first finite value wins.
//
// Source object shape:
//   {
//     id:    stable kebab string, for log lines.
//     model: stable model id stamped onto the wave input (drives the source
//            badge via WAVE_MODEL_LABELS / waveSourceUrl in src/index.js).
//     label: human-readable model name for WAVE_MODEL_LABELS.
//     url:   human-readable provenance page for waveSourceUrl.
//     matches(beach): pure boolean — true ONLY if the beach carries the key
//            this source needs (gridpoint: beach.nws_grid_url; NSH:
//            beach.marine_zone; NDBC/SeaCaves: lat/lon; Toronto: bbox/lat-lon).
//     keyOf(beach): OPTIONAL pure string|null — the SHARED fetch key for this
//            beach, so the run-scoped memo can fetch each unique key ONCE and
//            fan the result to every beach sharing it (gridpoint: nws_grid_url;
//            NSH: marine_zone; NDBC: nearest station id; SeaCaves: a constant,
//            single fixed point). Return null (or omit keyOf) for a per-beach
//            source whose reading is NOT shared across beaches (Toronto, whose
//            fetch self-memoizes but whose parse differs per beach) — the memo
//            then leaves that source un-deduped. The key must FULLY determine
//            waveFt's result: two beaches with the same key MUST resolve to the
//            same ft, since the memo reuses one beach's result for the others.
//     waveFt(beach, nowIso, env): async, CRON-SIDE ONLY. Returns a finite ft
//            number or null. Parse DEFENSIVELY — a schema change upstream must
//            degrade to null, never a wrong height (which would mis-color a
//            flag). MUST NOT throw across the module boundary.
//   }
//
// SUBREQUEST-BUDGET NOTE for future sources: a naive per-beach fetch loop can
// issue up to one fetch per wave-null beach PER source, blowing the
// per-invocation subrequest budget on a fully wave-null run (winter). Sources
// that share a key across beaches (gridpoint by nws_grid_url, NSH by
// marine_zone, NDBC by nearest buoy id) MUST dedup by that key and fan one
// fetch to all beaches sharing it, mirroring glerl.js's platform dedup. This is
// implemented HERE, not in each source: a source exposes keyOf(beach) and
// resolveSupplementalWaveFt takes a run-scoped memo (Map, created once per run
// by the runWaveRefresh step-2b consult) that fetches each unique (source,key)
// ONCE and caches the ft-or-null result for every later beach sharing it.
// Ordered = fallback precedence (resolveSupplementalWaveFt breaks on the first
// matching source that returns a finite ft):
//   1. gridpoint  — keyed on beach.nws_grid_url (precise NWS forecast cell)
//   2. nsh        — keyed on beach.marine_zone (nearshore marine forecast text)
//   3. seaCaves   — single UW-Madison Lake Superior gauge (proximity)
//   4. toronto    — 10 curated Lake Ontario beaches (self-memoized per run)
//   5. ndbc       — broad nearest-buoy net (lat/lon within 40 km) — last resort
// Key-shaped US sources first, the specialized regional gauges next, the broad
// buoy net last. All are wave-height ONLY (never rip) and consulted ONLY for
// beaches still wave-null after Open-Meteo + GLOS — never additive.
import { nwsGridpointWaveSource } from "./nwsGridpointWaves.js";
import { nwsNshNearshoreSource } from "./nwsNshNearshore.js";
import { seaCavesSource } from "./seaCavesWaves.js";
import { torontoBeachObsSource } from "./torontoBeachObs.js";
import { ndbcBuoySource } from "./ndbcBuoys.js";

export const waveSources = [
  nwsGridpointWaveSource,
  nwsNshNearshoreSource,
  seaCavesSource,
  torontoBeachObsSource,
  ndbcBuoySource
];

// Alias under the R2-design name, so either import spelling resolves.
export { waveSources as SUPPLEMENTAL_WAVE_SOURCES };

// Cron-side ONLY. Run-scoped dedup: resolve ONE source for ONE beach, reusing a
// prior finite-or-null result for any other beach that shares this source's
// keyOf(beach). memo (optional) is a Map created once per run by the step-2b
// consult, keyed "source.id|key". A source without keyOf, or one whose keyOf
// returns a non-string/empty key, is NOT deduped (fetched per beach). The
// cached value is the raw ft-or-null, so a null (miss) is fanned out too and
// the duplicate fetch is skipped even on a fully wave-null run. Never throws.
async function resolveSourceWaveFt(source, beach, nowIso, env, memo) {
  let key = null;
  if (memo && typeof source.keyOf === "function") {
    try {
      key = source.keyOf(beach);
    } catch (err) {
      console.log(
        "waveSources: keyOf() threw for " + source.id +
        " beach " + beach.id + ": " + err.message
      );
      key = null;
    }
  }
  const memoKey = (memo && typeof key === "string" && key.length > 0)
    ? source.id + "|" + key
    : null;
  if (memoKey !== null && memo.has(memoKey)) {
    return memo.get(memoKey);
  }
  let ft = null;
  try {
    ft = await source.waveFt(beach, nowIso, env);
  } catch (err) {
    console.log(
      "waveSources: " + source.id + " threw for beach " + beach.id +
      ": " + err.message
    );
    ft = null;
  }
  if (typeof ft !== "number" || !isFinite(ft)) {
    ft = null;
  }
  if (memoKey !== null) {
    memo.set(memoKey, ft);
  }
  return ft;
}

// Cron-side ONLY. Tries each matching source in registry order for a single
// wave-null beach and returns the FIRST finite result, WITH its provenance, so
// the caller can stamp the correct model on the wave input (never a generic
// "Wave Forecast" that would mislabel the source badge — see src/index.js
// WAVE_MODEL_LABELS). Returns:
//   { waveHeightFt: number, model: string, label: string, url: string }  or null
// Pass a run-scoped memo (Map) so sources that share a fetch key across beaches
// (gridpoint/NSH/NDBC/SeaCaves via keyOf) fetch each unique key ONCE per run and
// fan the result to every beach sharing it — mirroring glerl.js's platform
// dedup. Semantics are otherwise UNCHANGED (ordered fallback, first finite value
// wins, never additive): the memo only skips duplicate upstream fetches, since a
// source's keyOf fully determines its waveFt result. Never throws — a source
// that throws is isolated and treated as "no reading" so one bad upstream never
// starves the beach or the run. With the empty registry this always returns
// null, so runWaveRefresh behavior is unchanged.
export async function resolveSupplementalWaveFt(beach, nowIso, env, memo) {
  for (let i = 0; i < waveSources.length; i++) {
    const source = waveSources[i];
    let matched = false;
    try {
      matched = source.matches(beach) === true;
    } catch (err) {
      console.log(
        "waveSources: matches() threw for " + source.id +
        " beach " + beach.id + ": " + err.message
      );
      matched = false;
    }
    if (!matched) {
      continue;
    }
    const ft = await resolveSourceWaveFt(source, beach, nowIso, env, memo);
    if (typeof ft === "number" && isFinite(ft)) {
      return {
        waveHeightFt: ft,
        model: source.model,
        label: source.label,
        url: source.url
      };
    }
  }
  return null;
}
