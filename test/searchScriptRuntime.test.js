// Executes the generated list search script against thin DOM stubs. The point
// of interest is the search box: it is a <wa-input>, and this script runs before
// the kit module that defines it, so on the first pass the element carries the
// query only as an attribute and has no "value" property at all.

import { describe, it, expect, afterEach } from "vitest";
import { LIST_SEARCH_SCRIPT } from "../src/frontend/searchScript.js";

function makeRow(name) {
  return {
    style: { display: "" },
    getAttribute(attr) { return attr === "data-name" ? name : null; }
  };
}

// The input stub deliberately has no "value" property, which is the
// pre-upgrade custom element: the query lives on the attribute alone.
function makeStubs(rows, attributeValue) {
  const docHandlers = {};
  const input = {
    getAttribute(attr) { return attr === "value" ? attributeValue : null; },
    addEventListener() {}
  };
  const list = {
    contains: () => true,
    querySelectorAll: () => rows
  };
  const document = {
    getElementById(id) {
      if (id === "beach-search") { return input; }
      if (id === "beach-list-items") { return list; }
      return null;
    },
    querySelectorAll: () => rows,
    addEventListener(type, fn) { docHandlers[type] = fn; }
  };

  globalThis.document = document;
  globalThis.window = {
    location: { search: "" },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} }
  };
  return { input: input, docHandlers: docHandlers };
}

function runScript(rows, attributeValue) {
  const stubs = makeStubs(rows, attributeValue);
  // eslint-disable-next-line no-new-func
  new Function(LIST_SEARCH_SCRIPT)();
  return stubs;
}

afterEach(() => {
  delete globalThis.document;
  delete globalThis.window;
});

describe("list search script runtime", () => {
  it("filters on the attribute while the search box is still an unupgraded element", () => {
    const rows = [makeRow("ottawa beach"), makeRow("oak street")];
    const stubs = runScript(rows, "ott");

    expect(typeof stubs.docHandlers["swimreport:rowsadded"]).toBe("function");
    stubs.docHandlers["swimreport:rowsadded"]();

    expect(rows[0].style.display).toBe("");
    expect(rows[1].style.display).toBe("none");
  });

  it("prefers the value property once the element has upgraded", () => {
    const rows = [makeRow("ottawa beach"), makeRow("oak street")];
    const stubs = runScript(rows, "ott");
    stubs.input.value = "oak";

    stubs.docHandlers["swimreport:rowsadded"]();

    expect(rows[0].style.display).toBe("none");
    expect(rows[1].style.display).toBe("");
  });
});
