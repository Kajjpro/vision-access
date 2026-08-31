'use client';

/**
 * Voice journey capture: hold to speak, confirm, resolve direction.
 *
 * The machine is deliberately conservative. A misheard destination puts a blind
 * rider on a bus going the wrong way across Ulaanbaatar, so nothing commits
 * without an explicit confirming gesture — never on ASR confidence alone.
 *
 * Wiring (gesture layer stays yours):
 *   long-press down → beginListening()
 *   long-press up   → endListening()
 *   double-tap      → confirm()
 *   swipe left      → reject()   (re-ask the current slot)
 *   two-finger tap  → restart()
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createRecognizer, type Recognizer, type SttEngine, type SttError,
} from '@/lib/speech/recognizer';
import { parseJourney } from '@/lib/speech/journeyGrammar';
import {
  matchStopsAny,
  needsDisambiguation,
  resolveJourney,
  type Direction,
  type JourneyLeg,
  type Route,
  type Stop,
  type StopMatch,
} from '@/lib/routing/resolveJourney';
import { playListenCue, stopAll } from '@/lib/audio';
import { askLlmAssist, needsAssist } from '@/lib/ui/llmAssist';
import {
  boardingClips,
  confirmJourneyClips,
  disambiguationClips,
  PHRASES,
  stopClip,
  type ClipId,
} from '@/lib/speech/announcements';

export type Phase =
  | 'idle'
  | 'awaiting-origin'
  | 'awaiting-destination'
  | 'listening'
  | 'processing'
  | 'disambiguating'
  | 'confirming'
  | 'resolved'
  | 'failed';

export interface VoiceJourneyState {
  phase: Phase;
  partialTranscript: string;
  origin: Stop | null;
  destination: Stop | null;
  candidates: StopMatch[];
  legs: JourneyLeg[];
  error: SttError | null;
}

export interface UseVoiceJourneyOptions {
  stops: Stop[];
  routes: Route[];
  /** Queue pre-rendered clips. Should interrupt whatever is currently playing. */
  speak: (clips: ClipId[]) => void;
  /** Rider position, used to bias origin matching. */
  position?: [number, number];
  onResolved?: (leg: JourneyLeg) => void;
  /** Called when voice input cannot proceed and the stop list must take over. */
  onFallbackNeeded?: () => void;
  /**
   * Direction convention for THIS feed, from
   * `inferDirectionMapper(collectRawDirections(routes))` at data load.
   *
   * Threaded rather than defaulted because the default guard is positional: it
   * throws on a raw `2` only when a leg is found in that direction, so a 1/2
   * feed without this crashes on half the journeys and silently mislabels the
   * other half. See the test of the same name in resolveJourney.test.ts.
   */
  mapDirection?: (raw: number) => Direction;
}

type Slot = 'origin' | 'destination';

