// Guards the positions of the top-level keys and the observability key in
// wrangler.toml: wrangler validates their types, but a top-level key placed
// after the first table header is silently re-parented into that table.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const WRANGLER = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

function indexOfLine(line) {
  const at = WRANGLER.indexOf("\n" + line + "\n");
  expect(at, line).toBeGreaterThan(-1);
  return at;
}

describe("wrangler.toml key placement", function () {
  const firstTable = WRANGLER.indexOf("\n[");

  it("has at least one table header", function () {
    expect(firstTable).toBeGreaterThan(-1);
  });

  it("keeps workers_dev = false above the first table header", function () {
    expect(indexOfLine("workers_dev = false")).toBeLessThan(firstTable);
  });

  it("keeps preview_urls = false above the first table header", function () {
    expect(indexOfLine("preview_urls = false")).toBeLessThan(firstTable);
  });

  it("keeps upload_source_maps = true above the first table header", function () {
    expect(indexOfLine("upload_source_maps = true")).toBeLessThan(firstTable);
  });

  it("keeps redact_query_string = true inside [observability]", function () {
    const observability = indexOfLine("[observability]");
    const placement = indexOfLine("[placement]");
    const redact = indexOfLine("redact_query_string = true");
    expect(observability).toBeLessThan(placement);
    expect(redact).toBeGreaterThan(observability);
    expect(redact).toBeLessThan(placement);
  });
});
