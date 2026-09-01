import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Container } from "@/components/layout/container";
import { GameGrid } from "@/components/game/game-grid";
import { games, genres } from "@/lib/mock-data";

const slugify = (value: string) => value.toLowerCase().replaceAll(" ", "-");
export function generateStaticParams() { return genres.map((genre) => ({ slug: slugify(genre) })); }
export async function generateMetadata({ params }: { params: Promise<{slug:string}> }): Promise<Metadata> { const slug=(await params).slug; const genre=genres.find(g=>slugify(g)===slug); return genre ? { title: `${genre} Games`, description: `探索 GameHub 收录的 ${genre} 类游戏与官方资源。`, alternates: { canonical: `/genres/${slug}` } } : { title: "类型未找到" }; }
export default async function GenrePage({ params }: { params: Promise<{slug:string}> }) { const slug=(await params).slug; const genre=genres.find(g=>slugify(g)===slug); if(!genre) notFound(); const results=games.filter(g=>g.genres.includes(genre)); return <Container className="pt-28"><div className="mb-10 border-b pb-9"><p className="text-sm font-medium text-primary">按类型浏览</p><h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">{genre} Games</h1><p className="mt-3 text-lg text-secondary-foreground">{genre} 游戏</p><p className="mt-5 max-w-2xl text-sm leading-7 text-muted-foreground">探索 GameHub 收录的 {genre} 类电子游戏，查看游戏资料并访问可信的官方网站和官方商店。</p></div><div className="mb-6 flex gap-6 text-sm"><span className="font-medium text-primary">热门</span><span className="text-muted-foreground">最新</span><span className="text-muted-foreground">全部 · {results.length}</span></div><GameGrid games={results} /></Container>; }
