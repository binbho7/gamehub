import Image from "next/image";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { PublishedGame } from "@/lib/site-data/contracts";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function GameHero({ game }: { game: PublishedGame }) {
  const website = game.officialLinks.find((link) => link.type === "official_website");
  const store = game.officialLinks.find((link) => link.provider.toLowerCase() === "steam" && link.type === "store") ?? game.officialLinks.find((link) => link.type === "store");
  const primaryLink = website ?? store;

  return <section className="relative min-h-[540px] overflow-hidden border-b border-white/[.08] md:min-h-[590px]">
    <Image src={game.hero} alt="" fill priority sizes="100vw" className="object-cover object-center opacity-80" />
    <div className="absolute inset-0 bg-[linear-gradient(90deg,#080b12_0%,rgba(8,11,18,.92)_38%,rgba(8,11,18,.34)_72%,rgba(8,11,18,.18)_100%),linear-gradient(0deg,#080b12_0%,rgba(8,11,18,.28)_38%,rgba(8,11,18,.08)_78%)]" />
    <div className="relative mx-auto flex min-h-[540px] w-full max-w-[1360px] items-end px-4 pb-11 pt-28 sm:px-6 md:min-h-[590px] md:items-center md:pb-0 lg:px-8">
      <div className="flex w-full flex-col items-start gap-6 md:flex-row md:items-end md:gap-9">
        <div className="relative hidden aspect-[3/4] w-[210px] shrink-0 overflow-hidden rounded-2xl border border-white/15 bg-card shadow-[0_28px_80px_rgba(0,0,0,.5)] md:block lg:w-[236px]"><Image src={game.cover} alt={`${game.title} 封面`} fill sizes="236px" className="object-cover" /></div>
        <div className="max-w-[680px] pb-1">
          <div className="mb-3 flex items-center gap-3 text-sm font-medium text-white/70"><span>{game.releaseDate.slice(0,4)}</span><span aria-hidden="true" className="size-1 rounded-full bg-primary" /><span>{game.genres[0]}</span></div>
          <h1 className="text-[clamp(2.4rem,7.8vw,4.25rem)] font-bold leading-[.98] tracking-[-.045em] text-white">{game.title}</h1>
          {game.optional.titleCn && <p className="mt-2 text-lg text-secondary-foreground sm:text-xl">{game.optional.titleCn}</p>}
          <p className="mt-5 max-w-xl text-sm leading-6 text-white/65">{game.developer} · {game.platforms.join(" / ")}</p>
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
