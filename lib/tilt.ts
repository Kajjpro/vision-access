/**
 * Camera pitch from the device orientation sensor.
 *
 * Extracted from WalkMode when Ask mode needed the same two functions. Both
 * modes feed `CameraPose.pitchDeg`, and a guessed pitch is the single largest
 * source of distance error — so a second, subtly different copy of this is
 * exactly the kind of drift that would make two modes disagree about how far
 * away the same door is.
 */

/**
 * iOS gates the orientation sensor behind an explicit grant that must be asked
 * for inside a user gesture. Returns false when unavailable, in which case the
 * pitch falls back to a constant and distances get much less accurate.
 */
type OrientationCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

export async function requestTiltPermission(): Promise<boolean> {
  if (typeof DeviceOrientationEvent === "undefined") return false;
  const ctor = DeviceOrientationEvent as OrientationCtor;
  if (typeof ctor.requestPermission !== "function") return true; // Android: no gate
  try {
    return (await ctor.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/**
 * `beta` is the front-to-back tilt: 90 with the phone held upright, 0 laid flat.
 * The rear camera points level at beta 90, so downward pitch is 90 - beta.
 */
export function pitchFromBeta(beta: number | null): number | null {
  if (beta === null || Number.isNaN(beta)) return null;
  return Math.min(80, Math.max(0, 90 - beta));
}
