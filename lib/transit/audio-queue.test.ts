/**
 * The stall watchdog.
 *
 * A `play()` that never settles used to deadlock the drain loop, losing every
 * later announcement — including the critical one. Observed for real when the
 * page was backgrounded: a suspended AudioContext accepts `source.start()` and
 * never fires `onended`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { AudioQueue, type Announcement, type ClipPlayer, type QueueEvent } from "./audio-queue";

/** Never resolves for `stallOn`, resolves instantly otherwise. */
class StallingPlayer implements ClipPlayer {
  played: string[] = [];
  constructor(private stallOn: Set<string>) {}
  has() { return true; }
  play(key: string, signal: AbortSignal): Promise<void> {
    this.played.push(key);
    if (!this.stallOn.has(key)) return Promise.resolve();
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
}

/**
 * `expiresAt` is required on every Announcement, so the helper has to name one.
 * Far future here: these tests are about the stall watchdog and preemption, and
 * an announcement expiring mid-test would be a second variable in the result.
 * Expiry has its own tests below.
 */
const say = (keys: string[], priority: Announcement["priority"] = "normal", label = ""): Announcement =>
  ({ keys, priority, label, expiresAt: Date.now() + 60_000 });

test("a stalled clip does not deadlock the queue", async () => {
  const player = new StallingPlayer(new Set(["hangs"]));
  const queue = new AudioQueue(player, 40);
  const events: QueueEvent[] = [];
  queue.on((e) => events.push(e));

  queue.push(say(["hangs"], "critical", "stalls"));
  queue.push(say(["bus_get_off_now"], "critical", "ARRIVED"));

  await new Promise((r) => setTimeout(r, 400));

  assert.ok(events.some((e) => e.type === "stalled"), "the stall was not reported");
  assert.ok(
    player.played.includes("bus_get_off_now"),
    "the arrival announcement never played — the queue deadlocked behind a stalled clip",
  );
});

test("a stall is reported, never passed off as silence", async () => {
  const player = new StallingPlayer(new Set(["hangs"]));
  const queue = new AudioQueue(player, 30);
  const stalls: string[] = [];
  queue.on((e) => { if (e.type === "stalled") stalls.push(e.key); });
  queue.push(say(["hangs"]));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(stalls, ["hangs"]);
});

test("normal playback is unaffected by the watchdog", async () => {
  const player = new StallingPlayer(new Set());
  const queue = new AudioQueue(player, 50);
  const ends: string[] = [];
  queue.on((e) => { if (e.type === "end") ends.push(e.announcement.label ?? ""); });
  queue.push(say(["a", "b"], "normal", "first"));
  queue.push(say(["c"], "normal", "second"));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(ends, ["first", "second"]);
  assert.deepEqual(player.played, ["a", "b", "c"]);
});

// ------------------------------------------------ expiry, cooldown, earcons

/** Resolves after `ms` of real time; the queue's own waits are injected. */
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

class SlowPlayer implements ClipPlayer {
  played: string[] = [];
  constructor(private ms: number) {}
  has() { return true; }
  play(key: string, signal: AbortSignal): Promise<void> {
    this.played.push(key);
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, this.ms);
      signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
    });
  }
}

/**
 * THE REASON expiresAt IS MANDATORY.
 *
 * A count queued behind a longer utterance reaches the front after the bus has
 * moved. Speaking "хоёр буудал үлдлээ" as the doors open at the destination is
 * not a stale nicety — it tells a blind rider to stay in their seat.
 */
test("an announcement that expired while queued is dropped, not spoken", async () => {
  const player = new SlowPlayer(60);
  let clock = 1_000_000;
  const queue = new AudioQueue(player, { now: () => clock });
  const events: QueueEvent[] = [];
  queue.on((e) => events.push(e));

  queue.push({ keys: ["long"], priority: "normal", expiresAt: clock + 50_000, label: "long" });
  queue.push({ keys: ["stale"], priority: "normal", expiresAt: clock + 30, label: "count" });

  clock += 5_000;          // the world moved on while "long" was playing
  await settle(200);

  assert.ok(!player.played.includes("stale"), "a stale count was spoken");
  assert.ok(events.some((e) => e.type === "expired"), "the drop was not reported");
});

