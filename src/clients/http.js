// src/clients/http.js — the shared fetch, ok-check, JSON-parse, log-and-null
// wrapper for every client in this directory. It owns the transport and error
// layer so each client keeps only its own headers, request body and post-parse
// steps, and every one of them honors the same data-or-null contract.
//
// opts: { method, headers, body, label, timeoutMs }. label prefixes every log
// line, so callers pass their module tag plus any per-request detail.
//
// timeoutMs bounds a request at the transport layer via AbortController, and it
// is armed only when timeoutMs > 0, so a call site that omits it is genuinely
// unbounded. fetchJson returns the parsed JSON on success, null on any failure.
// fetchJsonWithStatus returns { json, status } instead: status is the HTTP
// status whenever a response arrived (json is null unless it was 2xx and
// parsed) and null when the request threw or timed out, so a caller can tell a
// definitive answer such as a 404 from a transient failure. Neither throws.

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
      return { json: null, status: response.status };
    }
    return { json: await response.json(), status: response.status };
  } catch (err) {
    console.log(label + " fetch failed: " + err.message);
    return { json: null, status: null };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}
