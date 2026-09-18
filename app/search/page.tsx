import type { Metadata } from "next";
import { StaticSearch } from "@/components/search/static-search";
import { loadPublishedArtifact } from "@/lib/site-data/source";

export const metadata: Metadata = { title: "搜索", description: "搜索游戏、开发商或 Steam App ID。", robots: { index: false, follow: true } };

export default async function SearchPage() { const { games } = await loadPublishedArtifact(); return <StaticSearch games={games} />; }
