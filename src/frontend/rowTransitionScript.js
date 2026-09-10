// Exports the literal text of the inline helper that names the elements a
// cross-document view transition morphs. It runs in the browser, not in the
// Worker.
//
// The transition itself is pure CSS (@view-transition in styles.js). Only the
// naming needs script: a view-transition-name must be unique within a document,
// so the detail hero holds beach-title / beach-flag statically while a list row
// or a nearby card claims both names at click time and hands them back on a
// bfcache restore. With the script absent every link is an ordinary navigation.

const SCRIPT_LINES = [
  "(function () {",
  "  const LINKS = 'a.beach-row-link, a.nearby-card-link';",
  "  const NAMES = '.beach-row-name, .nearby-card-name';",
  // A browser with cross-document transitions also has startViewTransition, and
  // a reduced-motion visitor gets no transition to name elements for.
  "  if (!document.startViewTransition) {",
  "    return;",
  "  }",
  "  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {",
  "    return;",
  "  }",
  // Null on the list page, which has no hero to hand the names back to.
  "  const heroTitle = document.querySelector('h1.beach-title');",
  "  const heroFlag = heroTitle ? heroTitle.firstElementChild : null;",
  "  let claimed = [];",
  "  const claim = function (el, name) {",
  "    if (!el) {",
  "      return;",
  "    }",
  "    el.style.viewTransitionName = name;",
  "    claimed.push(el);",
  "  };",
  // Two elements sharing one name abort the transition, so every claim is
  // released before the next one and on a bfcache restore.
  "  const release = function () {",
  "    for (let i = 0; i < claimed.length; i++) {",
  "      claimed[i].style.viewTransitionName = '';",
  "    }",
  "    claimed = [];",
  "    if (heroTitle) {",
  "      heroTitle.style.viewTransitionName = 'beach-title';",
  "    }",
  "    if (heroFlag) {",
  "      heroFlag.style.viewTransitionName = 'beach-flag';",
  "    }",
  "  };",
  "  document.addEventListener('click', function (event) {",
  // A modified or non-primary click opens the link elsewhere and never navigates
  // this document, so claiming names for it would leave the wrong element named.
  "    if (event.defaultPrevented || event.button !== 0) {",
  "      return;",
  "    }",
  "    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {",
  "      return;",
  "    }",
  "    const target = event.target;",
  "    if (!target || !target.closest) {",
  "      return;",
  "    }",
  "    const link = target.closest(LINKS);",
  "    if (!link) {",
  "      return;",
  "    }",
  "    release();",
  // A nearby card lives in the hero's own document, so the hero gives the names
  // up for this navigation.
  "    if (heroTitle) {",
  "      heroTitle.style.viewTransitionName = 'none';",
  "    }",
  "    if (heroFlag) {",
  "      heroFlag.style.viewTransitionName = 'none';",
  "    }",
  "    claim(link.querySelector(NAMES), 'beach-title');",
  // The flag chip is the first badge in the row or card; an OFFICIAL badge may follow it.
  "    claim(link.querySelector('wa-badge'), 'beach-flag');",
  "  });",
  "  window.addEventListener('pageshow', release);",
  "})();"
];

export const ROW_TRANSITION_SCRIPT = SCRIPT_LINES.join("\n");
