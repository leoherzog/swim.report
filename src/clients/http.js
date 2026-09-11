// src/clients/http.js — the shared fetch, ok-check, JSON-parse, log-and-null
// wrapper for every client in this directory. It owns the transport and error
// layer so each client keeps only its own headers, request body and post-parse
// steps, and every one of them honors the same data-or-null contract.
//
// opts: { method, headers, body, label, timeoutMs }. label prefixes every log
// line, so callers pass their module tag plus any per-request detail.
//
// Every request is bounded: init.signal is always AbortSignal.timeout(ms), where
// ms is timeoutMs when it is a number > 0 and DEFAULT_TIMEOUT_MS otherwise. A hung
// request rejects with a TimeoutError and degrades to null through the same
// catch as any other failure, so no call site can run a cron to the 900 s
// scheduled ceiling. fetchJson returns the parsed JSON on success, null on any
// failure. fetchJsonWithStatus returns { json, status } instead: status is the
// HTTP status whenever a response arrived (json is null unless it was 2xx and
// parsed) and null when the request threw or timed out, so a caller can tell a
// definitive answer such as a 404 from a transient failure. Neither throws.

// Shared with src/officialSources/util.js#fetchText, so every Worker-side
// upstream fetch carries the same default bound.
export const DEFAULT_TIMEOUT_MS = 30000;

// Releases an unread response body. Never awaited and never throws: a cancel
// that throws or rejects must not turn a definitive HTTP status into a
// transport failure.
export function cancelBody(response) {
  if (!response || !response.body || typeof response.body.cancel !== "function") {
    return;
  }
  try {
    const pending = response.body.cancel();
    if (pending && typeof pending.catch === "function") {
      pending.catch(function () {});
    }
  } catch (err) {
    // A synchronous throw from cancel is swallowed for the same reason.
  }
}

export async function fetchJson(url, opts) {
  const result = await fetchJsonWithStatus(url, opts);
  return result.json;
}

export async function fetchJsonWithStatus(url, opts) {
  const options = opts || {};
  const label = options.label || "";
  const init = {};
  if (options.method) {
    init.method = options.method;
  }
  if (options.headers) {
    init.headers = options.headers;
  }
  if (options.body !== undefined) {
    init.body = options.body;
  }
  // A non-number, zero or negative timeoutMs falls to the default rather than
  // reaching AbortSignal.timeout, which throws on a negative value.
  const ms = typeof options.timeoutMs === "number" && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  init.signal = AbortSignal.timeout(ms);
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      console.log(label + " fetch failed: HTTP " + response.status);
      cancelBody(response);
      return { json: null, status: response.status };
    }
    return { json: await response.json(), status: response.status };
  } catch (err) {
    console.log(label + " fetch failed: " + err.message);
    return { json: null, status: null };
  }
}
