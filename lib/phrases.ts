/**
 * Every phrase the app can speak. Pre-rendered to public/audio/<id>.mp3 by
 * scripts/generate-audio.ts — nothing here is synthesized at runtime.
 *
 * `id` is the mp3 filename, so keep it ASCII, lowercase and stable: changing an
 * id orphans the mp3 already on disk and silently breaks playback.
 */
export type Phrase = {
  id: string;
  /** Spoken text, Mongolian Cyrillic. */
  mn: string;
  /** Gloss for humans reading this file. Never spoken, never rendered. */
  en: string;
};

/** First batch — kept small so the voice can be judged before bulk generation. */
export const PHRASES: Phrase[] = [
  { id: "car", mn: "Машин", en: "car" },
  { id: "person", mn: "Хүн", en: "person" },
  { id: "stairs", mn: "Шат", en: "stairs" },
  { id: "pole", mn: "Шон", en: "pole" },
  { id: "stop", mn: "Зогс", en: "stop" },
];
