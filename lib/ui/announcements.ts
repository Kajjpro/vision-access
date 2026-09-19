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

  /**
   * WEAK SIGNAL IS NOT THE SAME AS NO STOP, and the two must never share a
   * phrase. "No stop nearby" sends someone walking to find one; a bad fix means
   * standing still under open sky is the right move. Telling a blind user to
   * walk when the real problem is a roof wastes the one action they might take.
   */
  gpsWeak: p("ui_wait_gps_weak", "Байршил тодорхойгүй байна. Задгай газарт гарч түр хүлээнэ үү.",
    "Location is unclear. Please move into the open and wait a moment."),
  /** Spoken while a fix is still converging, so the wait is never silent. */
  stillLocating: p("ui_wait_still_locating", "Байршлыг нарийсгаж байна", "Narrowing down your location"),
  /**
   * The stop is a best guess, not a statement. Paired with the SAME hedge the
   * arrival times use, so "approximately" means one consistent thing to the user
   * wherever they hear it.
   */
  approximateStop: p("ui_wait_approximate_stop", "Магадгүй энэ буудал", "Possibly this stop"),

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

// -------------------------------------------------- journey confirmations
//
// THE TWO QUESTIONS THE APP CANNOT ANSWER FOR ITSELF.
//
// There is no live vehicle feed (docs/city-gateway.md), so nothing here can see
// a bus arrive, see a door open, or see anyone step through it. The old flow
// resolved that by ASSUMING: the wait screen wrote a handoff and the ride screen
// started counting stops from it, whether or not the rider was on anything.
//
// These ask instead. An answer from the person standing there is better evidence
// than the feed would have been, and it is the only evidence that exists.
//
// Rendered through the WAV pipeline (`ui_`), not the transit manifest, for the
// same reason the welcome is: iOS Safari decodes WAV natively and these are the
// two sentences a journey cannot proceed without.

export const CONFIRM = {
  /** Asked once the bus is due and again while the question stands unanswered. */
  boardedQuestion: p("ui_confirm_boarded_q", "Автобусанд суусан уу?", "Did you board the bus?"),
  boardedYes: p("ui_confirm_boarded_yes", "Тийм, суусан", "Yes, I boarded"),
  boardedNo: p("ui_confirm_boarded_no", "Үгүй, суугаагүй", "No, I did not board"),
  /**
   * The third answer, and the one that makes the other two honest.
   *
   * Forcing a yes/no on someone who genuinely cannot tell produces a guess, and
   * a guessed yes starts a stop countdown for a bus nobody is on. Offering "I
   * do not know" is what lets the app resolve toward safety instead of toward
   * whichever button was easier to reach.
   */
  notSure: p("ui_confirm_not_sure", "Мэдэхгүй байна", "I am not sure"),
  /**
   * Said before the alternatives, whenever an answer was no or unsure.
   *
   * A missed bus must never sound like something the rider did wrong. They are
   * standing exactly where they should be; what failed, if anything, was a
   * timetable.
   */
  stillHelping: p("ui_confirm_still_helping", "Зүгээр. Би тусалсаар байна.",
    "That is okay. I am still helping you."),
  /**
   * Asked when the estimate has been and gone with no answer.
   *
   * The app knows only that a printed time has passed — NOT that a bus came,
   * and not that it did not. So it reports exactly that and asks.
   */
  expectedNow: p("ui_confirm_expected_now", "Автобус ирэх цаг болсон.",
    "The bus was expected around now."),

  /**
   * A missed bus is a normal event at a bus stop and is never phrased as a
   * failure. The rider hears what happens next, not what went wrong.
   */
  waitForNext: p("ui_confirm_wait_next", "Дараагийн автобусыг хүлээх", "Wait for the next bus"),
  waitingForNext: p("ui_confirm_waiting_next", "Дараагийн автобусыг хүлээж байна",
    "Waiting for the next bus"),
  findAnotherRoute: p("ui_confirm_find_other", "Өөр чиглэл хайх", "Find another route"),

  exitedQuestion: p("ui_confirm_exited_q", "Автобуснаас буусан уу?", "Have you got off the bus?"),
  exitedYes: p("ui_confirm_exited_yes", "Тийм, буусан", "Yes, I got off"),
  notYet: p("ui_confirm_not_yet", "Хараахан үгүй", "Not yet"),
} as const;

