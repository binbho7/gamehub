import type { MetadataRoute } from "next";
import { ROBOTS_METADATA } from "@/app/seo";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return ROBOTS_METADATA;
}
