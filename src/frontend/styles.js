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
  // The four flag colors, declared once. Every rule below and both client
  // scripts read these, so a palette change lands in one edit. Yellow takes
  // tint 70 because tint 50 reads olive in the mild palette (PLAN.md section 9);
  // gray is honest absence, never a guessed condition.
  "html {",
  "  --content-measure: 48rem;",
  "  --flag-green: var(--wa-color-green-50);",
  "  --flag-yellow: var(--wa-color-yellow-70);",
  "  --flag-red: var(--wa-color-red-50);",
  "  --flag-unknown: var(--wa-color-gray-50);",
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

  // Native cross-document view transitions between the list and a detail page.
  // The detail hero owns beach-title and beach-flag statically; a list row or a
  // nearby card takes both names over at click time (rowTransitionScript.js),
  // because a view-transition-name has to be unique within a document.
  "@media (prefers-reduced-motion: no-preference) {",
  "  @view-transition {",
  "    navigation: auto;",
  "  }",
  "  ::view-transition-group(beach-title),",
  "  ::view-transition-group(beach-flag) {",
  "    animation-duration: 260ms;",
  "  }",
  "}",

  ".app-header {",
  "  padding-inline: var(--wa-space-xl);",
  "}",

  // An undecorated icon-and-label link. inline-flex + gap stay custom:
  // wa-cluster is block-level flex, so it is not an equivalent swap here, and
  // wa-link-plain adds a hover color-mix these links deliberately do not have.
  // Each link picks its own color with a wa-color-text-* utility.
  ".icon-link {",
  "  display: inline-flex;",
  "  align-items: center;",
  "  gap: var(--wa-space-2xs);",
  "  text-decoration: none;",
  "}",

  ".brand-link {",
  "  gap: var(--wa-space-xs);",
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
  "  background-color: transparent;",
  "  justify-content: center;",
  "}",

  // One centered block of three <small> lines (disclaimer, data attribution,
  // basemap credit). Capped to the main column's width so a wrapped line
  // still reads as one centered paragraph rather than a full-bleed run.
  ".footer-lines {",
  "  max-width: var(--content-measure);",
  "  margin: 0;",
  "}",

  "main.app-main {",
  "  max-width: var(--content-measure);",
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

  // No flex utility ships, so the grow/shrink pair stays hand-written.
  ".beach-row-name {",
  "  flex: 1 1 auto;",
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
  "  padding: var(--wa-space-xl);",
  "}",

  // --- List polish: the color-coded feed and the controls above it. ---
  // The row's inline-start border carries its flag color so the list scans as a
  // feed rather than a wall of names. It reads from data-flag, the same keyword
  // the row's chip renders, and every keyword has a rule so unknown shows an
  // honest gray instead of nothing.
  ".beach-row .beach-row-link {",
  "  border-inline-start-width: var(--wa-border-width-l);",
  "}",
  ".beach-row[data-flag=\"green\"] .beach-row-link { border-inline-start-color: var(--flag-green); }",
  ".beach-row[data-flag=\"yellow\"] .beach-row-link { border-inline-start-color: var(--flag-yellow); }",
  ".beach-row[data-flag=\"red\"] .beach-row-link { border-inline-start-color: var(--flag-red); }",
  ".beach-row[data-flag=\"unknown\"] .beach-row-link { border-inline-start-color: var(--flag-unknown); }",

  // With nothing to filter the row still sits in the page stack, where a
  // zero-height child would leave a full gap of white space. Unlayered, so it
  // outranks the wa-cluster utility's layered display: flex.
  ".list-controls:empty {",
  "  display: none;",
  "}",

  ".list-filter {",
  "  margin-inline-start: auto;",
  "}",
  // --- End list polish. ---

  // --- Section headings: the saved / recently viewed section and the main list. ---
  // Their rows are the server's own .beach-row markup and the sub-labels take
  // their quiet color from wa-caption-s, so only the heading size and the stack's
  // zeroed margins are left to set here.
  ".your-beaches-heading,",
  ".nearby-heading {",
  "  margin: 0;",
  "  font-size: var(--wa-font-size-l);",
  "}",

  ".your-beaches-label {",
  "  margin: 0;",
  "}",
  // --- End section headings. ---

  ".flag-icon-green { color: var(--flag-green); }",
  ".flag-icon-yellow { color: var(--flag-yellow); }",
  ".flag-icon-red { color: var(--flag-red); }",
  ".flag-icon-unknown { color: var(--flag-unknown); }",

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

  // --- detail hero + at-a-glance tiles ---------------------------------------
  // The hero is washed in the display flag's own color at 12%, mixed into the
  // surface token so the tint follows light and dark without a second palette.
  // The keyword comes from a data-flag attribute rather than an inline style, so
  // no color literal ever reaches the markup. Unknown washes gray: honest
  // absence, never a green default.
  ".detail-hero {",
  "  padding: var(--wa-space-l);",
  "  border-radius: var(--wa-border-radius-l);",
  "  border: var(--wa-border-width-s) solid var(--wa-color-surface-border);",
  "  background: var(--wa-color-surface-default);",
  "}",

  ".detail-hero[data-flag='green'] {",
  "  background: color-mix(in oklab, var(--flag-green) 12%, var(--wa-color-surface-default));",
  "}",

  ".detail-hero[data-flag='yellow'] {",
  "  background: color-mix(in oklab, var(--flag-yellow) 12%, var(--wa-color-surface-default));",
  "}",

  ".detail-hero[data-flag='red'] {",
  "  background: color-mix(in oklab, var(--flag-red) 12%, var(--wa-color-surface-default));",
  "}",

  ".detail-hero[data-flag='unknown'] {",
  "  background: color-mix(in oklab, var(--flag-unknown) 12%, var(--wa-color-surface-default));",
  "}",

  // Plain-language verdict under the flag label: the hero's answer in one
  // sentence, so it reads louder than the quiet coordinates line below it.
  ".hero-verdict {",
  "  font-size: var(--wa-font-size-l);",
  "}",

  // Shared heading for every detail-page section below the hero, sized between
  // the h1 and body text so the sections read as parts of one page.
  ".section-heading {",
  "  margin: 0;",
  "  font-size: var(--wa-font-size-l);",
  "}",

  // At-a-glance tiles: up to five small readings in the same responsive grid
  // shape the nearby cards use, at a narrower column so two fit a phone on one
  // row. A reading with no data renders no tile, so the count varies.
  ".glance-grid {",
  "  --min-column-size: 9rem;",
  "}",

  // --- end detail hero + at-a-glance tiles -----------------------------------

  // --- flag legend -----------------------------------------------------------
  // Collapsed legend under the at-a-glance tiles. The list drops its markers so
  // each line starts on its own flag icon.
  ".flag-legend {",
  "  font-size: var(--wa-font-size-s);",
  "}",

  ".flag-legend-list {",
  "  list-style: none;",
  "  padding-inline-start: 0;",
  "  margin-block: 0;",
  "}",

  ".flag-legend-note {",
  "  color: var(--wa-color-text-quiet);",
  "  margin-block-end: 0;",
  "}",
  // --- end flag legend -------------------------------------------------------

  // Longhands on purpose: a border SHORTHAND on the wa-card host would reset
  // border-style and stomp the theme's --wa-panel-border-style; the card's own
  // border-style declaration stays in charge.
  ".official-card {",
  "  border-color: var(--wa-color-success-border-loud);",
  "  border-width: var(--wa-border-width-l);",
  "}",

  // --- per-alert disclosures inside the estimate card -------------------------
  // Each alert collapses to one header row: the event name, then its window on
  // the same line where there is room and wrapped beneath it where there is not.
  // --spacing is wa-details' documented content-spacing property; the plain
  // appearance carries no border of its own, so the rows are separated by one
  // hairline apiece.
  ".alert-details {",
  "  margin-block-start: var(--wa-space-s);",
  "}",

  ".alert-detail {",
  "  --spacing: var(--wa-space-s);",
  "  border-block-start: var(--wa-border-width-s) solid var(--wa-color-surface-border);",
  "}",

  ".alert-detail-summary,",
  ".alert-detail-bare {",
  "  display: flex;",
  "  flex-wrap: wrap;",
  "  align-items: baseline;",
  "  gap: var(--wa-space-2xs) var(--wa-space-s);",
  "}",

  // The bare row has no toggle, so it pays wa-details' header padding itself to
  // sit on the same rhythm as the expandable rows above and below it.
  ".alert-detail-bare {",
  "  padding-block: var(--wa-space-s);",
  "}",

  ".alert-detail-body p {",
  "  margin-block: 0;",
  "}",

  ".alert-detail-body {",
  "  font-size: var(--wa-font-size-s);",
  "}",

  // The office's own call to action, weighted above the description it follows.
  ".alert-detail-instruction {",
  "  align-items: start;",
  "  color: var(--wa-color-text-loud);",
  "  font-weight: var(--wa-font-weight-semibold);",
  "}",

  // --- end per-alert disclosures ---------------------------------------------

  // Tighter section spacing for every wa-card on the detail page (--spacing is
  // wa-card's documented section-spacing custom property, default
  // var(--wa-space-l)).
  ".glance-tile,",
  ".official-card,",
  ".estimate-card,",
  ".nearby-card {",
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

  // A short Dark Sky-style strip: a flex row of proportional colored segments
  // (each segment's flex/background is a per-instance inline value).
  ".wave-strip {",
  "  position: relative;",
  "  display: flex;",
  "  height: var(--wa-space-3xl);",
  "  border-radius: var(--wa-border-radius-m);",
  "  overflow: hidden;",
  "}",

  // A hairline marker on the strip's left edge: the timeline starts at the
  // current hour, so "now" is an edge rather than a point inside the strip.
  ".wave-strip::after {",
  "  content: \"\";",
  "  position: absolute;",
  "  inset-block: 0;",
  "  inset-inline-start: 0;",
  "  width: var(--wa-border-width-m);",
  "  background: var(--wa-color-neutral-fill-loud);",
  "  pointer-events: none;",
  "}",

  // Draw the focus ring inset so overflow: hidden cannot clip it.
  ".wave-strip-seg:focus-visible {",
  "  outline: var(--wa-focus-ring);",
  "  outline-offset: calc(-1 * var(--wa-focus-ring-width));",
  "}",

  // Fill-in on load: each run scales out from the now edge, staggered by its
  // index (--i, set inline per segment in renderWaveStrip). Decoration only —
  // the strip is complete and correctly colored with the animation skipped.
  "@media (prefers-reduced-motion: no-preference) {",
  "  .wave-strip-seg {",
  "    transform-origin: left center;",
  "    animation: wave-strip-fill 320ms ease-out backwards;",
  "    animation-delay: calc(var(--i, 0) * 70ms);",
  "  }",
  "  @keyframes wave-strip-fill {",
  "    from { transform: scaleX(0); }",
  "    to { transform: scaleX(1); }",
  "  }",
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

  // Appended by waveTicksScript.js once the ticks read as local clock times, so
  // it never occupies space on a page that kept the relative labels.
  ".wave-chart-hours-note {",
  "  margin: 0;",
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

  // Nearby cards: the whole card is one link, so the anchor fills the body and
  // carries the text color; the grid wraps at a card width that keeps a name,
  // chip and distance readable in one column on a phone. The section's heading
  // is the shared .section-heading.
  ".nearby-grid {",
  "  --min-column-size: 12rem;",
  "}",

  ".nearby-card:hover {",
  "  background: var(--wa-color-neutral-fill-quiet);",
  "}",

  // Homepage map: MapLibre collapses to 0px and renders blank without an
  // explicit height. The overflow clip keeps the tiles inside the rounded
  // corners the wa-border-radius-m utility supplies.
  ".home-map {",
  "  height: 20rem;",
  "  overflow: hidden;",
  "}",

  // Placeholder inside the mount until MapLibre's load event removes it, so the
  // map area is a shaped surface rather than a blank framed box while tiles
  // arrive. The host already fills its parent, so only the indicator's default
  // pill radius has to become the mount's own.
  ".home-map-skeleton::part(indicator) {",
  "  border-radius: var(--wa-border-radius-m);",
  "}",

  // The sheen animates by default, so it takes the same opposite-polarity guard
  // the background swells use.
  "@media (prefers-reduced-motion: reduce) {",
  "  .home-map-skeleton::part(indicator) {",
  "    animation: none;",
  "  }",
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
