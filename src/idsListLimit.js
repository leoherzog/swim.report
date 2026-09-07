// src/idsListLimit.js — the bound on the GET /?ids= list mode, in its own module
// because both sides of that contract need the same number: src/router.js
// applies it before any SQL, and src/frontend/favoritesScript.js bakes it into
// the browser script that builds the id list. The script is text and cannot
// import, so the value is interpolated into it rather than restated.
//
// Ten rows is what the browser-side favorites and recently-viewed lists ask for;
// the cap is what keeps an arbitrary caller from turning one URL into a
// whole-table read.
export const IDS_LIST_LIMIT = 10;
