// Pure module: exports a single CSS string used by src/frontend/render.js.
// No fetch, no Date, no DOM APIs. String built with array + join, never backticks.

const RULES = [
  ":root {",
  "  --flag-color-green: #1a7f37;",
  "  --flag-color-yellow: #d4a72c;",
  "  --flag-color-red: #cf222e;",
  "  --flag-color-unknown: #6e7781;",
  "}",

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

  ".beach-row-chevron {",
  "  color: var(--wa-color-text-quiet);",
  "}",

  ".empty-state {",
  "  color: var(--wa-color-text-quiet);",
  "  text-align: center;",
  "  padding: var(--wa-space-xl);",
  "}",

  ".flag-icon-s { font-size: var(--wa-font-size-l); }",
  ".flag-icon-l { font-size: var(--wa-font-size-4xl); }",

  ".flag-icon-green { color: var(--flag-color-green); }",
  ".flag-icon-yellow { color: var(--flag-color-yellow); }",
  ".flag-icon-red { color: var(--flag-color-red); }",
  ".flag-icon-unknown { color: var(--flag-color-unknown); }",

  ".flag-icon-stack {",
  "  display: inline-flex;",
  "  gap: var(--wa-space-3xs);",
  "}",

  ".badge-s {",
  "  font-size: var(--wa-font-size-2xs);",
  "}",

  ".wave-map-frame {",
  "  aspect-ratio: 4 / 3;",
  "  border: var(--wa-border-width-s) solid var(--wa-color-surface-border);",
  "  border-radius: var(--wa-border-radius-m);",
  "  overflow: hidden;",
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
  "  display: flex;",
  "  align-items: center;",
  "  gap: var(--wa-space-s);",
  "}",

  ".beach-subtitle {",
  "  margin-block: var(--wa-space-3xs) 0;",
  "  color: var(--wa-color-text-quiet);",
  "  font-size: var(--wa-font-size-l);",
  "}",

  ".beach-meta {",
  "  color: var(--wa-color-text-quiet);",
  "}",

  ".flag-color-label {",
  "  font-size: var(--wa-font-size-xl);",
  "  font-weight: var(--wa-font-weight-bold);",
  "}",

  ".card-trigger, .card-source, .card-updated {",
  "  color: var(--wa-color-text-quiet);",
  "  font-size: var(--wa-font-size-s);",
  "}",

  ".card-source {",
  "  margin-block-end: var(--wa-space-3xs);",
  "}",

  ".card-sources {",
  "  font-size: var(--wa-font-size-s);",
  "}",

  ".official-card {",
  "  border: var(--wa-border-width-l) solid var(--wa-color-success-border-loud);",
  "}",

  ".error-panel {",
  "  padding: var(--wa-space-3xl);",
  "  text-align: center;",
  "}",

  ".error-icon {",
  "  font-size: var(--wa-font-size-4xl);",
  "  color: var(--wa-color-warning-fill-loud);",
  "}"
];

export const PAGE_STYLES = RULES.join("\n");