// ------------------------------------------------------ proactive guidance
//
// What the guide says when nothing has changed.
//
// CLAUDE.md's rule that audio is not a progress bar and the requirement that the
// app never fall unexplainably silent are both true, and they only look opposed
// if reassurance has to be a sentence. It does not: at the default guidance
// level the heartbeat is an earcon and a haptic, which proves the app is alive
// without masking the traffic the rider is listening to. These strings are for
// `detailed`, where the rider has asked for words.

// ------------------------------------------------------------ ask the room
//
// The vocabulary of a spoken answer about the space in front of the user.
//
// SLOTS, NOT SENTENCES. Every Tier 1 answer is object · hedge · direction ·
// distance, assembled in that fixed order — a user who has heard the shape a
// dozen times stops parsing and hears only the slot that changed.
//
// Two of the four slots already existed and are REUSED rather than re-rendered:
// the object name is the detector's own class clip (`door` → "Хаалга") and the
// distance is `approx` + `m_2`…`m_5`, which already carry the attributive
// numerals correctly ("гурван метр", not "гурав метр"). Only the direction
// words, the hedges and the failure phrases are new.
//
// Metre clips exist for 2 to 5 only. That is the entire range this app can speak
// a distance for, and `distancePhrase` enforces it — outside that range the
// answer keeps the direction and drops the number rather than rounding into a
// figure nobody measured.

/**
 * NOTE THE `ui_` PREFIX. It is not decoration — two consumers filter on it:
 * `scripts/render-ui-audio.ts` renders only `ui_*` through the WAV pipeline, and
 * `ManifestClipPlayer`'s default key set loads only `ui_*`. A clip id without it
 * is never rendered and never loaded, and the failure is silent in both places.
 */
export const ASK = {
  /** Reused: the same hedge the transit countdown uses, so it means one thing. */
  approx: p("approx", "ойролцоогоор", "approximately"),

  dirAhead: p("ui_ask_dir_ahead", "Урд талд", "ahead"),
  dirSlightLeft: p("ui_ask_dir_slight_left", "Бага зэрэг зүүн талд", "slightly to your left"),
  dirSlightRight: p("ui_ask_dir_slight_right", "Бага зэрэг баруун талд", "slightly to your right"),
  dirLeft: p("ui_ask_dir_left", "Зүүн талд", "to your left"),
  dirRight: p("ui_ask_dir_right", "Баруун талд", "to your right"),
  /**
   * NEVER "behind you". The camera cannot see behind it, and a rider turning to
   * face something the app never saw is a failure with no recovery.
   */
  notInView: p("ui_ask_not_in_view", "Харагдахгүй байна", "not in view"),

  /** Confidence as register. The numbers are never spoken. */
  maybe: p("ui_ask_maybe", "байх шиг байна", "I think there is"),
  uncertain: p("ui_ask_uncertain", "магадгүй, гэхдээ итгэлгүй байна", "possibly, but I am not certain"),

  /**
   * The honest decline. Said whenever the need was served by a class other than
   * the one asked for — a bench answering a request for a chair.
   */
  cannotRecognise: p("ui_ask_cannot_recognise", "Би үүнийг найдвартай таньж чадахгүй",
    "I cannot reliably recognise that"),
  notFound: p("ui_ask_not_found", "Одоогоор харагдахгүй байна", "I cannot see that right now"),
  /** One instruction at a time. Never a stream of them. */
  scanSlowly: p("ui_ask_scan_slowly", "Утсаа аажим эргүүлж үзнэ үү", "Turn your phone slowly"),
  noneVisible: p("ui_ask_none_visible", "Юу ч харагдахгүй байна", "I cannot see anything"),

  /**
   * The path answer, and it never says yes.
   *
   * "No obstacle was DETECTED" is a statement about the camera. "The path is
   * clear" is a statement about the world, and this system is not entitled to
   * make it. The mobility-aid clause is part of the answer, not a setting.
   */
  nothingAhead: p("ui_ask_nothing_ahead", "Урд талд саад илрээгүй", "No obstacle detected ahead"),
  useCane: p("ui_ask_use_cane", "Таягаа үргэлжлүүлэн хэрэглээрэй", "Please keep using your cane"),

  tooDark: p("ui_ask_too_dark", "Гэрэл багатай тул найдвартай таних боломжгүй",
    "It is too dark for me to identify things reliably"),
  cameraBlocked: p("ui_ask_camera_blocked", "Камер халхлагдсан байж магадгүй",
    "The camera may be covered"),
  noNetwork: p("ui_ask_no_network", "Сүлжээгүй тул үүнийг шинжлэх боломжгүй",
    "I cannot analyse this without a connection"),

  /** Four words. A clarifying question is not the place for an explanation. */
  whatToFind: p("ui_ask_what_to_find", "Юуг олох вэ?", "What should I look for?"),
  /** Availability is never asserted. Sitting on someone is the failure. */
  cannotTellFree: p("ui_ask_cannot_tell_free", "Сул эсэхийг найдвартай хэлж чадахгүй",
    "I cannot reliably tell whether it is free"),
} as const;

