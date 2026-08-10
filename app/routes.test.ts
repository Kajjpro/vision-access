/**
 * Route reachability.
 *
 * Written after the Bus tile shipped pointing at nothing: /bus/wait and
 * /bus/ride existed, were tested, and could not be reached by any tap. Working
 * screens nobody can navigate to is a whole class of bug that no unit test
 * catches, because every unit involved passes.
 *
 * These assertions are static — they read the source rather than render — so
 * they run in CI without a browser or a dev server.
 *
 *   npx tsx --test app/routes.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const APP = "app";

/** Every directory under app/ that contains a page.tsx, as a URL path. */
function discoverRoutes(dir = APP, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    // Route groups (x) do not appear in the URL; dynamic [x] cannot be checked statically.
    const segment = entry.startsWith("(") ? "" : `/${entry}`;
    if (existsSync(join(full, "page.tsx"))) out.push(`${prefix}${segment}` || "/");
    out.push(...discoverRoutes(full, `${prefix}${segment}`));
  }
  return out;
}

const routes = discoverRoutes();
// The tile table lives in HomeGestures.tsx since the gesture rebuild; page.tsx
// is now a thin wrapper. Both are read so the assertions follow the code.
const homeSource =
  readFileSync(join(APP, "page.tsx"), "utf8") + "\n" + readFileSync(join(APP, "HomeGestures.tsx"), "utf8");

test("the home screen declares at least one navigable tile", () => {
  assert.match(homeSource, /HOME_TILE_ROUTES/, "home must export its tile routes for this test to check them");
});

test("every home tile points at a route that exists", () => {
  // Parsed from source rather than imported: app/page.tsx is a client component
  // whose imports pull in the audio stack and next/navigation.
  const block = /const MODES: Mode\[\] = \[([\s\S]*?)\];/.exec(homeSource);
  assert.ok(block, "could not find the MODES table in app/page.tsx");

  const declared = [...block[1].matchAll(/route:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(declared.length > 0, "no tile declares a route — the grid goes nowhere");

  for (const route of declared) {
    assert.ok(
      routes.includes(route),
      `home tile points at ${route}, which has no page.tsx. Routes found: ${routes.join(", ")}`,
    );
  }
});

test("the bus tile is wired — the specific regression", () => {
  const block = /const MODES: Mode\[\] = \[([\s\S]*?)\];/.exec(homeSource)!;
  const busLine = block[1].split("\n").find((l) => l.includes('id: "bus"'));
  assert.ok(busLine, "no bus tile in the grid");
  assert.match(busLine, /route:\s*"\/bus\/wait"/, "the bus tile must navigate to /bus/wait");
});

test("no tile is both routed and inline — they dispatch differently", () => {
  const block = /const MODES: Mode\[\] = \[([\s\S]*?)\];/.exec(homeSource)!;
  for (const line of block[1].split("\n")) {
    if (line.includes("route:") && line.includes("component:")) {
      assert.fail(`a tile declares both a route and a component: ${line.trim()}`);
    }
  }
});

test("mode dispatch actually consults which tile was selected", () => {
  // The original bug: `setActive(id)` was followed by an unconditional
  // `<WalkMode />`, so every ready mode rendered WalkMode whatever was chosen.
  assert.match(
    homeSource,
    /if \(active === "walk"\)/,
    "the inline branch must check WHICH mode is active, not merely that one is",
  );
  assert.match(homeSource, /if \(mode\.route\) router\.push\(mode\.route\)/, "routed modes must navigate");
});

test("the home screen has no positional touch targets", () => {
  // The whole point of the rebuild: no quadrant to find, no button to aim at.
  assert.doesNotMatch(homeSource, /data-mode=/, "quadrant hit-testing must be gone");
  assert.doesNotMatch(homeSource, /elementFromPoint/, "position-based dispatch must be gone");
  assert.match(homeSource, /useGestureNav/, "home must use the shared gesture model");
});

test("every mode option carries a spoken grid position", () => {
  const block = /const MODES: Mode\[\] = \[([\s\S]*?)\];/.exec(homeSource)!;
  for (const line of block[1].split("\n").filter((l) => l.includes("id:"))) {
    assert.match(line, /position: POSITION\./, `no spoken position: ${line.trim()}`);
  }
});

test("every discovered page has a default export", () => {
  for (const route of routes) {
    const path = route === "/" ? join(APP, "page.tsx") : join(APP, route, "page.tsx");
    const src = readFileSync(path, "utf8");
    assert.match(src, /export default (async )?function/, `${route} has no default export`);
  }
});

test("bus pages read only baked data — Mode B must work offline", () => {
  // A fetch() in the ride path would make the countdown depend on a network
  // that is precisely what a bus does not have.
  const ride = readFileSync(join(APP, "bus/ride/page.tsx"), "utf8") +
    readFileSync(join(APP, "bus/ride/RideScreen.tsx"), "utf8");
  assert.doesNotMatch(ride, /\bfetch\(/, "Mode B must not perform any network request");
});

test("the wait screen is the only bus screen allowed to touch the network", () => {
  const wait = readFileSync(join(APP, "bus/wait/WaitScreen.tsx"), "utf8");
  assert.match(wait, /\/api\/transit\/next/, "the wait screen should call the proxy, not the gateway");
  assert.doesNotMatch(wait, /gateway\.hamuga\.mn/, "the browser must never call the gateway directly");
});

test("no client component embeds an API key", () => {
  const clientFiles = [
    "bus/wait/WaitScreen.tsx", "bus/ride/RideScreen.tsx", "page.tsx",
  ].map((f) => join(APP, f));
  for (const f of clientFiles) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /HAMUGA_API_KEY|AZURE_SPEECH_KEY|CHIMEGE_TOKEN/, `${f} references a secret`);
  }
});

test("leaving a bus screen tears down tracking, not just the component", () => {
  const ride = readFileSync(join(APP, "bus/ride/RideScreen.tsx"), "utf8");
  // A stale "Одоо буугаарай" thirty seconds after leaving puts someone off at
  // the wrong stop, so teardown must run BEFORE navigation, not only on unmount.
  assert.match(ride, /const teardown = useCallback/, "ride must have an explicit teardown");
  assert.match(ride, /clearWatch/, "teardown must cancel watchPosition");
  assert.match(ride, /wakeLockRef\.current\.release\(\)/, "teardown must release the wake lock");
  assert.match(ride, /queueRef\.current\?\.clear\(\)/, "teardown must flush the audio queue");
  assert.match(ride, /await teardown\(\);\s*\n\s*router\.push/, "teardown must complete before navigating");
});

test("both bus screens offer a way home", () => {
  for (const f of ["bus/wait/WaitScreen.tsx", "bus/ride/RideScreen.tsx"]) {
    const src = readFileSync(join(APP, f), "utf8");
    assert.match(src, /router\.push\("\/"\)/, `${f} has no route home`);
  }
});
