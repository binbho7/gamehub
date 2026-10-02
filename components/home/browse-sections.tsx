import Link from "next/link";
import { Monitor, Gamepad2, Joystick } from "lucide-react";
import type { PublishedGame } from "@/lib/site-data/contracts";

const platformPresentation: Record<string, { label: string; icon: typeof Monitor }> = {
  Windows: { label: "PC", icon: Monitor },
  "PlayStation 5": { label: "PlayStation 5", icon: Gamepad2 },
  "Xbox Series X|S": { label: "Xbox Series X|S", icon: Joystick },
};


export function PlatformBrowse({ games }: { games: PublishedGame[] }) { const platforms = [...new Map(games.flatMap((game) => game.platforms.map((name, index) => [game.platformSlugs?.[index], name] as const)).filter(([slug]) => Boolean(slug))).entries()].sort(([left], [right]) => left!.localeCompare(right!)); return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{platforms.map(([slug, name]) => { const presentation = platformPresentation[name] ?? { label: name, icon: Monitor }; const Icon = presentation.icon; const count = games.filter((game) => game.platforms.includes(name)).length; return <Link key={slug} href={`/platforms/${slug}`} className="group relative flex min-h-32 overflow-hidden rounded-xl border border-white/10 bg-[linear-gradient(135deg,#141d2b,#0d131d)] p-5 transition duration-300 hover:-translate-y-0.5 hover:border-primary/45 hover:shadow-[0_16px_40px_rgba(0,0,0,.25)]"><div className="flex w-full items-center gap-4"><span className="grid size-12 shrink-0 place-items-center rounded-xl border border-primary/15 bg-primary/10 text-primary transition group-hover:bg-primary/15"><Icon className="size-6" /></span><div className="min-w-0"><h3 className="truncate text-base font-bold">{presentation.label}</h3><p className="mt-1 text-sm text-muted-foreground">{count} 款游戏</p></div><span className="ml-auto text-xl text-muted-foreground transition group-hover:translate-x-1 group-hover:text-primary" aria-hidden="true">→</span></div></Link>; })}</div>; }

export function GenreBrowse({ genres }: { genres: Array<{ name: string; slug: string }> }) { return <div className="flex flex-wrap gap-2.5">{genres.map((genre) => <Link key={genre.slug} href={`/genres/${genre.slug}`} className="inline-flex min-h-10 items-center rounded-full border border-white/10 bg-card px-4 text-sm font-medium text-secondary-foreground transition hover:border-primary/45 hover:bg-primary/10 hover:text-primary">{genre.name}</Link>)}</div>; }
