import type { MetadataRoute } from "next";

const SITE_URL = "https://www.visionaccess.world";

/**
 * Only routes that render standalone with no required session/query state.
 * /dev/* 404s in production (see each dev page's NODE_ENV guard) and is left
 * out entirely, as are /api/* routes, which are not pages.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: "monthly", priority: 1 },
    { url: `${SITE_URL}/bus/wait`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/bus/journey`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${SITE_URL}/bus/board`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/bus/ride`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/settings`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];
}
