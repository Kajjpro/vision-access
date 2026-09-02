/**
 * EVERY string the app can speak, in one file.
 *
 * For a user who cannot see the screen, this file IS the interface. Reading it
 * top to bottom should tell you exactly what the app can ever say, in the order
 * it says it. Nothing user-facing may be assembled from string literals
 * scattered through components.
 *
 * Each entry carries:
 *   `clip` — the pre-rendered manifest key, or null where no clip exists yet.
 *   `mn`   — the Mongolian text. This is what gets rendered next pass.
 *   `en`   — a gloss for people reading this file. NEVER spoken.
 *
 * Where `clip` is null the phrase is not yet rendered; the audio queue reports
 * the gap rather than going silent, because silence reads to the user as
 * "nothing to report" — the one failure mode that strands someone.
 */

export type Phrase = {
  clip: string | null;
  mn: string;
  en: string;
};

const p = (clip: string | null, mn: string, en: string): Phrase => ({ clip, mn, en });

// ---------------------------------------------------------------- gestures
// The welcome and the navigation cues. There is no tutorial: the welcome names
// what the app does and how to move through it, and that is the whole of the
// teaching a user gets.

export const GESTURE = {
  /**
   * The first thing anyone hears. Spoken immediately on opening — no tutorial,
   * no practice, no gate. It names what the app can do AND how to move through
   * it in one breath, because a blind user opening an unknown app needs both
   * facts at once and will not sit through a lesson to get them.
   */
  welcome: p("ui_welcome",
    "Харааны Хандалт. Дээш доош шударч сонголтоо сонсоно уу. Хоёр удаа товшиж сонгоно уу.",
    "Vision Access. Swipe up or down to hear the options. Double-tap to choose."),

  /** Long press: "where am I". Followed by the screen name and current option. */
  whereAmI: p("ui_where_am_i", "Та одоо энд байна:", "You are here:"),
  /** Played when a list wraps past its end, so a loop is not mistaken for an endless list. */
  listWrapped: p("ui_list_wrapped", "Жагсаалтын эхэнд буцлаа.", "Back to the start of the list."),
  noOptions: p("ui_no_options", "Сонголт алга байна.", "There are no options."),
  back: p("ui_back", "Буцлаа", "Went back"),
} as const;

// ------------------------------------------------------------------ screens
// The screen name is spoken on arrival and on "where am I", so a user always
// knows which of the three places they are in.

export const SCREEN = {
  home: p("ui_screen_home", "Үндсэн цэс", "Main menu"),
  wait: p("ui_screen_wait", "Автобус хүлээх", "Waiting for a bus"),
  ride: p("ui_screen_ride", "Автобусанд явж байна", "Riding the bus"),
  destination: p("ui_screen_destination", "Хаана буух вэ", "Where are you getting off"),
} as const;

// -------------------------------------------------------------- home modes
// Each carries its grid position, spoken as part of the option. Position is
// useless to a fully blind user navigating by ear, but it costs nothing and it
// helps someone with partial vision or a sighted companion looking over their
// shoulder.

export const POSITION = {
  topLeft: p("ui_pos_top_left", "зүүн дээд", "top left"),
  topRight: p("ui_pos_top_right", "баруун дээд", "top right"),
  bottomLeft: p("ui_pos_bottom_left", "зүүн доод", "bottom left"),
  bottomRight: p("ui_pos_bottom_right", "баруун доод", "bottom right"),
} as const;

export const MODE = {
  walk: p("mode_walk", "Алхах", "Walk"),
  scene: p("mode_scene", "Юу байна?", "What is there?"),
  bus: p("mode_bus", "Автобус", "Bus"),
  settings: p("mode_settings", "Тохиргоо", "Settings"),
  comingSoon: p("coming_soon", "Тун удахгүй", "Coming soon"),
} as const;

// -------------------------------------------------------------- wait screen

