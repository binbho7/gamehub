import Link from "next/link";
import { Container } from "./container";
import { loadPublishedArtifact } from "@/lib/site-data/source";
import { buildTaxonomyNavigation } from "@/lib/site-data/navigation";

export async function Footer() {
  const { games } = await loadPublishedArtifact();
  const platforms = games.flatMap((game) => game.platforms.map((name, index) => ({ name, slug: game.platformSlugs[index]! })));
  const genres = games.flatMap((game) => game.genres.map((name, index) => ({ name, slug: game.genreSlugs[index]! })));
  const taxonomy = buildTaxonomyNavigation(platforms, genres);
  return <footer className="mt-20 border-t py-10"><Container className="flex flex-col gap-5 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"><div><span className="font-bold text-foreground">Game<span className="text-primary">Hub</span></span><p className="mt-1">发现游戏，直达可信的官方资源。</p></div><nav className="flex flex-wrap gap-5"><Link href="/games">游戏库</Link>{[...taxonomy.genres, ...taxonomy.platforms].map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}</nav><p>© 2026 GameHub</p></Container></footer>;
}
