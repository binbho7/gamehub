import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Container } from "@/components/layout/container";
import Link from "next/link";
import { GameGrid } from "@/components/game/game-grid";
import { INITIAL_PAGE_SIZE } from "@/lib/catalog-pagination";
import { loadPublishedArtifact } from "@/lib/site-data/source";
export async function generateStaticParams() { const { games } = await loadPublishedArtifact(); return [...new Set(games.flatMap((game) => game.genreSlugs ?? []))].map((slug) => ({ slug })); }
function findGenre(games: Awaited<ReturnType<typeof loadPublishedArtifact>>["games"], slug: string) { const game = games.find((item) => item.genreSlugs?.includes(slug)); return game ? game.genres[game.genreSlugs!.indexOf(slug)] : undefined; }
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> { const { games } = await loadPublishedArtifact(); const slug = (await params).slug; const genre = findGenre(games, slug); return genre ? { title: `${genre} Games`, alternates: { canonical: `/genres/${slug}` } } : { title: "类型未找到" }; }
export default async function GenrePage({ params }: { params: Promise<{ slug: string }> }) { const { games } = await loadPublishedArtifact(); const slug = (await params).slug; const genre = findGenre(games, slug); if (!genre) notFound(); const results = games.filter((game) => game.genreSlugs?.includes(slug)); return <Container className="pt-28"><h1 className="mb-8 text-4xl font-bold">{genre} Games</h1><GameGrid games={results.slice(0, INITIAL_PAGE_SIZE)} />{results.length > INITIAL_PAGE_SIZE && <Link className="mx-auto mt-8 block w-fit rounded-lg border px-5 py-2 text-sm" href={`/games?genre=${encodeURIComponent(genre)}`}>查看更多</Link>}</Container>; }
