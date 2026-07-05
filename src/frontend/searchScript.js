// Pure module: exports the literal text of the inline, client-side search script
// used on the beach list page. This code RUNS IN THE BROWSER, not in the Worker.
// It still follows project style rules: const/let only, never var, no template
// literals / backticks.

const SCRIPT_LINES = [
  "(function () {",
  "  const input = document.getElementById('beach-search');",
  "  const emptyState = document.getElementById('beach-list-empty');",
  "  if (!input) {",
  "    return;",
  "  }",
  "  const filterRows = function () {",
  "    const rows = document.querySelectorAll('.beach-row');",
  "    const term = input.value.trim().toLowerCase();",
  "    let visibleCount = 0;",
  "    rows.forEach(function (row) {",
  "      const name = row.getAttribute('data-name') || '';",
  "      const matches = term.length === 0 || name.indexOf(term) !== -1;",
  "      row.style.display = matches ? '' : 'none';",
  "      if (matches) {",
  "        visibleCount = visibleCount + 1;",
  "      }",
  "    });",
  "    if (emptyState) {",
  "      emptyState.style.display = visibleCount === 0 ? '' : 'none';",
  "    }",
  "  };",
  "  input.addEventListener('input', filterRows);",
  "  input.addEventListener('wa-clear', filterRows);",
  "})();"
];

export const LIST_SEARCH_SCRIPT = SCRIPT_LINES.join("\n");