// ------------------------------------------------- estimate versus sighting
//
// THE MOST IMPORTANT DISTINCTION IN THE WAITING HALF OF THE APP.
//
// "The bus is arriving" asserts that a vehicle was observed. "The timetable says
// a bus is due" asserts only that a schedule exists. A rider steps off a kerb
// into traffic on the strength of the first one, and we have never observed a
// vehicle — the City feed has never opened (docs/city-gateway.md).
//
// So `estimatePrefix` leads every spoken time, and `noLivePosition` is said
// whenever the rider asks about the bus directly. `ойролцоогоор` hedges the
// NUMBER; these hedge the CLAIM, and the two are not interchangeable: "in
// approximately four minutes" still sounds like something is being watched.
//
// If a live feed ever opens, `evidenceFor` in lib/journey/types.ts is the single
// switch, and these clips simply stop being selected.

export const TIMETABLE = {
  estimatePrefix: p("ui_timetable_prefix", "Цагийн хуваарийн мэдээллээр.",
    "According to the timetable."),
  noLivePosition: p("ui_timetable_no_live", "Автобусны яг байршлыг одоогоор баталгаажуулах боломжгүй.",
    "I cannot currently confirm the bus's exact position."),
} as const;

// ------------------------------------------------------- the quick assistant
//
// One action during a journey, whose CONTENTS change with the state. Not a
// chatbot: a fixed, readable list of the questions that are answerable right
// now, so a rider learns the same few phrases instead of composing sentences at
// a bus stop. Every one of them is answered by lib/journey/guide.ts from the
// journey object.

export const ASSIST = {
  ask: p("ui_assist_ask", "Асуух", "Ask VisionAccess"),
  whatIsHappening: p("ui_assist_what_happening", "Юу болж байна?", "What is happening?"),
  whenIsBus: p("ui_assist_when_bus", "Автобус хэзээ ирэх вэ?", "When is the bus expected?"),
  howManyStops: p("ui_assist_how_many_stops", "Хэдэн буудал үлдсэн бэ?", "How many stops remain?"),
  howLong: p("ui_assist_how_long", "Хэр удах вэ?", "How long until I arrive?"),
  nextStop: p("ui_assist_next_stop", "Дараагийн буудал юу вэ?", "What is the next stop?"),
  whatShouldIDo: p("ui_assist_what_do", "Би юу хийх вэ?", "What should I do?"),
  repeatLast: p("ui_assist_repeat", "Сүүлийн мэдээллийг давтах", "Repeat the last update"),
  atTheStop: p("ui_assist_at_stop", "Би буудал дээр байна", "I am at the stop"),
  stopGuidance: p("ui_assist_stop_guidance", "Хөтөчийг зогсоох", "Stop guidance"),
} as const;

// ----------------------------------------------------------------- settings

export const SETTINGS = {
  guidanceLevel: p("ui_settings_guidance_level", "Мэдээллийн хэмжээ", "Guidance level"),
  minimal: p("ui_settings_minimal", "Хамгийн бага", "Minimal"),
  standard: p("ui_settings_standard", "Энгийн", "Standard"),
  detailed: p("ui_settings_detailed", "Дэлгэрэнгүй", "Detailed"),
  /** The non-verbal heartbeat, switchable independently of the level. */
  heartbeatOn: p("ui_settings_heartbeat_on", "Идэвхтэй дохио асаах", "Turn the activity signal on"),
  heartbeatOff: p("ui_settings_heartbeat_off", "Идэвхтэй дохио унтраах", "Turn the activity signal off"),
  saved: p("ui_settings_saved", "Хадгаллаа", "Saved"),
} as const;

