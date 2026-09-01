import Image from "next/image";
import Link from "next/link";
import { ExternalLink, Star } from "lucide-react";
import type { Game } from "@/types/game";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function GameHero({ game }: { game: Game }) {
  const website = game.officialLinks.find((link) => link.type === "官方网站");
  const store = game.officialLinks.find((link) => link.provider === "Steam") ?? game.officialLinks.find((link) => link.type === "官方商店");
  const primaryLink = website ?? store;

  return <section className="relative min-h-[590px] overflow-hidden border-b md:min-h-[570px]">
    <Image src={game.hero} alt="" fill priority className="object-cover object-center opacity-70" />
    <div className="absolute inset-0 bg-[linear-gradient(90deg,#080b12_0%,rgba(8,11,18,.93)_35%,rgba(8,11,18,.25)_100%),linear-gradient(0deg,#080b12_0%,transparent_55%)]" />
    <div className="relative mx-auto flex min-h-[590px] w-full max-w-[1360px] items-end px-4 pb-12 pt-28 sm:px-6 md:items-center md:pb-0 lg:px-8">
      <div className="flex w-full flex-col items-start gap-6 md:flex-row md:items-end md:gap-9">
        <div className="relative hidden aspect-[3/4] w-[210px] shrink-0 overflow-hidden rounded-xl border bg-card shadow-2xl md:block lg:w-[240px]"><Image src={game.cover} alt={`${game.title} 封面`} fill sizes="240px" className="object-cover" /></div>
        <div className="max-w-2xl pb-1">
          <div className="mb-3 flex items-center gap-3 text-sm text-secondary-foreground"><span className="flex items-center gap-1 text-[#f7c66b]"><Star className="size-4 fill-current" />{game.rating.toFixed(1)}</span><span>{game.releaseDate.slice(0,4)}</span><span>{game.genres[0]}</span></div>
          <h1 className="text-4xl font-bold tracking-[-.035em] sm:text-5xl lg:text-6xl">{game.title}</h1>
          <p className="mt-2 text-lg text-secondary-foreground sm:text-xl">{game.titleCn}</p>
          <p className="mt-5 text-sm text-muted-foreground">{game.developer} · {game.platforms.join(" / ")}</p>
          <div className="mt-7 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            {primaryLink && <a href={primaryLink.url} target="_blank" rel="noreferrer" className={cn(buttonVariants({ size: "lg" }), "w-full sm:w-auto")}><ExternalLink />{website ? "访问官方网站" : `在 ${primaryLink.provider} 查看`}</a>}
            {store && store !== primaryLink && <a href={store.url} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "outline", size: "lg" }), "w-full sm:w-auto")}>在 {store.provider} 查看</a>}
          </div>
          <Link href="#official-links" className="sr-only">查看官方资源</Link>
        </div>
      </div>
    </div>
  </section>;
}
