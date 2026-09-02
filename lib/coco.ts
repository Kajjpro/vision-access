/**
 * The COCO detection vocabulary, and the map from it to what this app speaks.
 *
 * WHY THIS FILE EXISTS — the measurement is already in phrases.ts:31-46.
 *
 *   bus 0.95   person 0.94   dog 0.49        <- COCO-trained
 *   trash_can 0.14   tree 0.04   fence 0.03   door 0.02   pole <0.02
 *
 * The old detector was YOLOE with a Mongolian obstacle vocabulary baked in as
 * CLIP text embeddings. That makes every class LOOK available, and the split
 * above is exact: a class YOLO was actually TRAINED on detects strongly, and a
 * class that exists only as a text prompt sits at noise forever. phrases.ts
 * ends that note with "That needs a retrained model, not a tweak." This is the
 * retrained model — an ordinary supervised COCO detector, where every class
 * shipped has tens of thousands of human-drawn boxes behind it.
 *
 * WHAT WAS LOST, and why it costs nothing. pole, tree, wall, fence, door,
 * stairs, trash_can, curb, scaffolding, cable, hole, ice and rock are not in
 * COCO, so they are gone. They were also scoring 0.02-0.14 against a threshold
 * of 0.30, which means they never fired. Removing thirteen classes that never
 * produced a detection changes nothing the user could hear, and removes
 * thirteen things the detector could be wrong about.
 *
 * Getting them BACK is a data problem, not a threshold problem: either a
 * checkpoint trained on a vocabulary that contains them (Objects365 has street
 * lights and trash bins; LVIS has poles) or a few thousand hand-labelled UB
 * street photos. Neither is a change to this file.
 */

import { DETECTION_CLASSES } from "./phrases";

/**
 * The 80 COCO classes IN INDEX ORDER. This is the order every stock ultralytics
 * export uses, so the position in this array IS the ONNX class id.
 *
 * NEVER reorder, filter or "tidy" this list. It is not a list of things the app
 * cares about — it is the model's own index, and editing it renames every
 * detection to something else. Curation happens in COCO_TO_PHRASE below.
 */
export const COCO_CLASSES: readonly string[] = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
  "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
  "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
  "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
  "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
  "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
  "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
  "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
  "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
  "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
  "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
  "hair drier", "toothbrush",
];

/**
 * COCO class -> the phrase id this app speaks. Anything absent is not announced.
 *
 * This is the whole curation policy, and it is deliberately short. phrases.ts
 * sets the rule: a class earns its place by being something that can INJURE
 * this user, not by being something the camera can name — because CLAUDE.md
 * allows one spoken warning per 1.5 seconds, so a correctly-detected teddy bear
 * is a car that went unsaid.
 *
 * Every value here already has a .wav in public/audio. That is a constraint,
 * not a coincidence: a mapping to an id with no clip is silence with extra
 * steps.
 */
export const COCO_TO_PHRASE: Readonly<Record<string, string>> = {
  // People and animals. Street dogs are common in UB and do not step aside for
  // someone who cannot make eye contact with them.
  person: "person",
  dog: "dog",
  cat: "cat",
  horse: "horse",
  cow: "cow",

  // Vehicles — the only things on this list that can kill.
  car: "car",
  bus: "bus",
  truck: "truck",
  motorcycle: "motorcycle",
  bicycle: "bicycle",

  // Seating. BOTH map to the same clip, and that is correct rather than lazy:
  // "Сандал" is Mongolian for chair, the warning a user acts on is identical
  // ("waist-height hard edge, right there"), and chair is COCO's single most
  // common indoor obstacle — which matters because indoors is where this app
  // is inevitably tested first.
  bench: "bench",
  chair: "bench",

  // Waist height, hard edges, invisible to a cane sweeping below it.
  "dining table": "table",

  // DELIBERATELY ABSENT, so nobody adds them back without reading this:
  //
  //   traffic light, stop sign — CLAUDE.md forbids this app from speaking to
  //     traffic signals at all. Naming one invites exactly the reading the rule
  //     exists to prevent: "it saw the light, so it must be telling me to
  //     cross". This is a safety rule, not a curation preference.
  //   train, airplane, boat — not obstacles on a pavement.
  //   bird, sheep, elephant, bear, zebra, giraffe — cannot injure a pedestrian.
  //     (sheep is the arguable one in Mongolia; it needs a clip first.)
  //   fire hydrant, parking meter, potted plant, suitcase, backpack — genuine
  //     knee- and floor-height hazards, and the best candidates for the next
  //     pass. Each needs a Mongolian clip generated before it can be mapped.
  //   everything else — kitchenware, sports equipment, electronics. Chatter.
};

/** Phrase ids the app already has audio for. Guards the map above at import. */
const SPEAKABLE = new Set(DETECTION_CLASSES);

/**
 * Model vocabulary -> app vocabulary, or null for "do not announce this".
 *
 * Accepts a name from EITHER side, so the legacy YOLOE exports (whose class
 * names already are phrase ids) keep working through the same call. A model
 * still on disk should not start announcing nothing because the vocabulary
 * moved on.
 */
export function phraseIdFor(className: string): string | null {
  if (SPEAKABLE.has(className)) return className;
  const mapped = COCO_TO_PHRASE[className];
  return mapped && SPEAKABLE.has(mapped) ? mapped : null;
}

/**
 * Minimum detector score before this class's NAME may be spoken.
 *
 * Separate from, and above, the worker's flat CONFIDENCE_THRESHOLD. That one
 * asks "is something there" and feeds the proximity tone and the distance,
 * which are the safety-critical half and should stay sensitive. This one asks
 * "am I sure WHAT it is", and it only ever costs the user a name — the warning
 * still fires, still with its distance.
 *
 * The values are the measured peaks in phrases.ts, discounted for how much a
 * wrong name would cost. A class that is easy to confuse for another obstacle
 * (table/bench/chair are one silhouette at range) has to clear a higher bar
 * than a person, where the name is both reliable and the most useful word the
 * app can say.
 */
export const NAME_MIN_SCORE: Readonly<Record<string, number>> = {
  person: 0.35,
  car: 0.35,
  bus: 0.35,
  truck: 0.45, // Routinely a large car, and vice versa.
  motorcycle: 0.45,
  bicycle: 0.45,
  dog: 0.45,
  cat: 0.5,
  horse: 0.5,
  cow: 0.5,
  bench: 0.5, // Also fed by COCO `chair`; one silhouette at range.
  table: 0.5,
};

/** Fallback for a class with no entry above. */
export const DEFAULT_NAME_MIN_SCORE = 0.45;

export function nameMinScore(phraseId: string): number {
  return NAME_MIN_SCORE[phraseId] ?? DEFAULT_NAME_MIN_SCORE;
}
