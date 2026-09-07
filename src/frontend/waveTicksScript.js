// Exports the literal text of the inline script that relabels the wave-strip
// hour ticks. It runs in the browser, not in the Worker.
//
// The server renders the ticks as relative offsets ("Now", "+6 h", "+24 h")
// because D1 holds no per-beach timezone, and carries the instant each tick
// describes in a data-iso attribute. This rewrites the visible text to the
// viewer's own clock and appends a note saying whose clock that is. A viewer
// with no JS keeps the relative labels, which are correct without it.
//
// The ticks row is aria-hidden — screen readers get the timeline from the
// strip's visually-hidden prose summary — so the note is hidden too and the
// assistive-tech reading of the section is unchanged.
//
// The label comes from Intl.DateTimeFormat rather than <wa-format-date>: the
// kit's loader upgrades components asynchronously, so swapping a tick's correct
// relative text for an element renders it blank until that upgrade lands, and
// blank forever if the kit never loads.

const SCRIPT_LINES = [
  "(function () {",
  "  const rows = document.querySelectorAll('.wave-chart-hours');",
  "  if (rows.length === 0) {",
  "    return;",
  "  }",
  "  let format;",
  "  try {",
  "    format = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });",
  "  } catch (err) {",
  "    return;",
  "  }",
  "  for (let i = 0; i < rows.length; i++) {",
  "    const row = rows[i];",
  "    const ticks = row.querySelectorAll('.wave-chart-hour[data-iso]');",
  "    let rewritten = 0;",
  "    for (let j = 0; j < ticks.length; j++) {",
  "      const at = new Date(ticks[j].getAttribute('data-iso'));",
  "      if (Number.isNaN(at.getTime())) {",
  "        continue;",
  "      }",
  "      ticks[j].textContent = format.format(at);",
  "      rewritten += 1;",
  "    }",
  "    if (rewritten === 0) {",
  "      continue;",
  "    }",
  "    const note = document.createElement('p');",
  "    note.className = 'wave-chart-hours-note wa-caption-s';",
  "    note.setAttribute('aria-hidden', 'true');",
  "    note.textContent = 'Times shown in your local time zone';",
  "    row.insertAdjacentElement('afterend', note);",
  "  }",
  "})();"
];

export const WAVE_TICKS_SCRIPT = SCRIPT_LINES.join("\n");
