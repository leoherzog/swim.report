// Pure module: exports a single CSS string used by src/frontend/render.js.
// No fetch, no Date, no DOM APIs.
//
// Properties absent from a rule below come from Web Awesome utility classes on
// the element; only genuinely custom declarations live here.

const RULES = [
  "html, body {",
  "  min-height: 100%;",
  "  margin: 0;",
  "  padding: 0;",
  "}",

  // The page's opaque base color. <wa-page>'s host normally paints this itself,
  // but the host is made transparent below so the .wave-bg layer can sit behind
  // it. The surface color has to live on <html>, the canvas background, and not
  // on <body>: WA's native.css already backgrounds <html>, which blocks
  // body-to-canvas propagation, and a body-painted background renders above
  // negative z-index positioned elements in the root stacking context, hiding
  // the waves. Restated here unlayered, so it outranks the @layer wa-native copy.
  "html {",
  "  background-color: var(--wa-color-surface-default);",
  "}",

  // <wa-page>'s shadow :host rule sets background-color: var(--wa-color-surface-
  // default) — opaque, which would paint over the z-index:-1 wave layer. Making
  // the host transparent lets the body-level waves show through the (otherwise
  // empty) main area. :root (a pseudo-class, so (0,1,0)) + the wa-page type
  // (0,0,1) lifts this author rule to (0,1,1), just over the shadow :host at
  // (0,1,0), so no !important is needed — and it stays correct if the theme
  // class on <html> ever changes (a bare `wa-page` at (0,0,1) would lose to
  // :host). Header/footer keep their own opaque surface fill.
  ":root wa-page {",
  "  background-color: transparent;",
  "}",

  // Anchors .wave-bg's absolute positioning to the full document height.
  // relative with z-index: auto does not create a stacking context, so the wave
  // layer keeps participating in the root stacking context, where negative
  // z-index paints below all content.
  "body {",
  "  position: relative;",
  "}",

  ".wave-bg {",
  "  position: absolute;",
  "  left: 0;",
  "  right: 0;",
  "  bottom: 0;",
  "  z-index: -1;",
  "  height: 18vh;",
  "  min-height: 110px;",
  "  max-height: 190px;",
  "  pointer-events: none;",
  "  overflow: hidden;",
  "}",

  ".wave-svg {",
  "  display: block;",
  "  width: 100%;",
  "  height: 100%;",
  "}",

  ".wave-layers > use {",
  "  animation: wave-drift 26s cubic-bezier(0.55, 0.5, 0.45, 0.5) infinite;",
  "}",

  // Tint from the theme's own text token mixed into transparent, so it always
  // matches the current surface with no hardcoded colors.
  ".wave-layers > use:nth-child(1) {",
  "  animation-delay: -2s;",
  "  animation-duration: 24s;",
  "  fill: color-mix(in oklab, var(--wa-color-text-normal) 3%, transparent);",
  "}",
  ".wave-layers > use:nth-child(2) {",
  "  animation-delay: -3s;",
  "  animation-duration: 33s;",
  "  fill: color-mix(in oklab, var(--wa-color-text-normal) 4%, transparent);",
  "}",
  ".wave-layers > use:nth-child(3) {",
  "  animation-delay: -4s;",
  "  animation-duration: 42s;",
  "  fill: color-mix(in oklab, var(--wa-color-text-normal) 5%, transparent);",
  "}",
  ".wave-layers > use:nth-child(4) {",
  "  animation-delay: -5s;",
  "  animation-duration: 54s;",
  "  fill: color-mix(in oklab, var(--wa-color-text-normal) 7%, transparent);",
  "}",

  "@keyframes wave-drift {",
  "  0% { transform: translate3d(-90px, 0, 0); }",
  "  100% { transform: translate3d(85px, 0, 0); }",
  "}",

  // Honor a reduced-motion preference: keep the layered swells, drop the drift.
  "@media (prefers-reduced-motion: reduce) {",
  "  .wave-layers > use {",
  "    animation: none;",
  "  }",
  "}",

  ".app-header {",
  "  padding-inline: var(--wa-space-xl);",
  "}",

  // inline-flex + gap stay custom: wa-cluster is block-level flex, so it is not
  // an equivalent swap here, and wa-link-plain adds a hover color-mix this link
  // deliberately does not have.
  ".brand-link {",
  "  display: inline-flex;",
  "  align-items: center;",
  "  gap: var(--wa-space-xs);",
  "  color: var(--wa-color-text-normal);",
  "  text-decoration: none;",
  "}",

  // wa-page's shadow sheet paints every slotted section opaque via
  // slot[name]::slotted(*) { background-color: var(--wa-color-surface-default) },
  // which would sit the footer on top of the document-bottom .wave-bg layer.
  // Transparent here wins without !important: outer-document author rules beat
  // shadow ::slotted() declarations regardless of specificity. The sticky header
  // deliberately keeps its opaque ::slotted fill so content scrolling under it
  // cannot show through.
  // wa-page also makes the slotted footer a space-between flex row; the footer
  // holds exactly one child (.footer-lines) and centers it instead.
  ".app-footer {",
  "  padding-inline: var(--wa-space-xl);",
  "  color: var(--wa-color-text-quiet);",
  "  background-color: transparent;",
  "  justify-content: center;",
  "}",

  // One centered block of three <small> lines (disclaimer, data attribution,
  // basemap credit). Capped to the main column's width so a wrapped line
  // still reads as one centered paragraph rather than a full-bleed run.
  ".footer-lines {",
  "  max-width: 48rem;",
  "  margin: 0;",
  "  text-align: center;",
  "}",

  "main.app-main {",
  "  max-width: 48rem;",
  "  margin-inline: auto;",
  "}",

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

  // Only the offset and the no-wrap behavior are custom.
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

  // Shared framed-embed treatment. Only the 1px surface border lives here; the
  // wrapper's utilities supply the aspect ratio, clipping and rounded corners.
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

  // The parent .beach-identity (wa-stack wa-gap-l) zero-margins its children, so
  // the title needs no rule of its own.
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

  // Homepage map: MapLibre collapses to 0px and renders blank without an
  // explicit height. The overflow clip keeps the tiles inside the rounded
  // corners the wa-border-radius-m utility supplies.
  ".home-map {",
  "  height: 20rem;",
  "  overflow: hidden;",
  "}",

  // The error page's status heading is slotted (light DOM) into a <wa-callout>,
  // directly above the message line. Web Awesome's native-element styling gives
  // headings a block-start margin, which would stack on top of the callout's own
  // padding and push the heading away from the icon; zero it so the callout keeps
  // its intended internal spacing.
  "wa-callout h1 {",
  "  margin-block-start: 0;",
  "}"
];

export const PAGE_STYLES = RULES.join("\n");
