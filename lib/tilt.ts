/**
 * Camera pitch from the device orientation sensor.
 *
 * Extracted from WalkMode when Ask mode needed the same function. Both modes
 * feed `CameraPose.pitchDeg`, and a guessed pitch is the single largest source
 * of distance error — so a second, subtly different copy is exactly the kind of
 * drift that would make two modes disagree about how far away the same door is.
 *
 * The PERMISSION half lives in lib/camera.ts alongside `openCamera`, which is
 * where it belongs: both are gestures-gated device grants, and one home for
 * them beats two.
 */

/**
 * `beta` is the front-to-back tilt: 90 with the phone held upright, 0 laid flat.
 * The rear camera points level at beta 90, so downward pitch is 90 - beta.
 */
export function pitchFromBeta(beta: number | null): number | null {
  if (beta === null || Number.isNaN(beta)) return null;
  return Math.min(80, Math.max(0, 90 - beta));
}
