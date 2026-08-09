/**
 * Regression test for the GraphQL null-name landmine.
 *
 * 40 stops in the feed have a null `name`, and the OTP schema declares `name`
 * non-null. A query that selects it therefore bubbles the error all the way up
 * and returns `routes: null` — losing all 104 routes to one bad staging record.
 * That failure appeared between the discovery probe and the first build run,
 * and it is invisible until the feed happens to contain one.
 *
 *   npx tsx --test scripts/*.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync("scripts/build-transit-data.mjs", "utf8");

/** The `{ ... }` body of a named template literal in the build script. */
function query(name: string): string {
  const m = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`).exec(source);
  assert.ok(m, `${name} not found in build-transit-data.mjs`);
  return m[1];
}

test("the routes query never selects stop name", () => {
  const q = query("ALL_ROUTES_QUERY");
  const stopsBlock = /stops\s*\{([^}]*)\}/.exec(q);
  assert.ok(stopsBlock, "routes query has no stops selection");
  assert.doesNotMatch(
    stopsBlock[1],
    /\bname\b/,
    "ALL_ROUTES_QUERY selects stops.name — one null name in the feed nulls the entire routes field " +
      "and the build loses all 104 routes. Resolve names via ALL_STOP_NAMES_QUERY instead.",
  );
});

test("stop names are fetched by a separate query that tolerates nulls", () => {
  const q = query("ALL_STOP_NAMES_QUERY");
  assert.match(q, /stops\s*\{[^}]*\bname\b/, "ALL_STOP_NAMES_QUERY must select name");
  // It must not also pull patterns/routes, or a null name takes those down too.
  assert.doesNotMatch(q, /\bpatterns\b|\broutes\b/);
});

test("null-name rows are filtered rather than trusted", () => {
  assert.match(
    source,
    /rows\.filter\(\(s\) => s\?\.gtfsId && s\.name\)/,
    "the stop-name fetch must drop null entries; GraphQL returns them as nulls in the list",
  );
});

test("a stop with no name in any source is dropped, never shipped nameless", () => {
  // A route reaching a stop we cannot name would announce nothing, and silence
  // reads to the user as "we have not arrived yet".
  assert.match(source, /unnameable\.push/);
  assert.match(source, /have an empty name — they cannot be spoken/);
});

test("staging routes are excluded from the authority's served set", () => {
  // Without this, 53 test records were kept as real stops on the
  // "authority outranks routing engine" rule.
  assert.match(source, /if \(\/\^66\/\.test\(rid\)\) \{/);
});
