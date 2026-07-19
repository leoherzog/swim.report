// src/clients/http.js
// Shared fetch -> ok-check -> JSON-parse -> log-and-null wrapper for the API
// clients in this directory. Every client here honors the same data-or-null
// contract: any network error, non-2xx status, or JSON parse failure is
// caught, logged with console.log, and resolved to null — never thrown across
// a module boundary. This helper owns that transport/error layer so each
// client keeps only its own headers, request body, and post-parse steps.
//
// opts: { method, headers, body, label, timeoutMs }. label prefixes every log
// line, so callers pass their module tag plus any per-request detail — e.g.
// "nws: alerts for MIZ001" logs as "nws: alerts for MIZ001 fetch failed:
// HTTP 503". timeoutMs (optional) bounds a request at the transport layer via
// AbortController — a hung connection aborts and resolves to null instead of
// blocking forever (used by the Overpass mirror failover so a dead mirror
// yields to the next one). Returns the parsed JSON on success, null on any
// failure.

export async function fetchJson(url, opts) {
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
  let timer = null;
  if (options.timeoutMs && options.timeoutMs > 0) {
    const controller = new AbortController();
    init.signal = controller.signal;
    timer = setTimeout(function () { controller.abort(); }, options.timeoutMs);
  }
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      console.log(label + " fetch failed: HTTP " + response.status);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.log(label + " fetch failed: " + err.message);
    return null;
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}
