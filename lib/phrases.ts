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
  //
  // WHAT THE MODEL CAN ACTUALLY SEE — measured, and the first thing to know.
  //
  // THIS LIST IS NO LONGER THE MODEL'S VOCABULARY. lib/coco.ts is. The
  // detector was YOLOE with these 25 classes baked in as CLIP text embeddings,
  // which made every class here look equally available. They were not:
  //
  //   bus 0.95   person 0.94   dog 0.49        <- all COCO-native
  //   trash_can 0.14   tree 0.04   fence 0.03   door 0.02   pole <0.02
  //
  // The split was exact. Classes YOLO was TRAINED on detected strongly;
  // classes that existed only as a text prompt sat at noise and never cleared
  // the 0.30 threshold. That note used to end "needs a retrained model, not a
  // tweak" — and that is what happened. The app now runs a stock COCO-80
  // detector, so the twelve reachable ids are:
  //
  //   person, dog, cat, horse, cow, car, bus, truck, motorcycle, bicycle,
  //   bench (also fed by COCO `chair`), table
  //
  // The other thirteen — pole, tree, wall, fence, door, stairs, trash_can,
  // curb, scaffolding, cable, hole, ice, rock — are UNREACHABLE today. They
  // are kept, with their wavs, for two reasons: an older export still cached
  // on a phone names its classes with these ids and must keep working, and the
  // moment a vocabulary containing them exists they cost nothing to re-enable.
  //
  // Adding a class here does NOT make the detector find it. The mapping in
  // lib/coco.ts is what decides, and it can only map what COCO contains.
  // Winning back a pole or a kerb is a data problem — an Objects365 or LVIS
  // checkpoint, or hand-labelled UB street photos — not an entry in this list.
  //
  // CURATION POLICY — read before adding a class back.
  //
  // A class earns its place by being something that can injure this user, not
  // by being something the camera can name. Three costs are paid per class,
  // and only the first is obvious:
  //
  //   1. Another wav fetched before the app can speak at all. The startup set
  //      is downloaded in full on a phone over mobile data.
  //   2. Another channel in the ONNX head, and one more thing the detector can
  //      be wrong about.
  //   3. A share of the announcement budget. CLAUDE.md allows ONE spoken
  //      warning per 1.5 seconds. Every class competes for that slot, so a
  //      correctly-detected bird is not free — it is a car that went unsaid.
  //
  // (3) is why this list is short. The previous 60-entry vocabulary was a list
  // of things findable on a street; this is a list of things worth interrupting
  // someone for. When in doubt leave it out: CLAUDE.md is explicit that silence
  // is the correct output under uncertainty, and a missing warning costs
  // nothing next to a false one.

  // People and animals. Street dogs are common in UB and do not step aside for
  // someone who cannot make eye contact with them.
  //
  // `child` is deliberately gone: it is a second word for an identical warning,
  // and person-vs-child is a distinction the user cannot act on differently.
  // cat, bird, sheep, goat, horse and cow are gone because none of them can
  // injure a pedestrian, and any one of them could spend the single
  // announcement available per 1.5s that a car needed.
  { id: "person", mn: "Хүн", en: "person", kind: "object" },
  { id: "dog", mn: "Нохой", en: "dog", kind: "object" },
  // Restored after measurement. These were cut as "cannot injure a
  // pedestrian", which is true and was the wrong test to apply alone: they are
  // COCO-native, so they are among the few classes this model can actually
  // FIND, and cutting them left the app with almost nothing to report but
  // people. A cat underfoot is also a genuine trip hazard, and livestock on
  // the road is an ordinary sight outside central UB.
  { id: "cat", mn: "Муур", en: "cat", kind: "object" },
  { id: "horse", mn: "Морь", en: "horse", kind: "object" },
  { id: "cow", mn: "Үхэр", en: "cow", kind: "object" },

  // Vehicles. The only things on this list that can kill, so they are the last
  // classes that would ever be cut.
  //
  // scooter, kick_scooter, cart, stroller and wheelchair are dropped: they are
  // rarer, they are visually confusable with bicycle/motorcycle, and the
  // warning a user acts on is the same either way — something is coming.
  { id: "car", mn: "Машин", en: "car", kind: "object" },
  { id: "bus", mn: "Автобус", en: "bus", kind: "object" },
  { id: "truck", mn: "Ачааны машин", en: "truck", kind: "object" },
  { id: "motorcycle", mn: "Мотоцикл", en: "motorcycle", kind: "object" },
  { id: "bicycle", mn: "Дугуй", en: "bicycle", kind: "object" },

  // Street furniture and structures. Body-height collisions: a cane finds the
  // base of a pole about a step before a shoulder finds the rest of it, and
  // stairs are where a stumble becomes an injury.
  //
  // The long tail is gone — bollard, fire_hydrant, planter, kiosk, awning,
  // bus_stop, barrier, boxes, luggage, dumpster, hedge, ladder, step, table,
  // window, glass_door. Each was a plausible obstacle and a near-certain source
  // of chatter, and `wall` already covers "a flat thing is in front of you".
  //
  // `sign` and `bridge` are dropped as too frequent and not collidable
  // respectively. `traffic_light` is dropped on purpose and not for size:
  // CLAUDE.md forbids this app from speaking to traffic signals at all, and
  // naming one out loud invites precisely the reading — "it saw the light, so
  // it must be telling me to cross" — that the rule exists to prevent.
  { id: "pole", mn: "Шон", en: "pole", kind: "object" },
  { id: "tree", mn: "Мод", en: "tree", kind: "object" },
  { id: "wall", mn: "Хана", en: "wall", kind: "object" },
  { id: "fence", mn: "Хашаа", en: "fence", kind: "object" },
  { id: "door", mn: "Хаалга", en: "door", kind: "object" },
  { id: "stairs", mn: "Шат", en: "stairs", kind: "object" },
  { id: "bench", mn: "Сандал", en: "bench", kind: "object" },
  // Restored for the same reason as the animals above, and it earns its place
  // twice over: COCO-native (so actually detectable), and the one class on
  // this whole list that appears INDOORS, where the app is inevitably tested
  // first. Waist height, hard edges, invisible to a cane sweeping below it.
  { id: "table", mn: "Ширээ", en: "table", kind: "object" },
  { id: "trash_can", mn: "Хогийн сав", en: "trash can", kind: "object" },
  { id: "curb", mn: "Хашлага", en: "curb / railing", kind: "object" },

  // Overhead hazards — above head height, no ground contact. See lib/path.ts
  // isOverhead(): this is the case a white cane sweeps straight under.
  // These two survive a cut aimed at everything non-essential precisely
  // because they are the class of hazard the cane cannot report. `umbrella` is
  // dropped: it is the one overhead object that is usually attached to a
  // person who is already being detected.
  { id: "scaffolding", mn: "Барилгын шат", en: "scaffolding", kind: "object" },
  { id: "cable", mn: "Утас", en: "low-hanging cable", kind: "object" },

  // Ground hazards. `hole` covers the open manhole case, which in UB is a real
  // fall and not a theoretical one, so manhole is redundant rather than absent.
  //
  // `ice` stays where `puddle` and `snow_pile` go: standing water is a wet
  // shoe, ice is a fractured wrist, and Mongolia is frozen for a third of the
  // year. crosswalk, speed_bump and ramp are road MARKINGS — flat, unhittable,
  // and describing them edges toward telling someone where to cross.
  { id: "hole", mn: "Нүх", en: "hole", kind: "object" },
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
];

/** Model class order. An index into this IS the classId in the ONNX export. */
export const DETECTION_CLASSES = PHRASES.filter((p) => p.kind === "object").map((p) => p.id);
