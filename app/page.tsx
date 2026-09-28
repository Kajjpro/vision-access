/**
 * Home. The interaction model lives in app/HomeGestures.tsx (its own
 * "use client"), so this file stays a server component only to carry the
 * route's metadata — rendering is unchanged.
 *
 * The old 2x2 touch-explore grid is gone as an input surface: it required the
 * user to find a quadrant on flat glass, which is exactly the assumption this
 * app cannot make. Options are now a list scrolled by ear, with the whole
 * viewport as the only target. Grid position survives as spoken metadata.
 */
import { HomeGestures, HOME_TILE_ROUTES } from "./HomeGestures";

export { HOME_TILE_ROUTES };

export const metadata = {
  description: "Харааны бэрхшээлтэй иргэдэд зориулсан автобусны навигаци. Буудал, зогсоолыг дуугаар мэдэгдэж, аяллын турш зорчигчийг дагалдана.",
  alternates: { canonical: "/" },
};

export default function Home() {
  return <HomeGestures />;
}
