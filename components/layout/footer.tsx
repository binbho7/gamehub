import Link from "next/link";
import { Container } from "./container";
import { loadPublishedArtifact } from "@/lib/site-data/source";
import { buildTaxonomyNavigation } from "@/lib/site-data/navigation";

export async function Footer() {
  const { games } = await loadPublishedArtifact();
  const platforms = games.flatMap((game) => game.platforms.map((name, index) => ({ name, slug: game.platformSlugs[index]! })));
  const genres = games.flatMap((game) => game.genres.map((name, index) => ({ name, slug: game.genreSlugs[index]! })));
  const taxonomy = buildTaxonomyNavigation(platforms, genres);
  return <footer className="mt-20 border-t border-white/10 bg-[#070a10] py-10 sm:py-12"><Container className="grid gap-8 text-sm text-muted-foreground md:grid-cols-[1fr_2fr_auto] md:items-start"><div><span className="text-lg font-black tracking-[-.04em] text-foreground">Game<span className="text-primary">Hub</span></span><p className="mt-2 max-w-xs leading-6">发现游戏，直达可信的官方资源。</p></div><nav className="flex flex-wrap gap-x-5 gap-y-3" aria-label="页脚导航"><Link className="font-medium text-secondary-foreground transition hover:text-primary" href="/games">游戏库</Link>{[...taxonomy.genres, ...taxonomy.platforms].map((item) => <Link className="transition hover:text-primary" key={item.href} href={item.href}>{item.label}</Link>)}</nav><p className="whitespace-nowrap md:text-right">© 2026 GameHub</p></Container></footer>;
}
