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

const SITE_URL = "https://www.visionaccess.world";
const SITE_NAME = "Vision Access";
// Kept in Mongolian — the same string already spoken on load and shown as the
// app name everywhere in the UI (see lib/ui/announcements.ts SCREEN.home).
const DEFAULT_DESCRIPTION =
  "Харааны бэрхшээлтэй иргэдэд зориулсан автобусны навигаци. Буудал, зогсоолыг дуугаар мэдэгдэж, аяллын турш зорчигчийг дагалдана. Алдааг шууд мэдэгдэх боломжтой.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Харааны Хандалт | Vision Access", template: `%s | ${SITE_NAME}` },
  description: DEFAULT_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "mn_MN",
    url: "/",
    siteName: SITE_NAME,
    title: "Харааны Хандалт | Vision Access",
    description: DEFAULT_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "Харааны Хандалт | Vision Access",
    description: DEFAULT_DESCRIPTION,
  },
  // iOS: without this, adding to the home screen opens in a browser chrome that
  // steals vertical space and re-introduces the scroll gestures we disable.
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Харааны Хандалт" },
};

const JSON_LD = [
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    alternateName: "Харааны Хандалт",
    url: SITE_URL,
    inLanguage: "mn",
  },
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    alternateName: "Харааны Хандалт",
    url: SITE_URL,
    description: DEFAULT_DESCRIPTION,
    applicationCategory: "TravelApplication",
    operatingSystem: "Web",
    inLanguage: "mn",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  },
];

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
      <body className="min-h-full flex flex-col">
        {children}
        <script
          type="application/ld+json"
          // JSON.stringify of a fixed, code-defined array — no user input, so
          // this is not an XSS vector despite the raw HTML injection.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
        />
      </body>
    </html>
  );
}
