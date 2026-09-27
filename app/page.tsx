"use client";

/**
 * Home. The interaction model lives in app/HomeGestures.tsx.
 *
 * The old 2x2 touch-explore grid is gone as an input surface: it required the
 * user to find a quadrant on flat glass, which is exactly the assumption this
 * app cannot make. Options are now a list scrolled by ear, with the whole
 * viewport as the only target. Grid position survives as spoken metadata.
 */
import { HomeGestures, HOME_TILE_ROUTES } from "./HomeGestures";

export { HOME_TILE_ROUTES };

export default function Home() {
  return <HomeGestures />;
}