test("an announcement still valid at the front is spoken normally", async () => {
  const player = new SlowPlayer(10);
  const clock = 1_000_000;
  const queue = new AudioQueue(player, { now: () => clock });
  queue.push({ keys: ["a"], priority: "normal", expiresAt: clock + 60_000, label: "a" });
  queue.push({ keys: ["b"], priority: "normal", expiresAt: clock + 60_000, label: "b" });
  await settle(150);
  assert.deepEqual(player.played, ["a", "b"]);
});

test("an announcement already stale on arrival never enters the queue", async () => {
  const player = new SlowPlayer(5);
  const clock = 1_000_000;
  const queue = new AudioQueue(player, { now: () => clock });
  const events: QueueEvent[] = [];
  queue.on((e) => events.push(e));
  queue.push({ keys: ["born-dead"], priority: "normal", expiresAt: clock - 1, label: "late fix" });
  await settle(50);
  assert.deepEqual(player.played, []);
  assert.equal(events.filter((e) => e.type === "expired").length, 1);
});

test("cooldownMs suppresses a repeat that dedupeKey alone cannot", async () => {
  // dedupeKey only collapses items still WAITING. Once one has been spoken the
  // queue forgets it, so a flapping state says the same sentence over and over.
  const player = new SlowPlayer(5);
  let clock = 1_000_000;
  const queue = new AudioQueue(player, { now: () => clock });
  const say = () => queue.push({
    keys: ["x"], priority: "normal", dedupeKey: "remaining-2", cooldownMs: 30_000,
    expiresAt: clock + 60_000, label: "2 stops",
  });

  say();
  await settle(60);
  clock += 5_000;
  say();                      // inside the cooldown
  await settle(60);
  assert.deepEqual(player.played, ["x"], "the repeat was not suppressed");

  clock += 30_000;            // past it
  say();
  await settle(60);
  assert.deepEqual(player.played, ["x", "x"], "the cooldown never released");
});

test("a preempted announcement does not start its cooldown", async () => {
  // It was never heard. Suppressing the repeat would lose it entirely.
  const player = new SlowPlayer(80);
  const clock = 1_000_000;
  const queue = new AudioQueue(player, { now: () => clock });

  queue.push({
    keys: ["quiet"], priority: "normal", dedupeKey: "k", cooldownMs: 60_000,
    expiresAt: clock + 60_000, label: "quiet",
  });
  await settle(20);
  queue.push({ keys: ["URGENT"], priority: "critical", expiresAt: clock + 60_000, label: "urgent" });
  await settle(250);

  queue.push({
    keys: ["quiet"], priority: "normal", dedupeKey: "k", cooldownMs: 60_000,
    expiresAt: clock + 60_000, label: "quiet again",
  });
  await settle(250);

  assert.equal(player.played.filter((k) => k === "quiet").length, 2, "the lost utterance was suppressed");
});

test("the earcon leads the words, and the haptic goes out with it", async () => {
  const player = new SlowPlayer(5);
  let clock = 1_000_000;
  const order: string[] = [];
  const queue = new AudioQueue(player, {
    now: () => clock,
    earcons: { play: async (id) => { order.push(`earcon:${id}`); } },
    vibrate: (p) => order.push(`haptic:${p.length}`),
    // Injected so the 250 ms lead is asserted rather than waited for.
    wait: async (ms) => { order.push(`wait:${ms}`); clock += ms; },
  });

  queue.push({
    keys: ["words"], priority: "critical", earcon: "urgent", haptic: [800],
    expiresAt: clock + 60_000, label: "arrived",
  });
  await settle(80);

  assert.deepEqual(order, ["haptic:1", "earcon:urgent", "wait:250"]);
  assert.deepEqual(player.played, ["words"], "the words never played after the earcon");
});

