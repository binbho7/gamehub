import type { Metadata } from "next";
import { StaticSearch } from "@/components/search/static-search";
import { loadPublishedArtifact } from "@/lib/site-data/source";
import { toGameBrowseRecord } from "@/lib/search-contract";
import { SEARCH_METADATA } from "@/app/seo";

export const metadata: Metadata = SEARCH_METADATA;

export default async function SearchPage() { const { games } = await loadPublishedArtifact(); return <StaticSearch games={games.map(toGameBrowseRecord)} />; }
