import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Search } from "lucide-react";
import type { PublishedGame } from "@/lib/site-data/contracts";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function HomeHero({ game }: { game: PublishedGame }) {
  const store = game.officialLinks.find((link) => link.type !== "official_website");
  return <section className="relative min-h-[540px] overflow-hidden border-b border-white/10 md:min-h-[600px]"><Image src={game.hero} alt="" fill priority className="object-cover object-center opacity-90" /><div className="absolute inset-0 bg-[linear-gradient(90deg,#080b12_0%,rgba(8,11,18,.83)_35%,rgba(8,11,18,.18)_76%,rgba(8,11,18,.08)_100%),linear-gradient(0deg,#080b12_0%,transparent_46%,rgba(8,11,18,.18)_100%)]" /><div className="relative mx-auto flex min-h-[540px] max-w-[1360px] items-end px-4 pb-16 pt-28 sm:px-6 md:min-h-[600px] md:items-center md:pb-4 lg:px-8"><div className="max-w-[660px]"><div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold uppercase tracking-[.12em] text-secondary-foreground sm:text-sm"><span>{game.genres[0]}</span><span className="size-1 rounded-full bg-primary" /><span>{game.developer}</span></div><h1 className="max-w-3xl text-[clamp(2.6rem,9vw,4.8rem)] font-black uppercase leading-[.92] tracking-[-.055em] text-white [text-wrap:balance]">{game.title}</h1><p className="mt-5 max-w-[600px] line-clamp-3 text-sm leading-6 text-secondary-foreground sm:text-base sm:leading-7 md:line-clamp-4">{game.description}</p><div className="mt-7 flex flex-wrap gap-3"><Link href={`/games/${game.slug}`} className={cn(buttonVariants({ size: "lg" }), "shadow-[0_10px_30px_rgba(76,141,255,.25)]")}>查看游戏<ArrowRight /></Link>{store && <a href={store.url} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "outline", size: "lg" }), "border-white/25 bg-black/20 backdrop-blur-sm hover:bg-white/10")}>{store.provider}</a>}</div></div></div></section>;
}

export function HomeSearch() {
  return <div className="relative z-10 mx-auto -mt-7 max-w-3xl px-4 sm:px-6"><Link href="/search" className="group flex h-14 items-center gap-3 rounded-xl border border-white/15 bg-[#111824]/95 px-4 text-sm text-muted-foreground shadow-[0_18px_55px_rgba(0,0,0,.45)] backdrop-blur-xl transition hover:border-primary/60 hover:bg-[#151e2c] hover:text-secondary-foreground sm:px-5"><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary transition group-hover:bg-primary/15"><Search className="size-[18px]" /></span><span className="truncate">搜索游戏、开发商或出版商</span><kbd className="ml-auto hidden rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-muted-foreground sm:block">⌘ K</kbd></Link></div>;
}
