/**
 * Destination lists at scale.
 *
 * The longest direction in the city is 36 stops and the longest route 72 across
 * both. Cycling those one swipe at a time is unusable, so the list is layered:
 * the places this user actually goes come first, then the route in order.
 *
 * The premise is that journeys repeat. A commuter riding the same line twice a
 * day should reach their stop in one or two gestures, and only a genuinely new
 * journey should cost a scroll through the whole sequence.
 *
 * Pure: history is passed in and returned, never read from storage here, so the
 * ranking is testable without a browser.
 */

export type DestinationVisit = {
  stopId: string;
  routeId: string;
  /** Epoch ms of the most recent trip to this stop on this route. */
  lastUsedAt: number;
  count: number;
};

export type DestinationHistory = Record<string, DestinationVisit>;

const key = (routeId: string, stopId: string) => `${routeId}:${stopId}`;

export const HISTORY_KEY = "vision-access:destinations";

/** Above this many uses a destination counts as "frequent" rather than merely recent. */
export const FREQUENT_THRESHOLD = 3;

/** How many shortcuts to offer before the full sequence. More than this and the shortcut is itself a scroll. */
export const MAX_SHORTCUTS = 5;

/** A trip older than this stops being a useful suggestion. */
export const RECENT_WINDOW_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

export function recordVisit(
  history: DestinationHistory,
  routeId: string,
  stopId: string,
  now = Date.now(),
): DestinationHistory {
  const k = key(routeId, stopId);
  const existing = history[k];
  return {
    ...history,
    [k]: {
      stopId,
      routeId,
      lastUsedAt: now,
      count: (existing?.count ?? 0) + 1,
    },
  };
}

export type DestinationEntry = {
  stopId: string;
  /** Index in the route's ordered sequence — what Mode B counts from. */
  index: number;
  group: "frequent" | "recent" | "all";
  /** 1-based position within the whole presented list, for "12 дахь, 40-оос". */
  position: number;
  visits?: number;
};

/**
 * Builds the list a user actually swipes through.
 *
 * Shortcuts are deduplicated against the tail: a stop promoted to the top does
 * NOT reappear further down. Hearing the same stop twice in one list would make
 * a user doubt they had moved at all.
 */
export function buildDestinationList(
  sequence: string[],
  boardingIndex: number,
  history: DestinationHistory,
  routeId: string,
  {
    now = Date.now(),
    maxShortcuts = MAX_SHORTCUTS,
    isNameable = () => true,
  }: { now?: number; maxShortcuts?: number; isNameable?: (stopId: string) => boolean } = {},
): DestinationEntry[] {
  // Only stops ahead of where the user boarded can be destinations, and only
  // ones that can be named — a user cannot choose what the app cannot say.
  const reachable = sequence
    .map((stopId, index) => ({ stopId, index }))
    .filter(({ index, stopId }) => index > boardingIndex && isNameable(stopId));

  const reachableIds = new Set(reachable.map((r) => r.stopId));

  const visits = Object.values(history)
    .filter((v) => v.routeId === routeId)
    .filter((v) => reachableIds.has(v.stopId))
    .filter((v) => now - v.lastUsedAt <= RECENT_WINDOW_MS);

  const frequent = visits
    .filter((v) => v.count >= FREQUENT_THRESHOLD)
    .sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt);

  const recent = visits
    .filter((v) => v.count < FREQUENT_THRESHOLD)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);

  const shortcuts = [...frequent, ...recent].slice(0, maxShortcuts);
  const promoted = new Set(shortcuts.map((s) => s.stopId));

  const entries: DestinationEntry[] = [];
  let position = 1;

  for (const visit of shortcuts) {
    const found = reachable.find((r) => r.stopId === visit.stopId)!;
    entries.push({
      stopId: visit.stopId,
      index: found.index,
      group: visit.count >= FREQUENT_THRESHOLD ? "frequent" : "recent",
      position: position++,
      visits: visit.count,
    });
  }

  for (const { stopId, index } of reachable) {
    if (promoted.has(stopId)) continue;
    entries.push({ stopId, index, group: "all", position: position++ });
  }

  return entries;
}

export function loadHistory(storage: Storage): DestinationHistory {
  try {
    const raw = storage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as DestinationHistory) : {};
  } catch {
    return {};
  }
}

export function saveHistory(storage: Storage, history: DestinationHistory): void {
  try {
    storage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Private mode. The list still works, it simply does not learn.
  }
}
