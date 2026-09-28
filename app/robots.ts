import type { MetadataRoute } from "next";

const SITE_URL = "https://www.visionaccess.world";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // /dev/* already 404s in production; disallow is belt-and-suspenders so
      // a crawler never links to it even if that guard is ever loosened.
      disallow: ["/dev/", "/api/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
