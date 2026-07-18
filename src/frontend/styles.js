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

  // Shared framed-embed treatment: the wrapper div carries the
  // "wa-frame:landscape wa-border-radius-m" utilities, which already supply the
  // 16:9 aspect-ratio, overflow clipping, and rounded corners. Only the 1px
  // surface border (not part of any utility) lives here.
  ".framed-embed {",
  "  border: var(--wa-border-width-s) solid var(--wa-color-surface-border);",
  "}",

  // wa-frame auto-fills only child img/video, so the plain iframes still need
  // explicit 100% sizing to fill the frame.
  ".wave-map-frame,",
  ".webcam-frame {",
  "  display: block;",
  "  width: 100%;",
  "  height: 100%;",
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

  // Grouping/spacing come from the parent .beach-identity (wa-stack wa-gap-2xs),
  // which also zero-margins its children — so the title needs no rule of its
  // own, and the subtitle keeps only its quiet color and size.
  ".beach-subtitle {",
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

  // Hazard lane above the strip: one relative row per active hazard, each
  // band absolutely positioned by per-instance left/width percentages (its
  // colors are per-instance inline values too). The label ellipsizes when the
  // band is short; the full text rides the tooltip and aria-label.
  ".wave-alert-lane {",
  "  position: relative;",
  "  height: var(--wa-space-xl);",
  "}",

  ".wave-alert-band {",
  "  position: absolute;",
  "  top: 0;",
  "  bottom: 0;",
  "  display: flex;",
  "  align-items: center;",
  "  padding: 0 var(--wa-space-xs);",
  "  font-size: var(--wa-font-size-xs);",
  "  border: var(--wa-border-width-s) solid;",
  "  border-radius: var(--wa-border-radius-s);",
  "}",

  ".wave-alert-band:focus-visible {",
  "  outline: var(--wa-focus-ring);",
  "}",

  ".wave-alert-label {",
  "  overflow: hidden;",
  "  white-space: nowrap;",
  "  text-overflow: ellipsis;",
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
  // component default 16/9. --point-radius: 0 hides points on every dataset
  // (component custom property, resolved per-dataset when pointRadius is not
  // set explicitly in the Chart.js config) instead of restating pointRadius: 0
  // in each dataset object.
  ".wave-model-chart {",
  "  display: block;",
  "  width: 100%;",
  "  height: 13rem;",
  "  aspect-ratio: auto;",
  "  --point-radius: 0;",
  "}",

  // Keep the list row's flag/badge cluster on one line and never squeezed by
  // a long beach name (white-space inherits into the badge's shadow text).
  ".beach-row-link > .wa-cluster {",
  "  flex-shrink: 0;",
  "  white-space: nowrap;",
  "}",

  // Homepage map: the border comes from the shared .framed-embed class and the
  // rounded corners from the wa-border-radius-m utility (same treatment as the
  // detail-page wave map / webcam). Only the map's own concerns live here: an
  // explicit height (MapLibre collapses to 0px without one and renders blank)
  // and the overflow clip that keeps the tiles inside the rounded corners.
  ".home-map {",
  "  height: 20rem;",
  "  overflow: hidden;",
  "}",
  // Flag marker: an anchor carrying a flag-icon-* color class; its <wa-icon>
  // sizes to 1em (so font-size sets the marker size) and inherits the color via
  // currentColor. Drop-shadow keeps the flag legible over the light positron
  // tiles; a CSS filter on the wa-icon host reaches its shadow-DOM svg.
  ".home-map-marker {",
  "  display: block;",
  "  line-height: 0;",
  "  font-size: 1.5rem;",
  "}",
  ".home-map-marker wa-icon {",
  "  display: block;",
  "  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.45));",
  "}"
];

export const PAGE_STYLES = RULES.join("\n");
