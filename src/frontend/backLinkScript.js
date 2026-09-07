// Exports the literal text of the detail page's inline hero script. It runs in
// the browser, not in the Worker, and is a progressive enhancement on markup
// that is already complete and correct without it.
//
// Two jobs, both of which the server cannot do:
//   - The back link is rendered href="/" because the renderer knows nothing
//     about where the visitor came from. When the referrer is a same-origin
//     listing, the script rewrites the href to it so ?q= and ?near= survive the
//     round trip back.
//   - navigator.share exists only on some browsers, so the Share button ships
//     hidden and the script reveals it where the API is there to answer. The
//     wa-copy-button beside it is the path that always works.

const SCRIPT_LINES = [
  "(function () {",
  "  const back = document.querySelector('.back-link');",
  "  if (back) {",
  "    try {",
  "      const from = new URL(document.referrer);",
  "      if (from.origin === window.location.origin && from.pathname === '/') {",
  "        back.setAttribute('href', from.pathname + from.search);",
  "      }",
  "    } catch (err) {",
  "      // No referrer, or one that does not parse: the rendered href stands.",
  "    }",
  "  }",
  "  const share = document.getElementById('hero-share');",
  "  if (share && typeof navigator.share === 'function') {",
  "    share.hidden = false;",
  "    share.addEventListener('click', function () {",
  "      navigator.share({",
  "        title: document.title,",
  "        url: window.location.href",
  "      }).catch(function () {});",
  "    });",
  "  }",
  "})();"
];

export const DETAIL_HERO_SCRIPT = SCRIPT_LINES.join("\n");
