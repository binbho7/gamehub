import Link from "next/link";
import { Monitor, Gamepad2, Joystick } from "lucide-react";
import { games, genres } from "@/lib/mock-data";

const platforms = [{ name: "PC", slug: "pc", icon: Monitor }, { name: "PlayStation 5", slug: "playstation-5", icon: Gamepad2 }, { name: "Xbox Series X|S", slug: "xbox-series-xs", icon: Joystick }];

export function PlatformBrowse() { return <div className="grid gap-3 md:grid-cols-3">{platforms.map(({ name, slug, icon: Icon }) => { const count = games.filter((game) => game.platforms.includes(name)).length; return <Link key={slug} href={`/platforms/${slug}`} className="group flex min-h-36 flex-col justify-between rounded-xl border bg-card p-5 transition hover:border-primary/50"><Icon className="size-6 text-primary" /><div><h3 className="font-semibold">{name}</h3><p className="mt-1 text-sm text-muted-foreground">{count} 款游戏</p></div></Link>; })}</div>; }

export function GenreBrowse() { return <div className="flex flex-wrap gap-2">{genres.map((genre) => <Link key={genre} href={`/genres/${genre.toLowerCase().replaceAll(" ", "-")}`} className="inline-flex h-9 items-center rounded-lg border bg-card px-4 text-sm text-secondary-foreground transition hover:border-primary/50 hover:text-primary">{genre}</Link>)}</div>; }
