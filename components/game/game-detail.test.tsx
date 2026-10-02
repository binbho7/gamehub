import { renderToStaticMarkup } from "react-dom/server";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PublishedGame } from "@/lib/site-data/contracts";

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children?: ReactNode }) => <button {...props}>{children}</button>,
}));
vi.mock("@/lib/utils", () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" "),
}));

import { GameGallery } from "./game-gallery";
import { GameInfo } from "./game-info";

const game: PublishedGame = {
  slug: "elden-ring",
  title: "ELDEN RING",
  description: "Rise, Tarnished.",
  releaseDate: "2022-02-25",
  status: "released",
  developer: "FromSoftware, Inc.",
  publisher: "Bandai Namco Entertainment",
  genres: ["Action", "RPG"],
  genreSlugs: ["action", "rpg"],
  platforms: ["Windows", "PlayStation 5"],
  platformSlugs: ["windows", "playstation-5"],
  cover: "https://images.igdb.com/igdb/image/upload/t_cover_big/co4jni.jpg",
  hero: "https://images.igdb.com/igdb/image/upload/t_1080p/sc8m2a.jpg",
  screenshots: [],
  officialLinks: [
    {
      provider: "website",
      type: "official_website",
      url: "https://en.bandainamcoent.eu/elden-ring/elden-ring",
    },
  ],
  videos: [],
  optional: {
    titleCn: null,
    rating: null,
    systemRequirements: null,
    modes: null,
    controllerSupport: null,
    isFree: null,
  },
};

describe("game detail presentation", () => {
  it("renders only the five information rows backed by published data", () => {
    const html = renderToStaticMarkup(<GameInfo game={game} />);

    for (const label of ["开发商", "发行商", "发布日期", "类型", "平台"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain("模式");
    expect(html).not.toContain("控制器");
    expect(html).not.toContain("暂无数据");
  });

  it("bounds the inline gallery while advertising access to every screenshot", () => {
    const images = Array.from(
      { length: 7 },
      (_, index) => `https://images.igdb.com/igdb/image/upload/t_1080p/screenshot-${index + 1}.jpg`,
    );
    const html = renderToStaticMarkup(<GameGallery images={images} title={game.title} />);

    expect((html.match(/<button/g) ?? [])).toHaveLength(5);
    expect(html).toContain("查看全部 7 张");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("打开第 1 张截图");
    expect(html).toContain('data-gallery-trigger-index="0"');
  });
});
