import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Харааны Хандалт",
  description: "Camera-based obstacle detection and bus guidance for blind users in Mongolia.",
  // iOS: without this, adding to the home screen opens in a browser chrome that
  // steals vertical space and re-introduces the scroll gestures we disable.
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Харааны Хандалт" },
};

/**
 * iOS needs an explicit viewport or Safari assumes a zoomable desktop page,
 * which keeps double-tap-to-zoom alive — and Safari consumes the double-tap
 * before the app ever sees it. That is why "select" did nothing on iPhone.
 *
 * Pinch zoom is deliberately LEFT ENABLED (`userScalable`, maximumScale 5).
 * Locking the scale is the usual fix for double-tap zoom, but this app has
 * partial-sight users who magnify the screen; taking that away to win a gesture
 * would be a bad trade. Double-tap zoom is disabled precisely, per-element, via
 * `touch-action: manipulation` on the gesture surface instead.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  // Fills the notch area so the full-screen gesture surface really is full screen.
  viewportFit: "cover",
  themeColor: "#000000",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="mn"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
