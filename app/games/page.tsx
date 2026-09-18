import type { Metadata } from "next";
import { StaticGameLibrary } from "@/components/filters/static-game-library";
import { Container } from "@/components/layout/container";
import { games, genres, platforms } from "@/lib/mock-data";

export const metadata: Metadata = { title: "游戏库", description: "浏览 GameHub 收录的游戏与官方资源。", alternates: { canonical: "/games" } };
export default function GamesPage() { const years = [...new Set(games.map((game) => game.releaseDate.slice(0, 4)))].sort().reverse(); return <Container className="pt-28"><div className="mb-9"><h1 className="text-4xl font-bold tracking-tight">游戏库</h1><p className="mt-3 text-muted-foreground">发现值得玩的游戏，并直达可信的官方资源。</p></div><StaticGameLibrary games={games} genres={genres} platforms={platforms} years={years} /></Container>; }
