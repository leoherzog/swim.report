// src/publicId.js — the beach id a URL carries: a one-letter OSM element type
// marker (n node, w way, r relation) followed by the OSM id, "n354000095".
// Storage keeps the "osm-<type>-<n>" form discovery mints, so this module is
// the only conversion between the two and it runs at the request-path edge and
// at the renderers' emission sites.
//
// Pure: no imports, no state. Both patterns require a leading non-zero digit,
// so one beach has exactly one canonical URL.

const PUBLIC_ID_PATTERN = /^([nwr])([1-9][0-9]*)$/;
const STORAGE_ID_PATTERN = /^osm-(node|way|relation)-([1-9][0-9]*)$/;

const MARKER_BY_TYPE = { node: "n", way: "w", relation: "r" };
const TYPE_BY_MARKER = { n: "node", w: "way", r: "relation" };

// The public form of a storage id, or null when the argument is not one. A row
// read from D1 always converts; an emission site handed anything else is free
// to fall back to the id it has, which the two single-beach routes redirect.
export function toPublicId(dbId) {
  if (typeof dbId !== "string") {
    return null;
  }
  const match = dbId.match(STORAGE_ID_PATTERN);
  if (!match) {
    return null;
  }
  return MARKER_BY_TYPE[match[1]] + match[2];
}

// The storage id a public segment names, or null for anything else.
export function fromPublicId(segment) {
  if (typeof segment !== "string") {
    return null;
  }
  const match = segment.match(PUBLIC_ID_PATTERN);
  if (!match) {
    return null;
  }
  return "osm-" + TYPE_BY_MARKER[match[1]] + "-" + match[2];
}

// A storage id given as a URL segment, returned unchanged, or null. It is what
// lets the two single-beach routes redirect a link minted before the public
// form and what keeps a visitor's stored ids working in ?ids=.
export function fromLegacyId(segment) {
  if (typeof segment !== "string" || !STORAGE_ID_PATTERN.test(segment)) {
    return null;
  }
  return segment;
}

// The storage id a segment in either form names, or null. Public form first,
// since that is the form every link the site emits carries.
export function parseAnyBeachId(segment) {
  const fromPublic = fromPublicId(segment);
  if (fromPublic !== null) {
    return fromPublic;
  }
  return fromLegacyId(segment);
}
