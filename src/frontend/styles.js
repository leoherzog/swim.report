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

  // Size/weight come from wa-font-size-l + wa-font-weight-bold utility classes
  // on the element. inline-flex + gap stay custom: wa-cluster is block-level
  // flex, so it is NOT an equivalent swap here. wa-link-plain is also not a
  // match — it adds a hover color-mix this link deliberately doesn't have.
  ".brand-link {",
  "  display: inline-flex;",
  "  align-items: center;",
  "  gap: var(--wa-space-xs);",
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

  // list-style/padding come from the wa-list-plain utility on the element.
  // margin stays: the ul's parent (.beach-list-section) is not a layout
  // utility, so the utilities' child-margin reset doesn't reach it, and the
  // native :has(+ *) rule would otherwise add margin-block-end before the
  // (sometimes hidden) empty-state paragraph that follows.
  ".beach-list {",
  "  margin: 0;",
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

  // Quiet color/size/weight come from the wa-caption-s utility on the element;
  // only the offset and the no-wrap behavior are genuinely custom.
  ".beach-row-distance {",
  "  margin-inline-start: var(--wa-space-xs);",
  "  white-space: nowrap;",
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

  // Shared framed-embed treatment: rounded clipping box that fills its column.
  // The two plain iframes additionally get a 1px surface border; each frame
  // keeps its own aspect-ratio (these are plain iframes now, so the explicit
  // sizing is load-bearing).
  ".wave-map-frame,",
  ".webcam-frame {",
  "  display: block;",
  "  width: 100%;",
  "  border-radius: var(--wa-border-radius-m);",
  "  overflow: hidden;",
  "}",

  ".wave-map-frame,",
  ".webcam-frame {",
  "  border: var(--wa-border-width-s) solid var(--wa-color-surface-border);",
  "}",

  ".wave-map-frame {",
  "  aspect-ratio: 16 / 9;",
  "}",

  ".webcam-frame {",
  "  max-width: 100%;",
  "  aspect-ratio: 16 / 9;",
  "}",

  ".back-link {",
  "  display: inline-flex;",
  "  align-items: center;",
  "  gap: var(--wa-space-2xs);",
  "  color: var(--wa-color-text-link);",
  "  text-decoration: none;",
  "}",

  // Quiet coordinates link under the title (mirrors .back-link).
  ".coords-link {",
  "  display: inline-flex;",
  "  align-items: center;",
  "  gap: var(--wa-space-2xs);",
  "  color: var(--wa-color-text-quiet);",
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

  // Longhands on purpose: a border SHORTHAND on the wa-card host would reset
  // border-style and stomp the theme's --wa-panel-border-style; the card's own
  // border-style declaration stays in charge.
  ".official-card {",
  "  border-color: var(--wa-color-success-border-loud);",
  "  border-width: var(--wa-border-width-l);",
  "}",

  // Tighter section spacing inside both flag cards (--spacing is wa-card's
  // documented section-spacing custom property, default var(--wa-space-l)).
  ".official-card,",
  ".estimate-card {",
  "  --spacing: var(--wa-space-m);",
  "}",

  // A short Dark Sky-style strip: a flex row of proportional colored segments
  // (each segment's flex/background is a per-instance inline value).
  ".wave-strip {",
  "  display: flex;",
  "  height: var(--wa-space-3xl);",
  "  border-radius: var(--wa-border-radius-m);",
  "  overflow: hidden;",
  "}",

  // Draw the focus ring inset so overflow: hidden cannot clip it.
  ".wave-strip-seg:focus-visible {",
  "  outline: var(--wa-focus-ring);",
  "  outline-offset: calc(-1 * var(--wa-focus-ring-width));",
  "}",

  ".wave-chart-hours {",
  "  position: relative;",
  "  height: var(--wa-font-size-l);",
  "  color: var(--wa-color-text-quiet);",
  "  font-size: var(--wa-font-size-xs);",
  "}",

  ".wave-chart-hour {",
  "  position: absolute;",
  "  transform: translateX(-50%);",
  "  white-space: nowrap;",
  "}",

  ".wave-chart-hour-start {",
  "  left: 0;",
  "  transform: none;",
  "}",

  ".wave-chart-hour-end {",
  "  right: 0;",
  "  left: auto;",
  "  transform: none;",
  "}",

  // Quiet plain-appearance disclosure line: tighter body spacing via the
  // documented --spacing custom property, smaller quieter summary via the
  // documented summary part.
  ".wave-model-compare {",
  "  --spacing: var(--wa-space-s);",
  "}",

  ".wave-model-compare::part(summary) {",
  "  font-size: var(--wa-font-size-s);",
  "  color: var(--wa-color-text-quiet);",
  "}",

  // Model-comparison line chart inside the collapsed disclosure. Taller than the
  // strip (it's a real axis chart), aspect-ratio forced to auto to override the
  // component default 16/9.
  ".wave-model-chart {",
  "  display: block;",
  "  width: 100%;",
  "  height: 13rem;",
  "  aspect-ratio: auto;",
  "}",

  // Keep the list row's flag/badge cluster on one line and never squeezed by
  // a long beach name (white-space inherits into the badge's shadow text).
  ".beach-row-link > .wa-cluster {",
  "  flex-shrink: 0;",
  "  white-space: nowrap;",
  "}"
];

export const PAGE_STYLES = RULES.join("\n");
