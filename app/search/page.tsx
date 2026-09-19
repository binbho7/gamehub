import type { Metadata } from "next";
import { StaticSearch } from "@/components/search/static-search";
import { loadPublishedArtifact } from "@/lib/site-data/source";
import { toGameBrowseRecord } from "@/lib/search-contract";

export const metadata: Metadata = { title: "搜索", description: "搜索游戏名称、开发商或出版商。", robots: { index: false, follow: true } };

export default async function SearchPage() { const { games } = await loadPublishedArtifact(); return <StaticSearch games={games.map(toGameBrowseRecord)} />; }
