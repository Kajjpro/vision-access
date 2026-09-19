/**
 * Journey → what the screen shows. Pure, so the redesign is testable.
 *
 * ── WHY THE UI MODEL IS A FUNCTION ─────────────────────────────────────────
 *
 * The complaint that started this was that the interface felt disconnected, and
 * the cause was structural rather than visual: three screens each decided their
 * own title, their own option list and their own actions from their own local
 * `phase`, so "what is the app showing right now" had no answer outside a
 * running browser. Nothing about the layout could be asserted, and the spoken
 * options and the on-screen ones drifted apart because they were built in
 * different places.
 *
 * Everything below derives from ONE journey object. One primary action per
 * state, chosen here; the spoken option list comes from `guide.options`, which
 * this reuses rather than re-deriving, so the screen and the voice cannot
 * disagree about what is on offer.
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 *
 * It returns no colours, no icons and no layout. The interaction model this app
 * chose is a full-viewport gesture surface — swipe to hear options, double-tap
 * to select, long-press for "where am I" — because finding a button on flat
 * glass is exactly the assumption it cannot make. So "large buttons, high
 * contrast" is satisfied by there being ONE target the size of the screen, and
 * the real accessibility work is that every option here is also a focusable
 * element for VoiceOver and a keyboard, which `GestureSurface` renders from
 * `options`.
 */

import { options as guideOptions } from "./guide";
import type { Journey, JourneyState } from "./types";

/**
 * The journey, as a progress bar the rider can hear.
 *
 * Six steps, matching what a person would describe if asked where they were in
 * a bus trip. The question states do NOT get their own step: being asked
 * whether you boarded is not progress, it is the same step waiting on an
 * answer, and inflating it to a step would make the progress readout jump
 * forward for something the rider has not done yet.
 */
export const PROGRESS_STEPS = [
  "destination",
  "walking",
  "waiting",
  "on_bus",
  "arriving",
  "arrived",
] as const;

export type ProgressStep = (typeof PROGRESS_STEPS)[number];

const STEP_OF: Record<JourneyState, ProgressStep | null> = {
  idle: null,
  selecting_destination: "destination",
  analyzing_route: "destination",
  route_selected: "destination",
  walking_to_stop: "walking",
  waiting_for_bus: "waiting",
  bus_due: "waiting",
  confirming_boarding: "waiting",
  on_bus: "on_bus",
  approaching_destination: "arriving",
  confirming_exit: "arriving",
  arrived: "arrived",
  // A fault does not move the marker. The rider is still exactly where they
  // were; what changed is that we can no longer help them from there.
  journey_error: null,
};

export type Progress = {
  step: ProgressStep | null;
  /** 1-based, for "step 3 of 6". Null while there is no journey to be in. */
  index: number | null;
  total: number;
  /**
   * What a screen reader says. Built here rather than in the component so it is
   * asserted by a test instead of by looking at a phone.
   */
  label: string;
};

const STEP_LABEL: Record<ProgressStep, string> = {
  destination: "Чиглэл сонгож байна",
  walking: "Буудал руу явж байна",
  waiting: "Автобус хүлээж байна",
  on_bus: "Автобусанд явж байна",
  arriving: "Буудалдаа ойртож байна",
  arrived: "Хүрлээ",
};

export function progressOf(journey: Journey): Progress {
  const step = STEP_OF[journey.state];
  const index = step ? PROGRESS_STEPS.indexOf(step) + 1 : null;
  return {
    step,
    index,
    total: PROGRESS_STEPS.length,
    label:
      step && index
        ? `${STEP_LABEL[step]}. ${index} / ${PROGRESS_STEPS.length}`
        : STEP_LABEL.destination,
  };
}

/**
 * The one thing the screen is for, right now.
 *
 * `headline` is the state. `detail` is the single most useful fact in it —
 * never a second sentence, because the top of the screen is also the first
 * thing VoiceOver reads and a rider re-entering the app wants the answer, not a
 * paragraph.
 */
export type Presentation = {
  headline: string;
  detail: string | null;
  progress: Progress;
  /**
   * The actions offered, in the order they are spoken. Empty is a valid and
   * common answer: while a bus is simply on its way there is nothing to decide,
   * and offering choices anyway is how an interface becomes a menu to get past
   * rather than a guide.
   */
  actions: { id: string; keys: string[]; label: string }[];
  /**
   * True while the journey is blocked on the rider. The screen raises its
   * urgency and the pacer re-asks; both read this rather than each testing the
   * state themselves.
   */
  awaitingAnswer: boolean;
};