export const WAIT = {
  findStop: p("ui_wait_find_stop", "Буудлаа олох", "Find my stop"),
  locating: p("ui_wait_locating", "Байршил тодорхойлж байна", "Finding your location"),
  youAreAtPrefix: p("bus_you_are_at", "Та", "You are at … (prefix)"),
  youAreAtSuffix: p("bus_at_stop_suffix", "буудал дээр байна", "… (suffix) you are at stop"),
  confirmStop: p("ui_wait_confirm_stop", "Тийм, энэ буудал", "Yes, this stop"),
  otherStop: p("ui_wait_other_stop", "Өөр буудал", "A different stop"),
  whichRoute: p("ui_wait_which_route", "Аль чиглэлээр явах вэ?", "Which route are you taking?"),

  /** Arrival times. The hedge is structural — see lib/transit/announce.ts. */
  approxPrefix: p("bus_approx_prefix", "Ойролцоогоор", "In approximately … (prefix)"),
  minutesSuffix: p("bus_minutes_suffix", "минутын дараа", "… minutes"),
  timeUnknown: p("ui_wait_time_unknown", "хугацаа тодорхойгүй", "time unknown"),

  noStopNearby: p("bus_no_stop_nearby", "Ойролцоо буудал олдсонгүй", "No nearby stop found"),

  /** The wait screen locates automatically; this is spoken while it works. */
  searching: p("ui_wait_searching", "Буудлыг хайж байна", "Looking for your stop"),
  /** Offered as the first option: speaking beats scrolling a long list. */
  sayDestination: p("ui_wait_say_destination", "Хаашаа явахаа хэлэх", "Say where you are going"),
  /** Offered alongside, so gestures alone remain sufficient. */
  browseRoutes: p("ui_wait_browse_routes", "Чиглэлүүдийг сонсох", "Hear the routes"),
} as const;

// -------------------------------------------------------------- ride screen

export const RIDE = {
  nextStop: p("bus_next_stop", "Дараагийн буудал", "Next stop"),
  stopsRemaining: p("bus_stops_remaining", "буудал үлдлээ", "… stops remaining"),
  getReady: p("bus_get_ready", "Бэлдээрэй", "Get ready"),
  getOffNow: p("bus_get_off_now", "Одоо буугаарай", "Get off now"),
  passedStop: p("bus_passed_stop", "Та буудлаа өнгөрчээ", "You have passed your stop"),
  unnamedStop: p("bus_unnamed_stop", "Нэргүй буудал", "Unnamed stop"),
  manualAdvance: p("ui_ride_manual_advance", "Нэг буудал өнгөрлөө", "One stop has passed"),
  finish: p("ui_ride_finish", "Дуусгах", "Finish"),
} as const;

// ------------------------------------------------------- degraded states
// One phrase per CAUSE. "Location unavailable" for a rate limit would send a
// user looking for open sky, wasting the one action they might take.

export const DEGRADED = {
  location: p("bus_location_unavailable", "Байршил тодорхойгүй байна", "Location unavailable (GPS)"),
  network: p("bus_network_unavailable", "Сүлжээ алдагдлаа", "Network unavailable"),
  service: p("bus_service_unavailable", "Үйлчилгээ түр боломжгүй байна", "Service temporarily unavailable"),
  routeInfo: p("bus_route_info_unavailable", "Чиглэлийн мэдээлэл алга байна", "Route information unavailable"),
  tracking: p("bus_tracking_degraded", "Байршил тодорхойгүй боллоо. Товчоор буудал нэмнэ үү",
    "Tracking degraded — use the manual advance"),
} as const;

// ------------------------------------------------- destination list at scale

export const LIST = {
  recentHeading: p("ui_list_recent_heading", "Сүүлд явсан", "Recently travelled"),
  frequentHeading: p("ui_list_frequent_heading", "Байнга явдаг", "Frequently travelled"),
  allStopsHeading: p("ui_list_all_stops_heading", "Бүх буудал", "All stops"),
  /** Spoken as: "{n} дахь, {total}-оос" — "nth of total". */
  positionJoiner: p("ui_list_position_joiner", "дахь", "-th"),
  positionOf: p("ui_list_position_of", "-оос", "of"),
  /** Two-finger swipe jumps five at a time through a long sequence. */
  jumpedFive: p("ui_list_jumped_five", "5-р буудал", "5 stops on"),
  stopsAfter: p("ui_list_stops_after", "буудлын дараа", "stops later"),
} as const;

