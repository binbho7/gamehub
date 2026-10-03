import type { Metadata, MetadataRoute } from "next";
import type { PublishedArtifact, PublishedGame } from "./site-data/contracts";

export const SITE_ORIGIN = "https://games.binbho.com";

export const ROOT_METADATA: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: {
    default: "GameHub — 发现游戏与官方资源",
    template: "%s | GameHub",
  },
  description: "查找游戏资料、官方网站和可信的官方商店入口。",
  openGraph: { siteName: "GameHub", locale: "zh_CN", type: "website" },
  robots: { index: true, follow: true },
};

export const HOME_METADATA: Metadata = {
  title: { absolute: "GameHub — 发现值得玩的游戏与官方资源" },
  description: "浏览 GameHub 收录的游戏资料、发行信息与经过验证的官方网站和商店入口。",
  alternates: { canonical: "/" },
  openGraph: {
    title: "GameHub — 发现值得玩的游戏与官方资源",
    description: "浏览游戏资料、发行信息与可信的官方入口。",
    url: "/",
    siteName: "GameHub",
    locale: "zh_CN",
    type: "website",
  },
};

export const GAMES_METADATA: Metadata = {
  title: "游戏库",
  description: "浏览 GameHub 收录的游戏、发行信息与可信的官方资源。",
  alternates: { canonical: "/games" },
};

export const SEARCH_METADATA: Metadata = {
  title: "搜索",
  description: "搜索游戏名称、开发商或出版商。",
  robots: { index: false, follow: true },
};

export const ROBOTS_METADATA: MetadataRoute.Robots = {
  rules: { userAgent: "*", allow: "/" },
  sitemap: `${SITE_ORIGIN}/sitemap.xml`,
  host: SITE_ORIGIN,
};

export function absoluteUrl(path: string): string {
  return new URL(path, `${SITE_ORIGIN}/`).toString();
}

export function buildSitemapEntries(artifact: PublishedArtifact): MetadataRoute.Sitemap {
  const lastModified = artifact.snapshotDate;
  const urls = [
    absoluteUrl("/"),
    absoluteUrl("/games"),
    ...artifact.games.toSorted((left, right) => left.slug.localeCompare(right.slug)).map((game) => absoluteUrl(`/games/${game.slug}`)),
    ...[...new Set(artifact.games.flatMap((game) => game.genreSlugs))].sort().map((slug) => absoluteUrl(`/genres/${slug}`)),
    ...[...new Set(artifact.games.flatMap((game) => game.platformSlugs))].sort().map((slug) => absoluteUrl(`/platforms/${slug}`)),
  ];

  return [...new Set(urls)].map((url) => ({ url, lastModified }));
}

export function buildTaxonomyMetadata(kind: "genre" | "platform", name: string, slug: string): Metadata {
  const isGenre = kind === "genre";
  const label = isGenre ? "类型" : "平台";
  const path = isGenre ? `/genres/${slug}` : `/platforms/${slug}`;
  return {
    title: `${name} 游戏`,
    description: `浏览 GameHub 收录的 ${name} ${label}游戏与官方资源。`,
    alternates: { canonical: path },
  };
}

export function buildGameMetadata(game: PublishedGame): Metadata {
  const description = `查看 ${game.title} 游戏介绍、发行信息、截图以及官方网站与官方商店入口。`;
  return {
    title: `${game.title} - 官网、Steam 与官方游戏信息`,
    description,
    alternates: { canonical: `/games/${game.slug}` },
    openGraph: {
      title: game.title,
      description,
      type: "website",
      url: `/games/${game.slug}`,
      images: [{ url: game.hero }],
    },
    twitter: {
      card: "summary_large_image",
      title: game.title,
      description,
      images: [game.hero],
    },
  };
}

export function buildVideoGameJsonLd(game: PublishedGame) {
  return {
    "@context": "https://schema.org",
    "@type": "VideoGame",
    name: game.title,
    description: game.description,
    url: absoluteUrl(`/games/${game.slug}`),
    image: game.hero,
    datePublished: game.releaseDate,
    genre: game.genres,
    gamePlatform: game.platforms,
    publisher: { "@type": "Organization", name: game.publisher },
    developer: { "@type": "Organization", name: game.developer },
    sameAs: [...new Set(game.officialLinks.map((link) => link.url))],
  };
}

export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
