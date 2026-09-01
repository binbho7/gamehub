import type { Metadata } from "next";
import { GameLibrary } from "@/components/filters/game-library";
import { Container } from "@/components/layout/container";
import { games, genres, platforms } from "@/lib/mock-data";
import type { GameSort, ReleaseStatus } from "@/types/game";

export const metadata: Metadata = { title: "游戏库", description: "浏览 GameHub 收录的游戏与官方资源。", alternates: { canonical: "/games" } };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
export default async function GamesPage({ searchParams }: Props) { const p = await searchParams; const val = (k:string) => typeof p[k] === "string" ? p[k] : undefined; const sort = val("sort"); const status = val("status"); const years = [...new Set(games.map((game) => game.releaseDate.slice(0, 4)))].sort().reverse(); return <Container className="pt-28"><div className="mb-9"><h1 className="text-4xl font-bold tracking-tight">游戏库</h1><p className="mt-3 text-muted-foreground">发现值得玩的游戏，并直达可信的官方资源。</p></div><GameLibrary games={games} genres={genres} platforms={platforms} years={years} initial={{ query: val("q"), genre: val("genre"), platform: val("platform"), year: val("year"), sort: (["popular", "rating", "newest", "oldest", "title"].includes(sort ?? "") ? sort : undefined) as GameSort | undefined, status: (["released", "upcoming"].includes(status ?? "") ? status : undefined) as ReleaseStatus | undefined, free: val("free") === "true" ? true : undefined }} /></Container>; }
