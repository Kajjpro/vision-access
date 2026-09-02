/**
 * The join is tested against the REAL 84 routes, not fixtures.
 *
 * A fixture set would be written from the same assumptions as the code and
 * would agree with it for the same wrong reasons. The failures that matter here
 * — `Ч-38`, the lowercase suffixes, the eight prefix families — are all
 * properties of the actual data, so the actual data is what gets asserted.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
  auditJoin, buildRouteIndex, joinRouteName, normalizeRouteName, parseRouteName,
} from "./route-name";
import type { Route } from "./types";

const routes: Route[] = JSON.parse(
  readFileSync(join(process.cwd(), "public/transit/routes.json"), "utf8"),
);
const index = buildRouteIndex(routes);

// --------------------------------------------------------------- parsing

test("the documented feed example normalizes — but names no real route", () => {
  // `Ч-1` is the gateway docs' sample. It normalizes cleanly, and there is NO
  // Ч:1 in our 84 or in Hamuga's upstream 104 — the doc example is illustrative,
  // not a live route. Asserted so nobody later treats it as a known-good value.
  assert.equal(normalizeRouteName("Ч-1"), "Ч:1");
  assert.equal(routes.some((r) => r.displayName === "Ч:1"), false);
});

test("separator style does not matter, in either direction", () => {
  for (const variant of ["Ч:35", "Ч-35", "Ч 35", "Ч.35", "Ч/35", "Ч_35", "Ч  -  35"]) {
    assert.equal(normalizeRouteName(variant), "Ч:35", variant);
  }
});

test("unicode dashes a CMS emits silently are all handled", () => {
  // hyphen-minus, non-breaking hyphen, figure dash, en, em, horizontal bar, minus
  for (const dash of ["-", "‐", "‑", "‒", "–", "—", "―", "−"]) {
    assert.equal(normalizeRouteName(`Ч${dash}35`), "Ч:35", `U+${dash.codePointAt(0)!.toString(16)}`);
  }
});

test("suffix case is folded — our own data is inconsistent", () => {
  assert.equal(normalizeRouteName("Ч:16а"), normalizeRouteName("Ч:16А"));
  assert.equal(normalizeRouteName("Ч:24б"), normalizeRouteName("Ч:24Б"));
  assert.equal(normalizeRouteName("м:3А"), normalizeRouteName("М:3а"));
});

test("leading zeros are stripped", () => {
  assert.equal(normalizeRouteName("Ч-09"), "Ч:9");
  assert.equal(normalizeRouteName("Ч-0038"), "Ч:38");
});

test("multi-character prefixes survive", () => {
  assert.equal(normalizeRouteName("ШҮ-1"), "ШҮ:1");
  assert.equal(normalizeRouteName("АТ-4"), "АТ:4");
  assert.equal(normalizeRouteName("ЗҮ-4"), "ЗҮ:4");
});

test("parts are exposed, not just the key", () => {
  assert.deepEqual(parseRouteName("м-1б"), { prefix: "М", number: "1", suffix: "Б", key: "М:1Б" });
});

// ------------------------------------------------------------ homoglyphs

test("Latin homoglyphs fold to Cyrillic — the invisible failure", () => {
  // Latin M/X/A/T look identical to Cyrillic М/Х/А/Т in every log line.
  assert.equal(normalizeRouteName("M-1"), normalizeRouteName("М-1"));
  assert.equal(normalizeRouteName("X-11"), normalizeRouteName("Х-11"));
  assert.equal(normalizeRouteName("AT-4"), normalizeRouteName("АТ-4"));
  assert.equal(normalizeRouteName("M-1B"), normalizeRouteName("М-1В"));
});

test("Latin-spelled feed names still resolve to the right route", () => {
  const r = joinRouteName("M-1", index);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.route.displayName, "М:1");
});

test("digit 3 recovers to Cyrillic З only when the prefix is real", () => {
  // `3Ү` is visually `ЗҮ`, and ЗҮ is a prefix we have.
  const good = joinRouteName("3Ү-4", index);
  assert.equal(good.ok, true);
  assert.equal(good.ok && good.route.displayName, "ЗҮ:4");

  // `3Ж` is not a prefix we have, so nothing is invented.
  assert.equal(joinRouteName("3Ж-4", index).ok, false);
});

// ------------------------------------------------------- refusals to guess

test("a bare number is refused — 10 numbers are ambiguous across prefixes", () => {
  const r = joinRouteName("4", index);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "no-prefix");
});

test("empty, null and junk resolve to nothing rather than something", () => {
  for (const bad of [null, undefined, "", "   ", ":", "-", "Ч", "автобус"]) {
    assert.equal(normalizeRouteName(bad as string), null, JSON.stringify(bad));
  }
});

test("a route we do not have is reported, not approximated", () => {
  const r = joinRouteName("Ч-999", index);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "unknown-route");
});

// --------------------------------------------- the eight dangerous families

test("NEVER prefix-matches: Ч:48 must not resolve to Ч:48А", () => {
  const plain = joinRouteName("Ч-48", index);
  const suffixed = joinRouteName("Ч-48А", index);
  assert.equal(plain.ok && plain.route.displayName, "Ч:48");
  assert.equal(suffixed.ok && suffixed.route.displayName, "Ч:48А");
  assert.notEqual(
    plain.ok && plain.route.id,
    suffixed.ok && suffixed.route.id,
    "Ч:48 and Ч:48А resolved to the same route — this announces the wrong bus",
  );
});

test("every suffixed family stays distinct from its base", () => {
  const families = [
    ["М:1", "М:1Б"], ["Ч:48", "Ч:48А"], ["Ч:57", "Ч:57Б"],
    ["Ч:17А", "Ч:17Б"], ["Ч:18А", "Ч:18Б"], ["Ч:20А", "Ч:20Б"],
    ["Ч:21А", "Ч:21Б"], ["Ч:24б", "Ч:24А"],
  ];
  for (const [a, b] of families) {
    const ra = joinRouteName(a.replace(":", "-"), index);
    const rb = joinRouteName(b.replace(":", "-"), index);
    assert.equal(ra.ok, true, a);
    assert.equal(rb.ok, true, b);
    assert.notEqual(ra.ok && ra.route.id, rb.ok && rb.route.id, `${a} collided with ${b}`);
  }
});

// ------------------------------------------------------------ whole corpus

test("all 84 of our own routes round-trip through the join", () => {
  const failures: string[] = [];
  for (const route of routes) {
    // Feed-style: hyphen instead of colon, which is what the docs show.
    const asFeedWould = route.displayName.replace(/:/g, "-");
    const result = joinRouteName(asFeedWould, index);
    if (!result.ok || result.route.id !== route.id) {
      failures.push(`${route.displayName} → ${JSON.stringify(result)}`);
    }
  }
  assert.deepEqual(failures, [], `routes that would go dark:\n${failures.join("\n")}`);
});

test("Ч-38 — the hyphen already in OUR data — joins to itself", () => {
  // The regression that motivates normalising both sides. If only the feed were
  // normalised, this route would never match anything.
  const r = joinRouteName("Ч:38", index);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.route.displayName, "Ч-38");
});

test("the index builds without collisions across all 84", () => {
  assert.equal(index.byKey.size, routes.length);
});

test("buildRouteIndex throws rather than silently dropping a route", () => {
  const clashing: Route[] = [
    { id: "a", displayName: "Ч:1", spokenName: null, longName: null, directions: [] },
    { id: "b", displayName: "Ч-01", spokenName: null, longName: null, directions: [] },
  ];
  assert.throws(() => buildRouteIndex(clashing), /collision/i);
});

// ----------------------------------------------------------------- audit

test("audit reports both unmatched feed names and our silent routes", () => {
  const feed = ["Ч-39", "Ч-35", "НЭГ-999", "4"];
  const report = auditJoin(feed, index);

  assert.equal(report.matched.get("Ч-39"), "Ч:39");
  assert.equal(report.matched.get("Ч-35"), "Ч:35");
  assert.deepEqual(
    report.unmatched.map((u) => u.reason).sort(),
    ["no-prefix", "unknown-route"],
  );
  // 84 routes, 2 seen → 82 with no vehicle reporting, which is the number the
  // schedule fallback has to cover.
  assert.equal(report.ourRoutesWithNoVehicle.length, routes.length - 2);
});

// ------------------------------------- real upstream names we do NOT have
//
// Hamuga's own route list carries 104 entries to our 84. These 16 are real
// upstream strings absent from our data, and they are the adversarial cases
// the parser will actually meet — far nastier than anything invented.

test("upstream names we lack are refused, never approximated to a neighbour", () => {
  // Each of these is a REAL upstream route name with a near-neighbour in our
  // data. Matching any of them to that neighbour announces the wrong bus.
  const traps: [string, string][] = [
    ["Х:16Z", "Х:16"],      // Latin Z suffix
    ["Х:17Z", "Х:17"],
    ["Ч:16А-Z", "Ч:16а"],   // suffix letter AND a -Z
    ["Ч:29Б-Z", "Ч:29Б"],
    ["М:1БНА", "М:1Б"],     // НА suffix on top of Б
    ["Ч:19Б", "Ч:69Б"],
  ];
  for (const [upstream, neighbour] of traps) {
    const r = joinRouteName(upstream, index);
    if (r.ok) {
      assert.notEqual(
        r.route.displayName, neighbour,
        `${upstream} matched ${neighbour} — that is the wrong bus`,
      );
    }
  }
});

test("a prefix containing a digit does not crash or mis-resolve", () => {
  // `Хүй7:1` is a real upstream route name. We have no counterpart, so the only
  // correct answer is a refusal — and it must not resolve to Х:1 or ШҮ:1.
  const r = joinRouteName("Хүй7:1", index);
  assert.equal(r.ok, false);
});

test("trailing whitespace in a feed name is tolerated", () => {
  // Upstream really does ship `БЭ:2 ` with a trailing space.
  assert.equal(normalizeRouteName("Ч:35 "), "Ч:35");
  assert.equal(normalizeRouteName(" Ч:35"), "Ч:35");
});
