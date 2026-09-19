import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Container } from "@/components/layout/container";
import { GameGrid } from "@/components/game/game-grid";
import { loadPublishedArtifact } from "@/lib/site-data/source";

export async function generateStaticParams() { const { games } = await loadPublishedArtifact(); return [...new Set(games.flatMap((game) => game.platformSlugs ?? []))].map((slug) => ({ slug })); }
function findPlatform(games: Awaited<ReturnType<typeof loadPublishedArtifact>>["games"], slug: string) { const game = games.find((item) => item.platformSlugs?.includes(slug)); return game ? game.platforms[game.platformSlugs!.indexOf(slug)] : undefined; }
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> { const { games } = await loadPublishedArtifact(); const slug = (await params).slug; const platform = findPlatform(games, slug); return platform ? { title: `${platform} Games` } : { title: "平台未找到" }; }
export default async function PlatformPage({ params }: { params: Promise<{ slug: string }> }) { const { games } = await loadPublishedArtifact(); const slug = (await params).slug; const platform = findPlatform(games, slug); if (!platform) notFound(); const results = games.filter((game) => game.platformSlugs?.includes(slug)); return <Container className="pt-28"><h1 className="mb-8 text-4xl font-bold">{platform} Games</h1><GameGrid games={results} /></Container>; }
