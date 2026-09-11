// The validator /api/beaches.geojson answers 304 from (src/etag.js): the strong
// SHA-256 tag over a body and the weak If-None-Match comparison Cloudflare's
// re-compression forces.

import { describe, it, expect } from "vitest";
import { strongEtag, etagMatches } from "../src/etag.js";

const TAG = "\"abc\"";

describe("etagMatches", function () {
  it("is false for a missing or empty header", function () {
    expect(etagMatches(null, TAG)).toBe(false);
    expect(etagMatches(undefined, TAG)).toBe(false);
    expect(etagMatches("", TAG)).toBe(false);
  });

  it("matches the exact tag and a W/-prefixed one", function () {
    expect(etagMatches(TAG, TAG)).toBe(true);
    expect(etagMatches("W/" + TAG, TAG)).toBe(true);
  });

  it("matches on any entry of a comma list, spaces included", function () {
    expect(etagMatches("\"nope\", " + TAG + " , \"other\"", TAG)).toBe(true);
    expect(etagMatches("\"nope\",W/" + TAG, TAG)).toBe(true);
    expect(etagMatches("\"nope\", \"other\"", TAG)).toBe(false);
  });

  it("matches * against anything", function () {
    expect(etagMatches("*", TAG)).toBe(true);
    expect(etagMatches(" * ", TAG)).toBe(true);
  });

  it("does not match an unquoted or partial tag", function () {
    expect(etagMatches("abc", TAG)).toBe(false);
    expect(etagMatches("\"ab\"", TAG)).toBe(false);
  });
});

describe("strongEtag", function () {
  it("is the quoted lowercase SHA-256 hex of the bytes", async function () {
    const tag = await strongEtag(new TextEncoder().encode("abc"));
    expect(tag).toBe("\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\"");
  });

  it("is deterministic and moves with the body", async function () {
    const a = await strongEtag(new TextEncoder().encode("{\"a\":1}"));
    const b = await strongEtag(new TextEncoder().encode("{\"a\":1}"));
    const c = await strongEtag(new TextEncoder().encode("{\"a\":2}"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^"[0-9a-f]{64}"$/);
  });
});
