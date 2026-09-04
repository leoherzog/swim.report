// Coverage configuration only. Everything else — test discovery, pool, environment —
// stays on vitest's defaults so a plain "vitest run" behaves exactly as it did before
// this file existed; coverage is opt-in through "npm run test:coverage" and CI does not
// pay for it.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      // V8's native counters, not istanbul instrumentation: the suite is plain ES
      // modules in the Node pool with no transform, which is where V8 is both cheapest
      // and most faithful to the source.
      provider: "v8",

      // Load-bearing. vitest 4 reports only files a test imported unless include names
      // them, which would silently omit exactly the zero-coverage files the report
      // exists to surface. (vitest 4 has no `all` option; include replaced it.)
      include: ["src/**/*.js", "scripts/**/*.js"],

      exclude: [
        "test/**",
        // Well covered, but only through a CHILD PROCESS: test/applyLocalSql.test.js
        // spawns it with a fake npx on PATH, which the in-process V8 instrumenter
        // cannot see. Left in, it reports 0% and teaches readers to discount the
        // number.
        "scripts/apply-local-sql.js",
        "**/.wavegrids/**",
        "**/.layers/**",
        "**/.wrangler/**",
        "**/node_modules/**",
        "**/dist/**",
        "**/*.config.js"
      ],

      // Text for the terminal, json-summary for anything that wants to read the numbers
      // back. No html or lcov: both write a directory nobody opens.
      reporter: ["text", "json-summary"]

      // No thresholds. A threshold added before the gaps are closed turns the next
      // deleted test file into a CI failure that says nothing about the change.
    }
  }
});
