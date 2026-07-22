// src/clients/srfParser.js
// Pure regex parser for NWS Surf Zone Forecast (SRF) text products. No fetch,
// no Date, no env access — this module never throws and never mutates input.

// Ordered most-specific/most-common first; parseRipCurrentRisk returns the first
// regex that matches anywhere in the product (each regex itself matches its
// FIRST occurrence, so a multi-period product resolves to the earliest period).
// The ocean "Rip Current Risk" wordings (regexes 0-2) are listed BEFORE the
// Great Lakes "Swim Risk" variant (regex 3) so any product carrying the explicit
// rip wording keeps resolving exactly as before; the Swim Risk regex only fires
// on Great Lakes beach-hazard products that use that label and no rip wording.
// NWS Great Lakes forecasts express the swimming hazard as "SWIM RISK...HIGH"
// (High/Moderate/Low), which maps onto the same HIGH/MODERATE/LOW the estimator
// already consumes via ripCurrentRisk.
const RISK_REGEXES = [
  /RIP\s+CURRENT\s+RISK[\s.:]*(?:IS\s+)?[\s.]*\b(HIGH|MODERATE|LOW)\b/i,
  /\b(HIGH|MODERATE|LOW)\s+RISK\s+OF\s+RIP\s+CURRENTS?/i,
  /RISK\s+OF\s+RIP\s+CURRENTS?\s+(?:IS|WILL\s+BE|REMAINS)\s+(HIGH|MODERATE|LOW)/i,
  /SWIM\s+RISK[\s.:]*(?:IS\s+)?[\s.]*\b(HIGH|MODERATE|LOW)\b/i
];

export function parseRipCurrentRisk(srfText) {
  if (!srfText) {
    return null;
  }
  for (let i = 0; i < RISK_REGEXES.length; i++) {
    const match = RISK_REGEXES[i].exec(srfText);
    if (match) {
      return match[1].toUpperCase();
    }
  }
  return null;
}
