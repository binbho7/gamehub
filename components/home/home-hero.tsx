import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Search, Star } from "lucide-react";
import type { Game } from "@/types/game";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function HomeHero({ game }: { game: Game }) {
  const store = game.officialLinks.find((link) => link.type === "官方商店");
  return <section className="relative min-h-[520px] overflow-hidden border-b md:min-h-[570px]"><Image src={game.hero} alt="" fill priority className="object-cover opacity-80" /><div className="absolute inset-0 bg-[linear-gradient(90deg,#080b12_0%,rgba(8,11,18,.88)_42%,rgba(8,11,18,.2)_100%),linear-gradient(0deg,#080b12_0%,transparent_48%)]" /><div className="relative mx-auto flex min-h-[520px] max-w-[1360px] items-end px-4 pb-12 pt-28 sm:px-6 md:min-h-[570px] md:items-center md:pb-0 lg:px-8"><div className="max-w-2xl"><div className="mb-4 flex items-center gap-3 text-sm text-secondary-foreground"><span>{game.genres[0]}</span><span>·</span><span>{game.developer}</span><span className="flex items-center gap-1 text-[#f7c66b]"><Star className="size-4 fill-current" />{game.rating}</span></div><h1 className="max-w-3xl text-5xl font-bold uppercase tracking-[-.05em] sm:text-6xl lg:text-7xl">{game.title}</h1><p className="mt-5 max-w-xl text-sm leading-7 text-secondary-foreground sm:text-base">{game.description}</p><div className="mt-7 flex flex-wrap gap-3"><Link href={`/games/${game.slug}`} className={cn(buttonVariants({ size: "lg" }))}>查看游戏<ArrowRight /></Link>{store && <a href={store.url} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "outline", size: "lg" }))}>{store.provider}</a>}</div></div></div></section>;
}

export function HomeSearch() {
  return <div className="relative mx-auto -mt-7 max-w-3xl px-4 sm:px-6"><Link href="/search" className="flex h-14 items-center gap-3 rounded-xl border bg-[#121824]/95 px-5 text-sm text-muted-foreground shadow-2xl backdrop-blur transition hover:border-primary/50 hover:text-secondary-foreground"><Search className="size-5 text-primary" /><span>搜索游戏、开发商或 Steam App ID</span><kbd className="ml-auto hidden rounded border bg-muted px-2 py-1 text-xs sm:block">⌘ K</kbd></Link></div>;
}
