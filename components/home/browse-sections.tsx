import Link from "next/link";
import { Monitor, Gamepad2, Joystick } from "lucide-react";
import type { PublishedGame } from "@/lib/site-data/contracts";

const platformPresentation: Record<string, { label: string; icon: typeof Monitor }> = {
  Windows: { label: "PC", icon: Monitor },
  "PlayStation 5": { label: "PlayStation 5", icon: Gamepad2 },
  "Xbox Series X|S": { label: "Xbox Series X|S", icon: Joystick },
};

const slugify = (value: string) => value.toLowerCase().replaceAll(" ", "-").replaceAll("|", "");

export function PlatformBrowse({ games }: { games: PublishedGame[] }) { const platforms = [...new Set(games.flatMap((game) => game.platforms))].sort(); return <div className="grid gap-3 md:grid-cols-3">{platforms.map((name) => { const presentation = platformPresentation[name] ?? { label: name, icon: Monitor }; const Icon = presentation.icon; const slug = slugify(name); const count = games.filter((game) => game.platforms.includes(name)).length; return <Link key={slug} href={`/platforms/${slug}`} className="group flex min-h-36 flex-col justify-between rounded-xl border bg-card p-5 transition hover:border-primary/50"><Icon className="size-6 text-primary" /><div><h3 className="font-semibold">{presentation.label}</h3><p className="mt-1 text-sm text-muted-foreground">{count} 款游戏</p></div></Link>; })}</div>; }

export function GenreBrowse({ genres }: { genres: string[] }) { return <div className="flex flex-wrap gap-2">{genres.map((genre) => <Link key={genre} href={`/genres/${genre.toLowerCase().replaceAll(" ", "-")}`} className="inline-flex h-9 items-center rounded-lg border bg-card px-4 text-sm text-secondary-foreground transition hover:border-primary/50 hover:text-primary">{genre}</Link>)}</div>; }
