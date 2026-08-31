/**
 * Every phrase the app can speak. Pre-rendered to public/audio/<id>.wav by
 * scripts/generate-audio.ts — nothing here is synthesized at runtime.
 *
 * `id` is the wav filename, so keep it ASCII, lowercase and stable: changing an
 * id orphans the file already on disk and silently breaks playback.
 *
 * Chimege accepts Cyrillic letters, spaces, and ? ! . - ' " : , only. Anything
 * else is rejected by the API, so keep `mn` plain.
 */
export type PhraseKind = "object" | "distance" | "ui";

export type Phrase = {
  id: string;
  /** Spoken text, Mongolian Cyrillic. */
  mn: string;
  /** Gloss for humans reading this file. Never spoken, never rendered. */
  en: string;
  kind: PhraseKind;
};

export const PHRASES: Phrase[] = [
  // ---- Objects ----------------------------------------------------------
  // This order defines the model's class indices. See DETECTION_CLASSES, and
  // keep the Colab export's class list derived from it.

  // People and animals
  { id: "person", mn: "Хүн", en: "person", kind: "object" },
  { id: "child", mn: "Хүүхэд", en: "child", kind: "object" },
  { id: "dog", mn: "Нохой", en: "dog", kind: "object" },
  { id: "cat", mn: "Муур", en: "cat", kind: "object" },
  { id: "horse", mn: "Морь", en: "horse", kind: "object" },
  { id: "cow", mn: "Үхэр", en: "cow", kind: "object" },
  { id: "bird", mn: "Шувуу", en: "bird", kind: "object" },

  // Vehicles
  { id: "car", mn: "Машин", en: "car", kind: "object" },
  { id: "bus", mn: "Автобус", en: "bus", kind: "object" },
  { id: "truck", mn: "Ачааны машин", en: "truck", kind: "object" },
  { id: "motorcycle", mn: "Мотоцикл", en: "motorcycle", kind: "object" },
  { id: "bicycle", mn: "Дугуй", en: "bicycle", kind: "object" },
  { id: "scooter", mn: "Скутер", en: "scooter", kind: "object" },
  { id: "cart", mn: "Тэрэг", en: "cart", kind: "object" },

  // Street furniture and structures
  { id: "pole", mn: "Шон", en: "pole", kind: "object" },
  { id: "tree", mn: "Мод", en: "tree", kind: "object" },
  { id: "wall", mn: "Хана", en: "wall", kind: "object" },
  { id: "fence", mn: "Хашаа", en: "fence", kind: "object" },
  { id: "door", mn: "Хаалга", en: "door", kind: "object" },
  { id: "window", mn: "Цонх", en: "window", kind: "object" },
  { id: "stairs", mn: "Шат", en: "stairs", kind: "object" },
  { id: "bench", mn: "Сандал", en: "bench", kind: "object" },
  { id: "table", mn: "Ширээ", en: "table", kind: "object" },
  { id: "trash_can", mn: "Хогийн сав", en: "trash can", kind: "object" },
  { id: "traffic_light", mn: "Гэрлэн дохио", en: "traffic light", kind: "object" },
  { id: "sign", mn: "Тэмдэг", en: "sign", kind: "object" },
  { id: "bridge", mn: "Гүүр", en: "bridge", kind: "object" },
  { id: "curb", mn: "Хашлага", en: "curb / railing", kind: "object" },

  // Ground hazards
  { id: "hole", mn: "Нүх", en: "hole", kind: "object" },
  { id: "puddle", mn: "Шалбааг", en: "puddle", kind: "object" },
  { id: "ice", mn: "Мөс", en: "ice", kind: "object" },
  { id: "rock", mn: "Чулуу", en: "rock", kind: "object" },

  // ---- Distances --------------------------------------------------------
  // Two forms, because the distance model has two confidence levels.
  //
  // `very_close` carries NO number. It is what gets said when the ground-plane
  // estimate is unreliable — an object filling the frame, whose base is below
  // the bottom edge — and when a reliable estimate is under 1.5 m. Quoting
  // metres there would be inventing precision the geometry cannot support.
  //
  // `approx` + `m_N` is the reliable form, spoken as one sentence:
  // "Хана" + "ойролцоогоор" + "гурван метр" — wall, approximately three metres.
  // The m_N clips deliberately omit `орчим` (about); `ойролцоогоор` already
  // carries the hedge, and both together read as stammering.
  { id: "very_close", mn: "Маш ойрхон", en: "very close", kind: "distance" },
  // Lowercase, like every other clip that follows the object's name.
  { id: "approx", mn: "ойролцоогоор", en: "approximately", kind: "distance" },
  { id: "m_2", mn: "хоёр метр", en: "two metres", kind: "distance" },
  { id: "m_3", mn: "гурван метр", en: "three metres", kind: "distance" },
  { id: "m_4", mn: "дөрвөн метр", en: "four metres", kind: "distance" },
  { id: "m_5", mn: "таван метр", en: "five metres", kind: "distance" },

  // The `d_*` clips below predate the confidence signal and are no longer
  // reached by announcementFor(). Kept on disk so an older build still plays
  // something rather than nothing.
  // Spoken immediately after the object name, so they read as one sentence:
  // "Сандал" + "нэг метр орчим" = "chair, about one metre". `орчим` (about) is
  // baked into each clip — the estimate is a band, and it should sound like one.
  { id: "d_30cm", mn: "гучин сантиметр орчим", en: "about 30 cm", kind: "distance" },
  { id: "d_50cm", mn: "тавин сантиметр орчим", en: "about 50 cm", kind: "distance" },
  { id: "d_70cm", mn: "далан сантиметр орчим", en: "about 70 cm", kind: "distance" },
  { id: "d_1m", mn: "нэг метр орчим", en: "about one metre", kind: "distance" },
  { id: "d_2m", mn: "хоёр метр орчим", en: "about two metres", kind: "distance" },
  { id: "d_3m", mn: "гурван метр орчим", en: "about three metres", kind: "distance" },
  { id: "d_5m", mn: "таван метр орчим", en: "about five metres", kind: "distance" },
  { id: "d_10m", mn: "арван метр орчим", en: "about ten metres", kind: "distance" },
  { id: "d_far", mn: "хол", en: "far", kind: "distance" },

  // ---- Spoken UI --------------------------------------------------------
  // CLAUDE.md: every state change must be audible. These cover the states a
  // user who cannot see the screen would otherwise have no way to notice.
  { id: "stop", mn: "Зогс", en: "stop", kind: "ui" },
  { id: "careful", mn: "Болгоомжтой", en: "careful", kind: "ui" },
  { id: "ready", mn: "Бэлэн", en: "ready", kind: "ui" },
  { id: "error", mn: "Алдаа", en: "error", kind: "ui" },
  { id: "loading", mn: "Ачаалж байна", en: "loading", kind: "ui" },
  { id: "left", mn: "Зүүн", en: "left", kind: "ui" },
  { id: "right", mn: "Баруун", en: "right", kind: "ui" },
  { id: "ahead", mn: "Урд", en: "ahead", kind: "ui" },

  // ---- Mode menu --------------------------------------------------------
  // kind "ui", NOT "object": DETECTION_CLASSES is filtered on "object" and its
  // index IS the ONNX class id, so an entry here as an object would renumber
  // every class and silently mislabel every detection.
  //
  // Prefixed `mode_`, not `m_`: m_2..m_5 are already the spoken metre clips,
  // and one prefix meaning both "metres" and "mode" is a trap for whoever adds
  // m_6.
  { id: "mode_walk", mn: "Алхах", en: "walk", kind: "ui" },
  { id: "mode_bus", mn: "Автобус", en: "bus", kind: "ui" },
  { id: "mode_scene", mn: "Юу байна", en: "what is here", kind: "ui" },
  { id: "mode_settings", mn: "Тохиргоо", en: "settings", kind: "ui" },
  // Not on the home screen: MoneyMode is deferred, not cancelled (NOTES.md).
  // Kept because deleting it only saves 28 KB and costs a Chimege call to undo.
  { id: "mode_money", mn: "Мөнгө", en: "money", kind: "ui" },
  { id: "menu", mn: "Цэс", en: "menu", kind: "ui" },
  { id: "back", mn: "Буцах", en: "back", kind: "ui" },

  // A mode that is not built yet says this — never the error clip. "Not built"
  // and "something broke" are different facts, and a user who cannot see the
  // screen has no other way to tell them apart: the error clip would invite a
  // retry that can never succeed.
  { id: "coming_soon", mn: "Тун удахгүй", en: "coming soon", kind: "ui" },

  // ---- Degradation ------------------------------------------------------
  // CLAUDE.md: announce degradation. Both of these are states where the app is
  // quietly becoming useless, and quiet is the one thing it must never be —
  // silence reads as "nothing ahead" to someone who cannot check.
  { id: "dark", mn: "Харанхуй байна", en: "too dark to see", kind: "ui" },

  // ---- Spatial ----------------------------------------------------------
  // `clear` composes with the existing left/right/ahead clips — "Зүүн" +
  // "чөлөөтэй" — rather than needing one clip per direction.
  //
  // These describe, they do not instruct. CLAUDE.md draws that line hard: "the
  // left side is clear" is a fact the user can act on with their own judgement;
  // "go left" is the app steering a person it cannot actually see.
  { id: "clear", mn: "чөлөөтэй", en: "is clear", kind: "ui" },
  { id: "no_path", mn: "Чөлөөтэй зам алга", en: "no clear path", kind: "ui" },
  // Head height. The hazard a white cane sweeps straight under.
  { id: "overhead", mn: "Дээр саад", en: "obstacle overhead", kind: "ui" },
  // Said after the object's name: "Машин ойртож байна".
  { id: "approaching", mn: "ойртож байна", en: "approaching", kind: "ui" },

  // ---- Device state -----------------------------------------------------
  // Both describe the device, not the world — telling someone their camera is
  // aimed at the pavement is not the same as telling them where to walk.
  // Without these, a phone pointed at the ground is indistinguishable from an
  // empty street: both are silence.
  { id: "camera_down", mn: "Камер доош харж байна", en: "camera is facing down", kind: "ui" },
  { id: "slow", mn: "Удааширч байна", en: "running slow", kind: "ui" },
  { id: "battery_low", mn: "Батерей бага", en: "battery low", kind: "ui" },

  // ---- Digits -----------------------------------------------------------
  // Route numbers are spoken digit by digit: 13 -> "нэг" "гурав". Pre-rendering
  // every possible route number is impractical, and digit-by-digit is how a
  // number is read aloud anyway.
  //
  // These are the counting forms ("гурав"), not the attributive forms the
  // distance clips use ("гурван метр") — a bare digit is not modifying a noun.
  { id: "n_0", mn: "тэг", en: "0", kind: "ui" },
  { id: "n_1", mn: "нэг", en: "1", kind: "ui" },
  { id: "n_2", mn: "хоёр", en: "2", kind: "ui" },
  { id: "n_3", mn: "гурав", en: "3", kind: "ui" },
  { id: "n_4", mn: "дөрөв", en: "4", kind: "ui" },
  { id: "n_5", mn: "тав", en: "5", kind: "ui" },
  { id: "n_6", mn: "зургаа", en: "6", kind: "ui" },
  { id: "n_7", mn: "долоо", en: "7", kind: "ui" },
  { id: "n_8", mn: "найм", en: "8", kind: "ui" },
  { id: "n_9", mn: "ес", en: "9", kind: "ui" },

  // ---- Bus mode ---------------------------------------------------------
  // `bus_is` is lowercase and distinct from the `bus` obstacle clip (which is
  // capitalised and leads its own sentence): this one opens "автобус нэг гурав".
  { id: "bus_is", mn: "автобус", en: "bus is", kind: "ui" },
  { id: "unclear", mn: "Тодорхойгүй", en: "unclear", kind: "ui" },
  { id: "try_again", mn: "Дахин оролдоно уу", en: "try again", kind: "ui" },

  // ---- Gesture UI and first-run tutorial -------------------------------
  // Rendered by scripts/render-ui-audio.ts as WAV, not Opus: these are the
  // first sounds a new user ever hears, and iOS Safari decodes WAV natively
  // while its Ogg Opus support is unreliable. Short and few, so the bytes
  // are not worth a compatibility risk.

  { id: "ui_where_am_i", mn: "Та одоо энд байна:", en: "You are here:", kind: "ui" },
  { id: "ui_list_wrapped", mn: "Жагсаалтын эхэнд буцлаа.", en: "Back to the start of the list.", kind: "ui" },
  { id: "ui_no_options", mn: "Сонголт алга байна.", en: "There are no options.", kind: "ui" },
  { id: "ui_screen_home", mn: "Үндсэн цэс", en: "Main menu", kind: "ui" },
  { id: "ui_screen_wait", mn: "Автобус хүлээх", en: "Waiting for a bus", kind: "ui" },
  { id: "ui_screen_ride", mn: "Автобусанд явж байна", en: "Riding the bus", kind: "ui" },
  { id: "ui_screen_destination", mn: "Хаана буух вэ", en: "Where are you getting off", kind: "ui" },
  { id: "ui_list_recent_heading", mn: "Сүүлд явсан", en: "Recently travelled", kind: "ui" },
  { id: "ui_list_frequent_heading", mn: "Байнга явдаг", en: "Frequently travelled", kind: "ui" },
  { id: "ui_list_all_stops_heading", mn: "Бүх буудал", en: "All stops", kind: "ui" },
  { id: "ui_list_position_joiner", mn: "дахь", en: "-th", kind: "ui" },
  { id: "ui_list_position_of", mn: "-оос", en: "of", kind: "ui" },
  { id: "ui_list_jumped_five", mn: "5-р буудал", en: "5 stops on", kind: "ui" },
  { id: "ui_list_stops_after", mn: "буудлын дараа", en: "stops later", kind: "ui" },
  { id: "ui_wait_find_stop", mn: "Буудлаа олох", en: "Find my stop", kind: "ui" },
  { id: "ui_wait_locating", mn: "Байршил тодорхойлж байна", en: "Finding your location", kind: "ui" },
  { id: "ui_wait_confirm_stop", mn: "Тийм, энэ буудал", en: "Yes, this stop", kind: "ui" },
  { id: "ui_wait_other_stop", mn: "Өөр буудал", en: "A different stop", kind: "ui" },
  { id: "ui_wait_which_route", mn: "Аль чиглэлээр явах вэ?", en: "Which route are you taking?", kind: "ui" },
  { id: "ui_wait_time_unknown", mn: "хугацаа тодорхойгүй", en: "time unknown", kind: "ui" },
  { id: "ui_voice_listening", mn: "Сонсож байна", en: "Listening", kind: "ui" },
  { id: "ui_voice_confirm_suffix", mn: "руу явах уу?", en: "… are you going to?", kind: "ui" },
  { id: "ui_voice_not_understood", mn: "Ойлгосонгүй. Дахин оролдоно уу.", en: "I did not understand. Please try again.", kind: "ui" },
  { id: "ui_voice_unavailable", mn: "Дуу хоолойгоор оруулах боломжгүй байна", en: "Voice input is unavailable", kind: "ui" },
  { id: "ui_pos_top_left", mn: "зүүн дээд", en: "top left", kind: "ui" },
  { id: "ui_pos_top_right", mn: "баруун дээд", en: "top right", kind: "ui" },
  { id: "ui_pos_bottom_left", mn: "зүүн доод", en: "bottom left", kind: "ui" },
  { id: "ui_pos_bottom_right", mn: "баруун доод", en: "bottom right", kind: "ui" },
  { id: "ui_ride_manual_advance", mn: "Нэг буудал өнгөрлөө", en: "One stop has passed", kind: "ui" },
  { id: "ui_ride_finish", mn: "Дуусгах", en: "Finish", kind: "ui" },
  { id: "ui_welcome", mn: "Харааны Хандалт. Дээш доош шударч сонголтоо сонсоно уу. Хоёр удаа товшиж сонгоно уу.", en: "Vision Access. Swipe up or down to hear the options. Double-tap to choose.", kind: "ui" },
  { id: "ui_back", mn: "Буцлаа", en: "Went back", kind: "ui" },
  { id: "ui_voice_prompt", mn: "Хаашаа явах вэ? Буудлын нэрээ хэлнэ үү.", en: "Where are you going? Say the name of the stop.", kind: "ui" },
  { id: "ui_voice_did_you_say", mn: "Та ингэж хэлсэн үү:", en: "Did you say:", kind: "ui" },
  { id: "ui_voice_confirm_hint", mn: "Тийм бол хоёр удаа товшино уу. Үгүй бол дээш шудрана уу.", en: "If yes, double-tap. If no, swipe up.", kind: "ui" },
  { id: "ui_voice_no_match", mn: "Тийм нэртэй буудал олдсонгүй.", en: "No stop found with that name.", kind: "ui" },
  { id: "ui_wait_searching", mn: "Буудлыг хайж байна", en: "Looking for your stop", kind: "ui" },
  { id: "ui_wait_say_destination", mn: "Хаашаа явахаа хэлэх", en: "Say where you are going", kind: "ui" },
  { id: "ui_wait_browse_routes", mn: "Чиглэлүүдийг сонсох", en: "Hear the routes", kind: "ui" },
  // --- journey flow (destination-first). Rendered by scripts/render-ui-audio.ts.
  { id: "ui_journey_ask_destination", mn: "Хаашаа явах вэ?", en: "Where are you going?", kind: "ui" },
  { id: "ui_journey_planning", mn: "Зам хайж байна", en: "Finding a route", kind: "ui" },
  { id: "ui_journey_route_needed", mn: "хэрэгтэй", en: "… is what you need", kind: "ui" },
  { id: "ui_journey_stops_to_travel", mn: "буудал явна", en: "… stops to travel", kind: "ui" },
  { id: "ui_journey_no_route", mn: "Тэр буудал руу энэ буудлаас очих чиглэл алга байна", en: "No route from this stop reaches that stop", kind: "ui" },
  { id: "ui_journey_transfer_warning", mn: "Нэг удаа солино", en: "You will change once", kind: "ui" },
  { id: "ui_journey_transfer_at", mn: "Дараа нь", en: "Then, at …", kind: "ui" },
  { id: "ui_journey_live_stops_away", mn: "буудлын зайд", en: "… stops away", kind: "ui" },
  { id: "ui_journey_approaching", mn: "ойртож байна", en: "… is approaching", kind: "ui" },
  { id: "ui_journey_arrived", mn: "ирлээ", en: "… has arrived", kind: "ui" },
  { id: "ui_journey_estimate_only", mn: "Тооцоолсон хугацаа", en: "This is an estimate", kind: "ui" },
  { id: "ui_journey_live_unavailable", mn: "Автобусны байршил одоогоор алга байна", en: "Live bus positions are unavailable right now", kind: "ui" },
  { id: "ui_journey_live_lost", mn: "Автобусны байршил тасарлаа. Цагийн хуваарь руу шилжлээ", en: "Live positions lost — switched to the timetable", kind: "ui" },
  { id: "ui_journey_next_after", mn: "Дараагийнх нь", en: "The one after that …", kind: "ui" },
  { id: "ui_journey_boarded_detected", mn: "Автобусанд суулаа", en: "You have boarded", kind: "ui" },
  { id: "ui_journey_boarded_undo", mn: "Суугаагүй бол дээш шудрана уу", en: "If you did not board, swipe up", kind: "ui" },
  { id: "ui_journey_boarded_undone", mn: "Дахин хүлээж байна", en: "Waiting again", kind: "ui" },
  { id: "ui_journey_board_manually", mn: "Би автобусанд сууж байна", en: "I am on the bus", kind: "ui" },
  { id: "ui_journey_plate_prefix", mn: "Улсын дугаар", en: "Plate number", kind: "ui" },
  { id: "ui_journey_passed", mn: "өнгөрлөө", en: "… has passed", kind: "ui" },
  { id: "ui_journey_status", mn: "Одоогийн байдал", en: "Current status", kind: "ui" },
  { id: "ui_journey_feed_disagrees", mn: "Автобусны мэдээлэл зөрж байна. Байршлаар тоолж байна", en: "The live data disagrees — counting by GPS", kind: "ui" },
  { id: "ui_journey_finished", mn: "Аялал дууслаа", en: "Journey complete", kind: "ui" },
  { id: "ui_journey_resumed", mn: "Аяллаа үргэлжлүүлж байна", en: "Resuming your journey", kind: "ui" },
  // --- location acquisition. Rendered by scripts/render-ui-audio.ts.
  { id: "ui_wait_gps_weak", mn: "Байршил тодорхойгүй байна. Задгай газарт гарч түр хүлээнэ үү.", en: "Location is unclear. Please move into the open and wait a moment.", kind: "ui" },
  { id: "ui_wait_still_locating", mn: "Байршлыг нарийсгаж байна", en: "Narrowing down your location", kind: "ui" },
  { id: "ui_wait_approximate_stop", mn: "Магадгүй энэ буудал", en: "Possibly this stop", kind: "ui" },

  // --- spoken journey capture. Rendered by scripts/render-ui-audio.ts.
  //
  // These have to be HERE, not merely on disk: loadClips() resolves an id by
  // filtering this array, so a rendered wav that is not registered is fetched
  // by nobody and plays as silence. That is exactly how the whole voice-journey
  // flow came to be mute — the phrases existed in lib/ui/announcements.ts, the
  // flow asked for them by id, and no clip was ever loaded for any of them.
  { id: "ui_vj_ask_origin", mn: "Та одоо аль зогсоол дээр байна вэ?", en: "Which stop are you at now?", kind: "ui" },
  { id: "ui_vj_hold_to_speak", mn: "Дэлгэцийг дараад барьж байгаад ярина уу.", en: "Press and hold the screen, then speak.", kind: "ui" },
  { id: "ui_vj_which_one", mn: "Аль нь вэ?", en: "Which one?", kind: "ui" },
  { id: "ui_vj_or", mn: "эсвэл", en: "or", kind: "ui" },
  { id: "ui_vj_from", mn: "аас", en: "from … (case marker)", kind: "ui" },
  { id: "ui_vj_to", mn: "руу", en: "to … (case marker)", kind: "ui" },
  { id: "ui_vj_confirm_suffix", mn: "явах гэж байна. Зөв үү?", en: "… you are going. Is that right?", kind: "ui" },
  { id: "ui_vj_board_route", mn: "Та дугаар", en: "Take number …", kind: "ui" },
  { id: "ui_vj_board_route_suffix", mn: "автобусанд сууна", en: "… bus", kind: "ui" },
  { id: "ui_vj_same_stop", mn: "Та аль хэдийн тэнд байна", en: "You are already there", kind: "ui" },
  { id: "ui_vj_wrong_direction", mn: "Эсрэг чиглэлд байна. Солих уу?", en: "That is the opposite direction. Swap them?", kind: "ui" },
  { id: "ui_vj_mic_denied", mn: "Микрофон ашиглах зөвшөөрөл алга байна", en: "No microphone permission", kind: "ui" },
  { id: "ui_vj_use_list_instead", mn: "Жагсаалтаас сонгоно уу", en: "Choose from the list instead", kind: "ui" },
];

/** Model class order. An index into this IS the classId in the ONNX export. */
export const DETECTION_CLASSES = PHRASES.filter((p) => p.kind === "object").map((p) => p.id);
