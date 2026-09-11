// src/securityHeaders.js — the response headers every Worker response carries,
// applied by the fetch export in src/index.js after the error boundary so the
// two 500s carry them too. It never overrides a header a route already set, and
// it rebuilds the response only when its headers are immutable. The platform
// serves the static assets under public/ before the Worker runs, so those get
// the same set from public/_headers instead.
//
// No script-src or style-src: the pages load the Web Awesome and Font Awesome
// kits plus inline scripts, so a script policy is a separate change.

export const SECURITY_HEADERS = [
  ["strict-transport-security", "max-age=31536000"],
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["content-security-policy", "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'"]
];

function applyMissing(headers) {
  for (const pair of SECURITY_HEADERS) {
    if (!headers.has(pair[0])) {
      headers.set(pair[0], pair[1]);
    }
  }
}

// Returns the same Response when its headers accept the set in place; a
// Response.redirect or fetch()-derived response has immutable headers and comes
// back as a copy carrying the same status, statusText, headers and body.
export function withSecurityHeaders(response) {
  try {
    applyMissing(response.headers);
    return response;
  } catch (err) {
    const copy = new Response(response.body, response);
    applyMissing(copy.headers);
    return copy;
  }
}
