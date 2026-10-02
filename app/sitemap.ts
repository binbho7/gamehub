import type { MetadataRoute } from "next";
import { buildSitemapEntries } from "@/lib/seo";
import { loadPublishedArtifact } from "@/lib/site-data/source";

export const dynamic = "force-static";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemapEntries(await loadPublishedArtifact());
}