// ----------------------------------------------------------------- voice
// Present but NOT wired: mn-MN recognition support is unverified. See
// docs/voice-input.md. Kept here so the strings are reviewed with the rest.

export const VOICE = {
  /** Spoken before the microphone opens, so the user knows to talk. */
  prompt: p("ui_voice_prompt", "Хаашаа явах вэ? Буудлын нэрээ хэлнэ үү.",
    "Where are you going? Say the name of the stop."),
  /** Confirmation is mandatory: a misheard destination strands someone. */
  didYouSay: p("ui_voice_did_you_say", "Та ингэж хэлсэн үү:", "Did you say:"),
  confirmHint: p("ui_voice_confirm_hint", "Тийм бол хоёр удаа товшино уу. Үгүй бол дээш шудрана уу.",
    "If yes, double-tap. If no, swipe up."),
  noMatch: p("ui_voice_no_match", "Тийм нэртэй буудал олдсонгүй.", "No stop found with that name."),
  listening: p("ui_voice_listening", "Сонсож байна", "Listening"),
  /** Confirmation is mandatory: never act on an unconfirmed recognition. */
  confirmPrefix: p(null, "", "… руу явах уу? (prefix is the destination name)"),
  confirmSuffix: p("ui_voice_confirm_suffix", "руу явах уу?", "… are you going to?"),
  notUnderstood: p("ui_voice_not_understood", "Ойлгосонгүй. Дахин оролдоно уу.", "I did not understand. Please try again."),
  unavailable: p("ui_voice_unavailable", "Дуу хоолойгоор оруулах боломжгүй байна", "Voice input is unavailable"),
} as const;

// ------------------------------------------------------------- journey
// The destination-first flow. Every state transition in lib/transit/journey.ts
// speaks one of these — a transition that cannot be heard did not happen, as
// far as a user who cannot see the screen is concerned.
//
// THE HEDGE DISTINCTION LIVES HERE. `live*` phrases are only ever reachable
// from verified-fresh feed data and carry no hedge. `est*` phrases are
// schedule-derived and always carry "ойролцоогоор". The two must sound
// different, so the user learns which to trust.