export function useVoiceJourney({
  stops,
  routes,
  speak,
  position,
  onResolved,
  onFallbackNeeded,
  mapDirection,
}: UseVoiceJourneyOptions) {
  const [state, setState] = useState<VoiceJourneyState>({
    phase: 'idle',
    partialTranscript: '',
    origin: null,
    destination: null,
    candidates: [],
    legs: [],
    error: null,
  });

  const slotRef = useRef<Slot>('origin');
  const recognizerRef = useRef<Recognizer | null>(null);
  /**
   * Which engine actually produced the last result.
   *
   * State, not `recognizerRef.current.engine`. The recognizer flips itself from
   * Web Speech to Azure the first time Mongolian is refused, and a ref read
   * during render neither re-renders on that flip nor is guaranteed to be read
   * after it — so a screen showing or announcing the engine showed the wrong
   * one indefinitely. `onResult` carries the engine that did the work.
   */
  const [engine, setEngine] = useState<SttEngine>('webspeech');
  const stateRef = useRef(state);
  stateRef.current = state;

  const stopIndex = useMemo(
    () => new Map(stops.map((s) => [s.id, s])),
    [stops],
  );

  // ------------------------------------------------------------ slot handling

  const askFor = useCallback(
    (slot: Slot) => {
      slotRef.current = slot;
      setState((s) => ({
        ...s,
        phase: slot === 'origin' ? 'awaiting-origin' : 'awaiting-destination',
        partialTranscript: '',
        candidates: [],
        error: null,
      }));
      speak([
        slot === 'origin' ? PHRASES.askOrigin : PHRASES.askDestination,
        PHRASES.holdToSpeak,
      ]);
    },
    [speak],
  );

  const commitStop = useCallback(
    (slot: Slot, stop: Stop) => {
      const next = {
        origin: slot === 'origin' ? stop : stateRef.current.origin,
        destination: slot === 'destination' ? stop : stateRef.current.destination,
      };
      setState((s) => ({ ...s, ...next, candidates: [], phase: 'processing' }));

      if (!next.origin) {
        askFor('origin');
        return;
      }
      if (!next.destination) {
        askFor('destination');
        return;
      }
      setState((s) => ({ ...s, phase: 'confirming' }));
      speak(confirmJourneyClips(next.origin.id, next.destination.id));
    },
    [askFor, speak],
  );

  const handleFragment = useCallback(
    async (slot: Slot, fragments: string[]) => {
      let matches = matchStopsAny(fragments, stops, {
        near: slot === 'origin' ? position : undefined,
        limit: 3,
      });
      let ambiguous = needsDisambiguation(matches);

      /**
       * THE OPTIONAL MODEL LAYER, CONSULTED ONLY WHEN THE MATCHER IS UNSURE.
       *
       * Reached only on the two outcomes that were about to cost the rider a
       * question anyway: nothing found, or a top two too close to separate. On
       * a confident match this does not run at all — no round trip, no quota,
       * and no way for the layer to spoil an answer that was already right.
       *
       * Its reply is advice. `resolved` reorders the candidates we already had;
       * it can never introduce one, because the route drops any id it did not
       * itself send (see the gate in app/api/stop-resolve/route.ts). Anything
       * else — no key, offline, slow, garbled — falls through to exactly the
       * behaviour below this block, which is what the app did before there was
       * a model in it at all.
       */
      if (needsAssist(matches, ambiguous)) {
        const assist = await askLlmAssist(fragments, matches);

        if (assist?.kind === 'resolved') {
          const picked = matches.find((m) => m.stop.id === assist.stopId);
          if (picked) {
            commitStop(slot, picked.stop);
            return;
          }
        } else if (assist?.kind === 'ask' && assist.question === 'did_you_say') {
          const named = matches.find((m) => m.stop.id === assist.stopIds[0]);
          if (named) {
            // Narrowed to one, but not certain — read it back and let the
            // existing confirm gesture decide. Nothing commits here.
            slotRef.current = slot;
            matches = [named];
            ambiguous = false;
            setState((s) => ({ ...s, phase: 'disambiguating', candidates: matches }));
            speak([PHRASES.didYouSay, stopClip(named.stop.id)]);
            return;
          }
        } else if (assist?.kind === 'ask' && assist.question === 'which_one') {
          const ordered = assist.stopIds
            .map((id) => matches.find((m) => m.stop.id === id))
            .filter((m): m is StopMatch => m !== undefined);
          if (ordered.length > 1) {
            slotRef.current = slot;
            matches = ordered;
            ambiguous = true;
          }
        } else if (assist?.kind === 'ask' && assist.question === 'use_list') {
          // The model saw nothing stop-shaped. Skip the retry loop and hand the
          // rider the gesture list rather than asking them to repeat a name
          // that was never going to match.
          handlersRef.current.onFallbackNeeded?.();
          speak([PHRASES.useListInstead]);
          return;
        }
        // 'say_again', 'unknown', and every failure land on the paths below.
      }

      if (matches.length === 0) {
        /**
         * ONE speak() call, not two.
         *
         * This used to say `notHeard` and then let `askFor` say the question,
         * and `speak` interrupts by design — so the second call cut the first
         * off after a syllable and the rider never once heard "Ойлгосонгүй".
         * They got the same question again with no hint that anything had gone
         * wrong, which reads as the app ignoring them rather than mishearing.
         */
        slotRef.current = slot;
        setState((s) => ({
          ...s,
          phase: slot === 'origin' ? 'awaiting-origin' : 'awaiting-destination',
          partialTranscript: '',
          candidates: [],
          error: null,
        }));
        speak([
          PHRASES.notHeard,
          slot === 'origin' ? PHRASES.askOrigin : PHRASES.askDestination,
          PHRASES.holdToSpeak,
        ]);
        return;
      }
      if (ambiguous) {
        slotRef.current = slot;
        setState((s) => ({ ...s, phase: 'disambiguating', candidates: matches }));
        speak(disambiguationClips(matches.slice(0, 3).map((m) => m.stop.id)));
        return;
      }
      commitStop(slot, matches[0].stop);
    },
    [commitStop, position, speak, stops],
  );

  /**
   * EVERY alternative is searched, not just the one the engine ranked first.
   *
   * The engine is transcribing a proper noun that is not in its language model,
   * so its ordering between near-homophones is close to arbitrary — but only
   * one of them is a real stop name, and `stops.json` knows which. Each
   * alternative is parsed for case markers separately, because the marker is
   * exactly the kind of unstressed final syllable the recogniser drops: one
   * spelling can carry "-аас" and reveal an origin where another lost it.
   */
  const handleResult = useCallback(
    (alternatives: string[]) => {
      const parsed = alternatives.map(parseJourney);
      const slot = slotRef.current;

      // A single utterance carrying both roles fills both slots at once.
      const roleBearing = parsed.filter((p) => !p.ambiguous && p.originText && p.destText);
      if (roleBearing.length > 0) {
        const originMatches = matchStopsAny(
          roleBearing.map((p) => p.originText!),
          stops,
          { near: position, limit: 3 },
        );
        const destMatches = matchStopsAny(
          roleBearing.map((p) => p.destText!),
          stops,
          { limit: 3 },
        );
        if (
          originMatches.length > 0 &&
          destMatches.length > 0 &&
          !needsDisambiguation(originMatches) &&
          !needsDisambiguation(destMatches)
        ) {
          setState((s) => ({
            ...s,
            origin: originMatches[0].stop,
            destination: destMatches[0].stop,
            phase: 'confirming',
          }));
          speak(confirmJourneyClips(originMatches[0].stop.id, destMatches[0].stop.id));
          return;
        }
      }

      // Rank order is preserved so `matchStopsAny` can still charge the
      // alternative penalty; the raw transcript is the last resort for an
      // utterance the grammar could not split at all.
      const fragments: string[] = [];
      parsed.forEach((p, i) => {
        const fragment =
          slot === 'origin'
            ? (p.originText ?? p.destText ?? alternatives[i])
            : (p.destText ?? p.originText ?? alternatives[i]);
        if (fragment && !fragments.includes(fragment)) fragments.push(fragment);
      });

      handleFragment(slot, fragments);
    },
    [handleFragment, position, speak, stops],
  );

  // ------------------------------------------------------------- recognizer

  /**
   * The recognizer is created ONCE and reads its callbacks through a ref.
   *
   * This effect used to depend on `handleTranscript`, which depends on
   * `position` — so every GPS update rebuilt the recognizer, and the cleanup
   * runs `recognizer.abort()`. The wait screen watches GPS continuously while
   * a fix converges, which is exactly when the rider is standing at the stop
   * holding the button: their sentence was aborted mid-word by a location
   * update they cannot see, and the app simply went quiet.
   *
   * Holding the callbacks in a ref keeps the microphone owned by one object for
   * the life of the screen, which is also what makes `abort()` on unmount a
   * reliable release rather than a race with the next render.
   */
  const handlersRef = useRef({ handleResult, askFor, speak, onFallbackNeeded });
  handlersRef.current = { handleResult, askFor, speak, onFallbackNeeded };

  useEffect(() => {
    const recognizer = createRecognizer({
      onPartial: (text) => setState((s) => ({ ...s, partialTranscript: text })),
      onResult: ({ transcript, alternatives, engine: usedEngine }) => {
        setEngine(usedEngine);
        setState((s) => ({ ...s, partialTranscript: transcript, phase: 'processing' }));
        handlersRef.current.handleResult(alternatives);
      },
      onError: (error) => {
        setState((s) => ({ ...s, error, phase: error.fatal ? 'failed' : s.phase }));
        if (error.fatal) {
          handlersRef.current.speak([
            error.code === 'permission-denied' ? PHRASES.micDenied : PHRASES.offline,
            PHRASES.useListInstead,
          ]);
          handlersRef.current.onFallbackNeeded?.();
        } else {
          // One utterance, not two: `speak` interrupts, so saying "Ойлгосонгүй"
          // and then asking the question again swallowed the first of them.
          const slot = slotRef.current;
          setState((s) => ({
            ...s,
            phase: slot === 'origin' ? 'awaiting-origin' : 'awaiting-destination',
            partialTranscript: '',
          }));
          handlersRef.current.speak([
            PHRASES.notHeard,
            slot === 'origin' ? PHRASES.askOrigin : PHRASES.askDestination,
            PHRASES.holdToSpeak,
          ]);
        }
      },
      onStateChange: (s) => {
        if (s === 'listening') setState((prev) => ({ ...prev, phase: 'listening' }));
        if (s === 'processing') setState((prev) => ({ ...prev, phase: 'processing' }));
      },
    });
    recognizerRef.current = recognizer;
    return () => recognizer.abort();
  }, []);

  // ----------------------------------------------------------------- actions

  const start = useCallback(() => {
    setState({
      phase: 'awaiting-origin',
      partialTranscript: '',
      origin: null,
      destination: null,
      candidates: [],
      legs: [],
      error: null,
    });
    askFor('origin');
  }, [askFor]);

  /**
   * AN EARCON, NOT A SENTENCE.
   *
   * This used to speak "Сонсож байна" and open the microphone in the same tick.
   * Both then ran at once, so the recording began with the app's own voice
   * saying a Mongolian phrase, and that is what got uploaded ahead of the stop
   * name — the recogniser's first and most confident guess was a word the rider
   * never said. Waiting the clip out instead would fix the accuracy and cost a
   * second of dead air on every attempt, which push-to-talk does not need: the
   * rider's finger is already down, so all they require is to be told the
   * microphone is open, instantly and in something that is not speech.
   *
   * `playListenCue`, deliberately not `playTone` — that one is the 880 Hz
   * square wave meaning an unmeasurable obstacle, and teaching a blind user
   * that the danger sound sometimes means "microphone ready" is the one
   * confusion this app cannot afford.
   */
  const beginListening = useCallback(() => {
    const p = stateRef.current.phase;
    if (p !== 'awaiting-origin' && p !== 'awaiting-destination') return;
    stopAll();
    playListenCue('start');
    void recognizerRef.current?.start();
  }, []);

  const endListening = useCallback(() => {
    playListenCue('end');
    recognizerRef.current?.stop();
  }, []);

  /** Disambiguation answer: 1-based, matching the spoken numbering. */
  const chooseCandidate = useCallback(
    (index: number) => {
      const match = stateRef.current.candidates[index - 1];
      if (match) commitStop(slotRef.current, match.stop);
    },
    [commitStop],
  );

  /**
   * Fill the current slot from OUTSIDE the recognizer — the gesture-driven
   * stop list.
   *
   * This is the whole of the fallback contract: when both speech engines are
   * gone, a rider must still be able to name an origin and a destination, and
   * they must arrive at exactly the same confirmation step as a spoken one. A
   * parallel path that skipped the read-back would mean the safety property
   * held only for the input mode that happened to be working.
   */
  const chooseStop = useCallback(
    (stop: Stop) => {
      commitStop(slotRef.current, stop);
    },
    [commitStop],
  );

  const confirm = useCallback(() => {
    const { phase, origin, destination } = stateRef.current;
    if (phase !== 'confirming' || !origin || !destination) return;

    const result = resolveJourney(origin, destination, routes, mapDirection);

    if (result.kind === 'ok') {
      setState((s) => ({ ...s, phase: 'resolved', legs: result.legs }));
      const leg = result.legs[0];
      speak(boardingClips(leg.route.id, leg.boardAt.id, leg.hops));
      onResolved?.(leg);
      return;
    }
    if (result.kind === 'wrong-direction') {
      setState((s) => ({ ...s, phase: 'failed' }));
      speak([
        PHRASES.wrongDirection,
        stopClip(result.suggestion.boardAt.id),
        PHRASES.from,
        stopClip(result.suggestion.alightAt.id),
        PHRASES.to,
      ]);
      return;
    }
    setState((s) => ({ ...s, phase: 'failed' }));
    speak([result.kind === 'same-stop' ? PHRASES.sameStop : PHRASES.noRoute]);
  }, [mapDirection, onResolved, routes, speak]);

  /** Rejecting a confirmation re-asks only the destination — the usual culprit. */
  const reject = useCallback(() => {
    const { phase } = stateRef.current;
    if (phase === 'confirming') {
      setState((s) => ({ ...s, destination: null }));
      askFor('destination');
      return;
    }
    askFor(slotRef.current);
  }, [askFor]);

  const restart = useCallback(() => {
    recognizerRef.current?.abort();
    start();
  }, [start]);

  return {
    ...state,
    engine,
    stopIndex,
    start,
    beginListening,
    endListening,
    chooseCandidate,
    chooseStop,
    confirm,
    reject,
    restart,
  };
}