const ACTION_LABEL: Record<string, string> = {
  boarded: "Тийм, суусан",
  not_boarded: "Үгүй, суугаагүй",
  unsure: "Мэдэхгүй байна",
  exited: "Тийм, буусан",
  not_yet: "Хараахан үгүй",
  wait_next: "Дараагийн автобусыг хүлээх",
  find_other: "Өөр чиглэл хайх",
  at_stop: "Би буудал дээр байна",
  ask: "Асуух",
  finish: "Дуусгах",
};

function headlineFor(journey: Journey): string {
  const route = journey.route?.displayName ?? "";
  switch (journey.state) {
    case "idle":
    case "selecting_destination":
      return "Хаашаа явах вэ?";
    case "analyzing_route":
      return "Зам хайж байна";
    case "route_selected":
      return route ? `${route} чиглэл сонгогдлоо` : "Чиглэл сонгогдлоо";
    case "walking_to_stop":
      return "Буудал руу явж байна";
    case "waiting_for_bus":
      return route ? `${route} хүлээж байна` : "Автобус хүлээж байна";
    case "bus_due":
      /**
       * NOT "arriving" and NOT "approaching". Both assert a vehicle was seen.
       * What we know is that a timetable said this time, and that is all this
       * says: the bus is DUE according to a schedule.
       */
      return route ? `${route} цагтаа ойрхон` : "Автобус ирэх цаг ойрхон";
    case "confirming_boarding":
      // The wording follows WHY we are asking. An expired estimate means a
      // printed time passed — not that a bus came, and not that it did not.
      return journey.boardingAskReason === "expired"
        ? "Автобус ирэх цаг болсон. Суусан уу?"
        : "Автобусанд суусан уу?";
    case "on_bus":
      return route ? `${route}-д явж байна` : "Автобусанд явж байна";
    case "approaching_destination":
      return "Буудалдаа ойртож байна";
    case "confirming_exit":
      return "Автобуснаас буусан уу?";
    case "arrived":
      return "Аялал дууслаа";
    case "journey_error":
      return "Тасалдал гарлаа";
  }
}

function detailFor(journey: Journey, now: number): string | null {
  switch (journey.state) {
    case "walking_to_stop":
      return journey.distanceToStopM !== null
        ? `${Math.round(journey.distanceToStopM)} м · ${journey.origin?.name ?? ""}`.trim()
        : (journey.origin?.name ?? null);

    case "waiting_for_bus":
    case "bus_due": {
      if (journey.busDueAt === null) return journey.origin?.name ?? null;
      const minutes = Math.round((journey.busDueAt - now) / 60_000);
      /**
       * THE SCREEN CARRIES THE SAME TWO HEDGES THE VOICE DOES.
       *
       * "Ойролцоогоор" hedges the NUMBER; the source label hedges the CLAIM.
       * Both are properties of the data, not of the audio channel — a rider with
       * partial sight reading a bare "4 мин" would be reading something the app
       * never said, and would have no way to know a printed timetable is all
       * that is behind it.
       *
       * The label is not a badge or a colour. Someone reading this screen at
       * arm's length with low vision needs it in the same line as the number,
       * in words, because a colour-coded distinction is exactly the kind this
       * app may not rely on.
       */
      const when = minutes >= 1 ? `Ойролцоогоор ${minutes} мин` : "Ирэх цаг болсон";
      const source = journey.busDueSource === "live" ? "Шууд байршил" : "Цагийн хуваарь";
      return `${source} · ${when}`;
    }

    case "on_bus":
    case "approaching_destination": {
      const remaining = journey.remainingStops;
      if (remaining === null) return journey.destination?.name ?? null;
      if (remaining < 0) return `${-remaining} буудал өнгөрлөө`;
      if (remaining === 0) return journey.destination?.name ?? "Буудалдаа ирлээ";
      return `${remaining} буудал · ${journey.destination?.name ?? ""}`.trim();
    }

    case "confirming_boarding":
    case "confirming_exit":
      return journey.route?.displayName ?? null;

    case "arrived":
      return journey.destination?.name ?? null;

    default:
      return journey.destination?.name ?? null;
  }
}

export function present(journey: Journey, now: number): Presentation {
  const actions = guideOptions(journey).map((o) => ({
    ...o,
    label: ACTION_LABEL[o.id] ?? o.id,
  }));

  return {
    headline: headlineFor(journey),
    detail: detailFor(journey, now),
    progress: progressOf(journey),
    actions,
    awaitingAnswer: journey.state === "confirming_boarding" || journey.state === "confirming_exit",
  };
}
