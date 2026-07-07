// Pure module: exports a single CSS string used by src/frontend/render.js.
// No fetch, no Date, no DOM APIs. String built with array + join, never backticks.

const RULES = [
  "html, body {",
  "  min-height: 100%;",
  "  margin: 0;",
  "  padding: 0;",
  "}",

  ".app-header {",
  "  padding-inline: var(--wa-space-xl);",
  "}",

  ".brand-link {",
  "  display: inline-flex;",
  "  align-items: center;",
  "  gap: var(--wa-space-xs);",
  "  font-size: var(--wa-font-size-l);",
  "  font-weight: var(--wa-font-weight-bold);",
  "  color: var(--wa-color-text-normal);",
  "  text-decoration: none;",
  "}",

  ".app-footer {",
  "  padding-inline: var(--wa-space-xl);",
  "  color: var(--wa-color-text-quiet);",
  "}",

  "main.app-main {",
  "  max-width: 48rem;",
  "  margin-inline: auto;",
  "}",

  ".list-intro h1 {",
  "  margin: 0;",
  "}",

  ".beach-list {",
  "  list-style: none;",
  "  margin: 0;",
  "  padding: 0;",
  "}",

  ".beach-row-link {",
  "  display: flex;",
  "  align-items: center;",
  "  gap: var(--wa-space-m);",
  "  padding: var(--wa-space-m);",
  "  border: var(--wa-border-width-s) solid var(--wa-color-surface-border);",
  "  border-radius: var(--wa-border-radius-m);",
  "  text-decoration: none;",
  "  color: var(--wa-color-text-normal);",
  "}",

  ".beach-row-link:hover {",
  "  background: var(--wa-color-neutral-fill-quiet);",
  "}",

  ".beach-row-name {",
  "  flex: 1 1 auto;",
  "  font-weight: var(--wa-font-weight-semibold);",
  "}",

  ".beach-row-subtitle {",
  "  display: block;",
  "  color: var(--wa-color-text-quiet);",
  "  font-weight: var(--wa-font-weight-normal);",
  "  font-size: var(--wa-font-size-s);",
  "}",

  ".beach-row-distance {",
  "  margin-inline-start: var(--wa-space-xs);",
  "  color: var(--wa-color-text-quiet);",
  "  font-weight: var(--wa-font-weight-normal);",
  "  font-size: var(--wa-font-size-s);",
  "  white-space: nowrap;",
  "}",

  ".list-sort-note {",
  "  font-size: var(--wa-font-size-s);",
  "  margin: 0;",
  "}",

  ".empty-state {",
  "  color: var(--wa-color-text-quiet);",
  "  text-align: center;",
  "  padding: var(--wa-space-xl);",
  "}",

  ".flag-icon-green { color: var(--wa-color-green-50); }",
  ".flag-icon-yellow { color: var(--wa-color-yellow-70); }",
  ".flag-icon-red { color: var(--wa-color-red-50); }",
  ".flag-icon-unknown { color: var(--wa-color-gray-50); }",

  ".wave-map-frame {",
  "  aspect-ratio: 4 / 3;",
  "  border: var(--wa-border-width-s) solid var(--wa-color-surface-border);",
  "  border-radius: var(--wa-border-radius-m);",
  "  overflow: hidden;",
  "}",

  ".webcam-heading {",
  "  margin: 0;",
  "  font-size: var(--wa-font-size-l);",
  "}",

  ".webcam-frame {",
  "  display: block;",
  "  width: 100%;",
  "  max-width: 100%;",
  "  aspect-ratio: 16 / 9;",
  "  border: var(--wa-border-width-s) solid var(--wa-color-surface-border);",
  "  border-radius: var(--wa-border-radius-m);",
  "  overflow: hidden;",
  "}",

  ".webcam-caption {",
  "  margin: 0;",
  "}",

  ".back-link {",
  "  display: inline-flex;",
  "  align-items: center;",
  "  gap: var(--wa-space-2xs);",
  "  color: var(--wa-color-text-link);",
  "  text-decoration: none;",
  "}",

  ".beach-title {",
  "  margin-block: var(--wa-space-xs) 0;",
  "}",

  ".beach-subtitle {",
  "  margin-block: var(--wa-space-3xs) 0;",
  "  color: var(--wa-color-text-quiet);",
  "  font-size: var(--wa-font-size-l);",
  "}",

  ".official-card {",
  "  border: var(--wa-border-width-l) solid var(--wa-color-success-border-loud);",
  "}"
];

export const PAGE_STYLES = RULES.join("\n");