export const JOURNEY = {
  /** The first question. Not "which route" — route selection is our problem. */
  askDestination: p("ui_journey_ask_destination", "Хаашаа явах вэ?", "Where are you going?"),

  /** Spoken once a destination is confirmed, before planning starts. */
  planning: p("ui_journey_planning", "Зам хайж байна", "Finding a route"),

  /** "{route} хэрэгтэй" — the plan, spoken as a plan rather than a data dump. */
  routeNeededSuffix: p("ui_journey_route_needed", "хэрэгтэй", "… is what you need"),
  /** "{n} буудал явна" — how far, in the unit the user actually experiences. */
  stopsToTravelSuffix: p("ui_journey_stops_to_travel", "буудал явна", "… stops to travel"),

  /** No route at all reaches the destination from here. */
  noRoute: p("ui_journey_no_route", "Тэр буудал руу энэ буудлаас очих чиглэл алга байна",
    "No route from this stop reaches that stop"),

  /**
   * A transfer, announced BEFORE boarding rather than at the transfer point.
   * Learning mid-journey that you must change is far worse than knowing first.
   */
  transferWarning: p("ui_journey_transfer_warning", "Нэг удаа солино", "You will change once"),
  transferAtPrefix: p("ui_journey_transfer_at", "Дараа нь", "Then, at …"),

  // --- waiting -----------------------------------------------------------

  /** Live, verified-fresh. NO hedge — this is the reward for a proven feed. */
  liveStopsAwaySuffix: p("ui_journey_live_stops_away", "буудлын зайд", "… stops away"),
  /** Live and closing, within one stop. */
  approaching: p("ui_journey_approaching", "ойртож байна", "… is approaching"),
  /** Live, verified within ~50 m. The most dangerous string in the app. */
  arrived: p("ui_journey_arrived", "ирлээ", "… has arrived"),

  /**
   * Schedule-derived. ALWAYS paired with the hedge, and explicitly flagged as
   * an estimate so it cannot be mistaken for the live phrasing above.
   */
  estimateOnly: p("ui_journey_estimate_only", "Тооцоолсон хугацаа", "This is an estimate"),
  /** Spoken when the live feed is unavailable, so silence is never the signal. */
  liveUnavailable: p("ui_journey_live_unavailable", "Автобусны байршил одоогоор алга байна",
    "Live bus positions are unavailable right now"),
  /** The feed died MID-JOURNEY. Degrading quietly reads as "nothing changed". */
  liveLost: p("ui_journey_live_lost", "Автобусны байршил тасарлаа. Цагийн хуваарь руу шилжлээ",
    "Live positions lost — switched to the timetable"),
  /** The next one after the nearest, so a missed bus has a known wait. */
  nextAfterPrefix: p("ui_journey_next_after", "Дараагийнх нь", "The one after that …"),

  // --- boarding ----------------------------------------------------------

  /** Detected, not asked. Always followed by the reversal hint. */
  boardedDetected: p("ui_journey_boarded_detected", "Автобусанд суулаа", "You have boarded"),
  /** Boarding is CONFIRMABLE AND REVERSIBLE — one gesture undoes it. */
  boardedUndoHint: p("ui_journey_boarded_undo", "Суугаагүй бол дээш шудрана уу",
    "If you did not board, swipe up"),
  boardedUndone: p("ui_journey_boarded_undone", "Дахин хүлээж байна", "Waiting again"),
  /** Always available regardless of detection. */
  boardManually: p("ui_journey_board_manually", "Би автобусанд сууж байна", "I am on the bus"),
  /** With live data we can name the actual vehicle by its plate. */
  plateNumberPrefix: p("ui_journey_plate_prefix", "Улсын дугаар", "Plate number"),

  // --- riding ------------------------------------------------------------

  /** "{stop} өнгөрлөө" — spoken on passing each stop. */
  passedSuffix: p("ui_journey_passed", "өнгөрлөө", "… has passed"),
  /** "{n} буудал үлдлээ" reuses RIDE.stopsRemaining. This is the full status. */
  statusPrefix: p("ui_journey_status", "Одоогийн байдал", "Current status"),
  /** GPS and the feed disagree. We trust GPS and say so rather than going quiet. */
  feedDisagrees: p("ui_journey_feed_disagrees", "Автобусны мэдээлэл зөрж байна. Байршлаар тоолж байна",
    "The live data disagrees — counting by GPS"),

  /** The journey is over. */
  finished: p("ui_journey_finished", "Аялал дууслаа", "Journey complete"),
  /** Resumed after the app was backgrounded — a dropped journey strands someone. */
  resumed: p("ui_journey_resumed", "Аяллаа үргэлжлүүлж байна", "Resuming your journey"),
} as const;

// --------------------------------------------------------------- registry

/** Every phrase, flattened — used by the review dump and the coverage test. */
export const ALL_PHRASES: Record<string, Phrase> = Object.fromEntries(
  Object.entries({ GESTURE, SCREEN, POSITION, MODE, WAIT, RIDE, DEGRADED, LIST, VOICE, JOURNEY }).flatMap(
    ([group, table]) => Object.entries(table).map(([key, phrase]) => [`${group}.${key}`, phrase as Phrase]),
  ),
);

/** Phrases with no rendered clip yet — the TTS backlog, computed not maintained. */
export const UNRENDERED = Object.entries(ALL_PHRASES)
  .filter(([, phrase]) => phrase.clip === null && phrase.mn.trim() !== "")
  .map(([name, phrase]) => ({ name, mn: phrase.mn, en: phrase.en }));
