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
];

/** Model class order. An index into this IS the classId in the ONNX export. */
export const DETECTION_CLASSES = PHRASES.filter((p) => p.kind === "object").map((p) => p.id);
