import type { Metadata } from "next";
import { StaticGameLibrary } from "@/components/filters/static-game-library";
import { Container } from "@/components/layout/container";
import { loadPublishedArtifact } from "@/lib/site-data/source";
import { toGameBrowseRecord } from "@/lib/search-contract";
import { GAMES_METADATA } from "@/lib/seo";

export const metadata: Metadata = GAMES_METADATA;
export default async function GamesPage() { const { games } = await loadPublishedArtifact(); const browseGames = games.map(toGameBrowseRecord); const genres = [...new Set(browseGames.flatMap((game) => game.genres))].sort(); const platforms = [...new Set(browseGames.flatMap((game) => game.platforms))].sort(); const years = [...new Set(browseGames.map((game) => game.releaseDate.slice(0, 4)))].sort().reverse(); return <Container className="pt-28"><div className="mb-9 border-b border-white/[.08] pb-7 sm:mb-10 sm:pb-8"><h1 className="text-4xl font-black tracking-[-.04em] sm:text-5xl">游戏库</h1><p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">发现值得玩的游戏，并直达可信的官方资源。</p></div><StaticGameLibrary games={browseGames} genres={genres} platforms={platforms} years={years} /></Container>; }
