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

// The server-rendered empty state: visibility is its hidden attribute, and the
// copy lives in .empty-state-message. No style object on purpose, so a write to
// style.display throws instead of passing silently.
function makeEmptyState(hidden) {
  const message = { textContent: "No beaches match your search" };
  return {
    hidden: hidden,
    message: message,
    querySelector(selector) { return selector === ".empty-state-message" ? message : null; }
  };
}

// The input stub deliberately has no "value" property, which is the
// pre-upgrade custom element: the query lives on the attribute alone.
function makeStubs(rows, attributeValue, emptyState) {
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
      if (id === "beach-list-empty") { return emptyState || null; }
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

function runScript(rows, attributeValue, emptyState) {
  const stubs = makeStubs(rows, attributeValue, emptyState);
  // eslint-disable-next-line no-new-func
  new Function(LIST_SEARCH_SCRIPT)();
  return stubs;
}

const savedFetch = globalThis.fetch;

afterEach(() => {
  delete globalThis.document;
  delete globalThis.window;
  globalThis.fetch = savedFetch;
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

  it("owns the empty state through its hidden attribute when it cannot fetch", () => {
    // No fetch means the page the server rendered is all there is, so the
    // filter decides the empty state itself from the rows it can see.
    delete globalThis.fetch;
    const rows = [makeRow("ottawa beach"), makeRow("oak street")];
    const emptyState = makeEmptyState(true);
    const stubs = runScript(rows, "zzz", emptyState);

    stubs.docHandlers["swimreport:rowsadded"]();
    expect(emptyState.hidden).toBe(false);
    expect(emptyState.message.textContent).toBe("No beaches match your search");

    stubs.input.value = "oak";
    stubs.docHandlers["swimreport:rowsadded"]();
    expect(emptyState.hidden).toBe(true);
  });

  it("leaves the empty state to the server when it can fetch", () => {
    // A term can match beaches the page never rendered, so the server's own
    // hidden attribute, captured at load, is what the filter restores.
    const rows = [makeRow("ottawa beach"), makeRow("oak street")];
    const emptyState = makeEmptyState(true);
    const stubs = runScript(rows, "zzz", emptyState);

    stubs.docHandlers["swimreport:rowsadded"]();
    expect(emptyState.hidden).toBe(true);
  });
});
