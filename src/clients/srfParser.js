// src/clients/srfParser.js
// Pure regex parser for NWS Surf Zone Forecast (SRF) text products. No fetch,
// no Date, no env access — this module never throws and never mutates input.

const RISK_REGEXES = [
  /RIP\s+CURRENT\s+RISK[\s.:]*(?:IS\s+)?[\s.]*\b(HIGH|MODERATE|LOW)\b/i,
  /\b(HIGH|MODERATE|LOW)\s+RISK\s+OF\s+RIP\s+CURRENTS?/i,
  /RISK\s+OF\s+RIP\s+CURRENTS?\s+(?:IS|WILL\s+BE|REMAINS)\s+(HIGH|MODERATE|LOW)/i
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