export const GUIDE = {
  stillActive: p("ui_guide_still_active", "Хөтөч ажиллаж байна", "Guidance is still running"),
  walkingToStop: p("ui_guide_walking_to_stop", "Буудал руу явж байна", "Walking to the stop"),
  stopNear: p("ui_guide_stop_near", "Буудал ойрхон байна", "The stop is near"),
  reachedStop: p("ui_guide_reached_stop", "Буудалд ирлээ", "You have reached the stop"),
  journeyComplete: p("ui_guide_journey_complete", "Аялал дууслаа", "The journey is complete"),
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

// ------------------------------------------------------- voice journey
// Spoken destination capture: "say where you are, say where you are going".
// These are the fragments `lib/speech/announcements.ts` splices into carrier
// sentences around stop and route names, so each must end FLAT — a phrase that
// falls like the end of a sentence makes the stop name after it sound like a
// new one.
//
// Only the phrases with no existing equivalent live here. Everything the app
// already says — "Хаашаа явах вэ?", "Сонсож байна", "Ойлгосонгүй" — is reused
// from the tables above rather than rendered twice in two voices.

export const VOICE_JOURNEY = {
  /** Origin, asked first. The destination question already exists as JOURNEY.askDestination. */
  askOrigin: p("ui_vj_ask_origin", "Та одоо аль зогсоол дээр байна вэ?",
    "Which stop are you at now?"),
  /** Push-to-talk is not discoverable. It has to be said, every time. */
  holdToSpeak: p("ui_vj_hold_to_speak", "Дэлгэцийг дараад барьж байгаад ярина уу.",
    "Press and hold the screen, then speak."),

  // --- disambiguation ----------------------------------------------------
  /** Asking costs three seconds; guessing costs the trip. */
  whichOne: p("ui_vj_which_one", "Аль нь вэ?", "Which one?"),
  or: p("ui_vj_or", "эсвэл", "or"),

  // --- confirmation ------------------------------------------------------
  // "Та {origin}-аас {dest} руу явах гэж байна. Зөв үү?" — assembled around
  // two stop clips. NOTHING commits until this is answered with a double-tap.
  from: p("ui_vj_from", "аас", "from … (case marker)"),
  to: p("ui_vj_to", "руу", "to … (case marker)"),
  confirmSuffix: p("ui_vj_confirm_suffix", "явах гэж байна. Зөв үү?",
    "… you are going. Is that right?"),

  // --- the answer --------------------------------------------------------
  boardRoute: p("ui_vj_board_route", "Та дугаар", "Take number …"),
  boardRouteSuffix: p("ui_vj_board_route_suffix", "автобусанд сууна",
    "… bus"),

  // --- refusals ----------------------------------------------------------
  sameStop: p("ui_vj_same_stop", "Та аль хэдийн тэнд байна", "You are already there"),
  /**
   * The rider named the two stops the other way round. Worth saying out loud:
   * a flat "no route" would send someone looking for a bus that is standing
   * right in front of them, in the other direction.
   */
  wrongDirection: p("ui_vj_wrong_direction", "Эсрэг чиглэлд байна. Солих уу?",
    "That is the opposite direction. Swap them?"),

  // --- falling back ------------------------------------------------------
  /** Permission, not signal. The remedy is different and so is the sentence. */
  micDenied: p("ui_vj_mic_denied", "Микрофон ашиглах зөвшөөрөл алга байна",
    "No microphone permission"),
  /** Voice is never the only path. This is how the rider is told so. */
  useListInstead: p("ui_vj_use_list_instead", "Жагсаалтаас сонгоно уу",
    "Choose from the list instead"),
} as const;

// --------------------------------------------------------------- registry

/** Every phrase, flattened — used by the review dump and the coverage test. */
export const ALL_PHRASES: Record<string, Phrase> = Object.fromEntries(
  Object.entries({
    GESTURE, SCREEN, POSITION, MODE, WAIT, RIDE, CONFIRM, TIMETABLE, ASSIST, SETTINGS, GUIDE,
    ASK, DEGRADED, LIST, VOICE, JOURNEY, VOICE_JOURNEY,
  }).flatMap(
    ([group, table]) => Object.entries(table).map(([key, phrase]) => [`${group}.${key}`, phrase as Phrase]),
  ),
);

/** Phrases with no rendered clip yet — the TTS backlog, computed not maintained. */
export const UNRENDERED = Object.entries(ALL_PHRASES)
  .filter(([, phrase]) => phrase.clip === null && phrase.mn.trim() !== "")
  .map(([name, phrase]) => ({ name, mn: phrase.mn, en: phrase.en }));
