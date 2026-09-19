/**
 * Camera stream with a timeout.
 *
 * getUserMedia MUST be called from inside a user gesture on iOS Safari. Called
 * from an effect or a timer after the tap it never shows the permission
 * prompt and the promise simply hangs — which to someone tapping a tile reads
 * as "the button does not work". Call this from the tap that enters a camera
 * mode and hand the stream to the mode; do not call it from an effect.
 *
 * The timeout turns the two ways a request can wedge — no gesture to hang the
 * prompt, or an embedding iframe whose permissions policy forbids the camera —
 * into an audible error instead of endless silence. The size constraint
 * matches the capture size WalkMode requests.
 */
const CAMERA_TIMEOUT_MS = 30_000;

export async function openCamera(timeoutMs = CAMERA_TIMEOUT_MS): Promise<MediaStream> {
  const request = navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: 640, height: 480 },
    audio: false,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`camera did not open within ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([request, limit]);
  } catch (e) {
    // A request that resolves after we gave up would otherwise leave the
    // camera running for nobody — release it so the LED does not stay on.
    void request
      .then((stream) => {
        for (const track of stream.getTracks()) track.stop();
      })
      .catch(() => {
        // Already rejected; nothing to release.
      });
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type OrientationCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

/**
 * iOS gates the orientation sensor behind an explicit grant that must be
 * asked for inside a user gesture. Returns true when the sensor may be used,
 * false when unavailable or denied — the caller then falls back to a constant
 * pitch and distances get much less accurate.
 *
 * Call this from the same tap that opens the camera, not from an effect:
 * outside a gesture iOS rejects the request, so the pitch would silently
 * degrade on exactly the phones this app targets.
 */
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
