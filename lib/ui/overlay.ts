/**
 * Detector coordinates -> screen coordinates, for the lock-on box.
 *
 * The detector reports boxes in CAMERA FRAME pixels (see vision.worker.ts:
 * "Pixel coords in the ORIGINAL frame"), which is whatever the camera decided
 * to hand over — often 1280x720. The preview paints that frame with
 * `object-cover`, which scales it up until it covers the viewport and throws
 * away whatever hangs off the edges. So a box at frame x=640 is NOT at screen
 * x=640, and on a portrait phone showing a landscape frame it is not even
 * proportional: roughly a third of the frame's width is off-screen.
 *
 * Getting this wrong is not a cosmetic bug. The box is the only way a sighted
 * person — the helper setting the phone up, or whoever is debugging a bad
 * warning — can check that the thing the app is talking about is the thing
 * actually in front of it. A box drawn 200px from the object it names makes a
 * working detector look broken and a broken one look plausible.
 *
 * Pure functions in their own file so the mapping can be tested without a
 * camera, a DOM or a phone.
 */

export type Size = { width: number; height: number };

/** Top-left xywh, in frame pixels. The shape the detector and tracker use. */
export type FrameRect = { x: number; y: number; w: number; h: number };

/** Top-left xywh, in CSS pixels relative to the preview element. */
export type ScreenRect = { left: number; top: number; width: number; height: number };

/**
 * The transform `object-fit: cover` applies: scale to cover, then centre-crop.
 *
 * `offsetX`/`offsetY` are negative on the cropped axis — that is the point,
 * not an error. Half the overflow sits off the left/top edge, so a frame
 * coordinate maps to a negative screen coordinate exactly when the camera can
 * see something the user's screen cannot.
 *
 * Returns null rather than a degenerate transform when either size is not yet
 * known: the video reports 0x0 until metadata lands, and dividing by that
 * would put every box at NaN.
 */
export type CoverTransform = { scale: number; offsetX: number; offsetY: number };

export function coverTransform(frame: Size, viewport: Size): CoverTransform | null {
  if (
    !(frame.width > 0) ||
    !(frame.height > 0) ||
    !(viewport.width > 0) ||
    !(viewport.height > 0)
  ) {
    return null;
  }

  // max, not min: cover fills the box and overflows. min would be `contain`,
  // which letterboxes — and the preview does not letterbox.
  const scale = Math.max(viewport.width / frame.width, viewport.height / frame.height);
  return {
    scale,
    offsetX: (viewport.width - frame.width * scale) / 2,
    offsetY: (viewport.height - frame.height * scale) / 2,
  };
}

export function projectRect(rect: FrameRect, t: CoverTransform): ScreenRect {
  return {
    left: t.offsetX + rect.x * t.scale,
    top: t.offsetY + rect.y * t.scale,
    width: rect.w * t.scale,
    height: rect.h * t.scale,
  };
}

/** A single frame-x (a corridor edge, say) as a screen-x. */
export function projectX(x: number, t: CoverTransform): number {
  return t.offsetX + x * t.scale;
}

/**
 * Whether any of the box is actually on screen.
 *
 * Overflow is clipped by the container, so an off-screen box is invisible
 * either way — this exists so it is never rendered at all. It is also the
 * honest answer to "is the locked object visible": with a landscape frame on
 * a portrait phone the detector can lock onto something in the cropped margin,
 * and drawing nothing is better than drawing a sliver at the edge that implies
 * the object is at the edge.
 */
export function isOnScreen(rect: ScreenRect, viewport: Size): boolean {
  return (
    rect.left < viewport.width &&
    rect.top < viewport.height &&
    rect.left + rect.width > 0 &&
    rect.top + rect.height > 0
  );
}