test("an earcon that fails to play never costs the words", async () => {
  const player = new SlowPlayer(5);
  const clock = 1_000_000;
  const queue = new AudioQueue(player, {
    now: () => clock,
    earcons: { play: async () => { throw new Error("no audio context"); } },
    wait: async () => {},
  });
  queue.push({
    keys: ["Одоо буугаарай"], priority: "critical", earcon: "urgent",
    expiresAt: clock + 60_000, label: "arrived",
  });
  await settle(80);
  assert.deepEqual(player.played, ["Одоо буугаарай"]);
});

/**
 * The phone talking into its own recording is the failure this prevents.
 * Push-to-talk takes the lock; queued items keep expiring against the clock
 * while it is held, so a long utterance does not come back to a stale backlog.
 */
test("nothing is spoken while the microphone is open", async () => {
  const player = new SlowPlayer(5);
  let clock = 1_000_000;
  const queue = new AudioQueue(player, { now: () => clock });

  queue.setMicOpen(true);
  queue.push({ keys: ["fresh"], priority: "normal", expiresAt: clock + 60_000, label: "fresh" });
  queue.push({ keys: ["stale"], priority: "normal", expiresAt: clock + 1_000, label: "stale" });
  await settle(60);
  assert.deepEqual(player.played, [], "the queue spoke over the microphone");

  clock += 5_000;             // the rider was talking for five seconds
  queue.setMicOpen(false);
  await settle(80);
  assert.deepEqual(player.played, ["fresh"], "the stale item survived the lock");
});

test("a critical announcement still waits for the microphone", async () => {
  const player = new SlowPlayer(5);
  const clock = 1_000_000;
  const queue = new AudioQueue(player, { now: () => clock });
  queue.setMicOpen(true);
  queue.push({ keys: ["URGENT"], priority: "critical", expiresAt: clock + 60_000, label: "urgent" });
  await settle(60);
  assert.deepEqual(player.played, []);
  queue.setMicOpen(false);
  await settle(60);
  assert.deepEqual(player.played, ["URGENT"]);
});

// ------------------------------------------- §5 parallel channels survive

/** Decodes nothing — the total-failure case earcons exist for. */
class DeadPlayer implements ClipPlayer {
  has() { return false; }
  play() { return Promise.resolve(); }
}

test("a total decode failure still fires the earcon and the haptic", async () => {
  /**
   * The queue used to abandon an announcement whose clips had all failed,
   * which made the one case earcons exist for the one case they never fired.
   * earcons.ts is explicit that they must survive it, because that is exactly
   * when the rider most needs to know something happened.
   */
  const earcons: string[] = [];
  const buzzes: number[][] = [];
  const queue = new AudioQueue(new DeadPlayer(), {
    earcons: { play: async (id: string) => { earcons.push(id); } },
    vibrate: (p: number[]) => buzzes.push(p),
    wait: async () => {},
  });

  queue.push({
    keys: ["nothing_decodes"],
    priority: "critical",
    earcon: "urgent",
    haptic: [800],
    expiresAt: Date.now() + 60_000,
    label: "arrival with no clips",
  });
  await settle(120);

  assert.deepEqual(earcons, ["urgent"], "the earcon was dropped along with the words");
  assert.deepEqual(buzzes, [[800]], "the haptic was dropped along with the words");
});

test("an announcement with nothing in ANY channel is still dropped", async () => {
  // The exception is for the redundant channels, not a licence to keep silent
  // announcements alive in the queue.
  const events: string[] = [];
  const queue = new AudioQueue(new DeadPlayer(), { wait: async () => {} });
  queue.on((e) => events.push(e.type));
  queue.push({
    keys: ["nothing_decodes"],
    priority: "normal",
    expiresAt: Date.now() + 60_000,
    label: "nothing to say",
  });
  await settle(120);
  assert.ok(!events.includes("start"), "an announcement with no channels was started anyway");
});
