import type { Game, OfficialLink, RequirementSet } from "../types/game";

const steamAsset = (appId: string, file: string) =>
  `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appId}/${file}`;

const minimum: RequirementSet = {
  os: "Windows 10 64-bit",
  cpu: "Intel Core i5-8400 / AMD Ryzen 5 1600",
  ram: "16 GB",
  gpu: "NVIDIA GTX 1060 6GB / AMD RX 580 8GB",
  directX: "Version 12",
  storage: "130 GB available space",
};

const recommended: RequirementSet = {
  os: "Windows 11 64-bit",
  cpu: "Intel Core i7-9700 / AMD Ryzen 5 5500",
  ram: "16 GB",
  gpu: "NVIDIA RTX 2060 / AMD RX 5700 XT",
  directX: "Version 12",
  storage: "130 GB SSD available space",
};

const links = (appId: string): OfficialLink[] => [{
  provider: "Steam",
  platform: "PC",
  type: "官方商店",
  url: `https://store.steampowered.com/app/${appId}`,
}];

type Seed = Omit<Game, "id" | "cover" | "hero" | "screenshots" | "systemRequirements" | "officialLinks" | "modes" | "controllerSupport"> & {
  officialLinks?: OfficialLink[];
  modes?: string[];
  controllerSupport?: boolean;
};

const makeGame = (seed: Seed, index: number): Game => ({
  ...seed,
  id: String(index + 1),
  cover: steamAsset(seed.steamAppId, "library_600x900_2x.jpg"),
  hero: steamAsset(seed.steamAppId, "library_hero.jpg"),
  screenshots: [
    steamAsset(seed.steamAppId, "header.jpg"),
    steamAsset(seed.steamAppId, "library_hero.jpg"),
    steamAsset(seed.steamAppId, "page_bg_raw.jpg"),
  ],
  systemRequirements: { minimum, recommended },
  officialLinks: seed.officialLinks ?? links(seed.steamAppId),
  modes: seed.modes ?? ["Single Player"],
  controllerSupport: seed.controllerSupport ?? true,
});

const gameSeeds: Seed[] = [
  {
    slug: "black-myth-wukong", title: "Black Myth: Wukong", titleCn: "黑神话：悟空", steamAppId: "2358720",
    developer: "Game Science", publisher: "Game Science", releaseDate: "2024-08-20",
    genres: ["Action RPG", "Adventure"], platforms: ["PC", "PlayStation 5", "Xbox Series X|S"], rating: 9.2,
    description: "一款以中国神话为背景的动作角色扮演游戏。玩家将化身天命人，踏上一段充满危险与惊奇的西游之路。",
    status: "released", isFree: false, trailerId: "u83VdXAVq08",
    officialLinks: [
      { provider: "Black Myth: Wukong", platform: "Web", type: "官方网站", url: "https://www.heishenhua.com" },
      { provider: "Steam", platform: "PC", type: "官方商店", url: "https://store.steampowered.com/app/2358720/Black_Myth_Wukong/" },
      { provider: "Epic Games", platform: "PC", type: "官方商店", url: "https://store.epicgames.com" },
      { provider: "PlayStation Store", platform: "PlayStation 5", type: "官方商店", url: "https://store.playstation.com" },
    ],
  },
  {
    slug: "elden-ring", title: "Elden Ring", titleCn: "艾尔登法环", steamAppId: "1245620", developer: "FromSoftware", publisher: "Bandai Namco",
    releaseDate: "2022-02-25", genres: ["Action RPG", "Open World"], platforms: ["PC", "PlayStation 5", "Xbox Series X|S"], rating: 9.5,
    description: "在广阔而神秘的交界地探索、战斗，并以自己的方式成为艾尔登之王。", status: "released", isFree: false,
  },
  {
    slug: "cyberpunk-2077", title: "Cyberpunk 2077", titleCn: "赛博朋克 2077", steamAppId: "1091500", developer: "CD Projekt Red", publisher: "CD Projekt",
    releaseDate: "2020-12-10", genres: ["Action RPG", "Open World"], platforms: ["PC", "PlayStation 5", "Xbox Series X|S"], rating: 8.8,
    description: "进入夜之城，在这座痴迷力量、魅力和义体改造的巨型都市中书写属于你的传奇。", status: "released", isFree: false,
  },
  {
    slug: "baldurs-gate-3", title: "Baldur's Gate 3", titleCn: "博德之门 3", steamAppId: "1086940", developer: "Larian Studios", publisher: "Larian Studios",
    releaseDate: "2023-08-03", genres: ["RPG", "Strategy"], platforms: ["PC", "PlayStation 5", "Xbox Series X|S"], rating: 9.6,
    description: "召集队伍重返被遗忘的国度，在自由而深刻的角色扮演旅途中决定众人的命运。", status: "released", isFree: false,
  },
  {
    slug: "red-dead-redemption-2", title: "Red Dead Redemption 2", titleCn: "荒野大镖客：救赎 2", steamAppId: "1174180", developer: "Rockstar Games", publisher: "Rockstar Games",
    releaseDate: "2018-10-26", genres: ["Action", "Open World"], platforms: ["PC", "PlayStation 4", "Xbox One"], rating: 9.4,
    description: "在美国蛮荒时代落幕之际，体验亚瑟·摩根与范德林德帮派的史诗故事。", status: "released", isFree: false,
  },
  {
    slug: "grand-theft-auto-v", title: "Grand Theft Auto V", titleCn: "侠盗猎车手 V", steamAppId: "271590", developer: "Rockstar North", publisher: "Rockstar Games",
    releaseDate: "2013-09-17", genres: ["Action", "Open World"], platforms: ["PC", "PlayStation 5", "Xbox Series X|S"], rating: 9.1,
    description: "三位截然不同的罪犯在洛圣都展开一连串大胆而危险的行动。", status: "released", isFree: false,
  },
  {
    slug: "the-witcher-3", title: "The Witcher 3: Wild Hunt", titleCn: "巫师 3：狂猎", steamAppId: "292030", developer: "CD Projekt Red", publisher: "CD Projekt",
    releaseDate: "2015-05-19", genres: ["Action RPG", "Open World"], platforms: ["PC", "PlayStation 5", "Xbox Series X|S", "Nintendo Switch"], rating: 9.3,
    description: "扮演职业猎魔人杰洛特，在战火纷飞的奇幻大陆寻找预言之子。", status: "released", isFree: false,
  },
  {
    slug: "hogwarts-legacy", title: "Hogwarts Legacy", titleCn: "霍格沃茨之遗", steamAppId: "990080", developer: "Avalanche Software", publisher: "Warner Bros. Games",
    releaseDate: "2023-02-10", genres: ["Action RPG", "Adventure"], platforms: ["PC", "PlayStation 5", "Xbox Series X|S", "Nintendo Switch"], rating: 8.4,
    description: "在十九世纪的魔法世界中自由探索，塑造属于自己的巫师传奇。", status: "released", isFree: false,
  },
  {
    slug: "helldivers-2", title: "Helldivers 2", titleCn: "绝地潜兵 2", steamAppId: "553850", developer: "Arrowhead Game Studios", publisher: "PlayStation Publishing",
    releaseDate: "2024-02-08", genres: ["Shooter", "Co-op"], platforms: ["PC", "PlayStation 5"], rating: 8.6,
    description: "与最多三名战友并肩作战，为超级地球在银河战争中传播自由与管理式民主。", status: "released", isFree: false,
  },
  {
    slug: "monster-hunter-wilds", title: "Monster Hunter Wilds", titleCn: "怪物猎人：荒野", steamAppId: "2246340", developer: "Capcom", publisher: "Capcom",
    releaseDate: "2025-02-28", genres: ["Action RPG", "Co-op"], platforms: ["PC", "PlayStation 5", "Xbox Series X|S"], rating: 8.7,
    description: "在瞬息万变的禁地中追踪强大怪物，理解生态并锻造更强的装备。", status: "released", isFree: false,
  },
  {
    slug: "forza-horizon-5", title: "Forza Horizon 5", titleCn: "极限竞速：地平线 5", steamAppId: "1551360", developer: "Playground Games", publisher: "Xbox Game Studios",
    releaseDate: "2021-11-09", genres: ["Racing", "Open World"], platforms: ["PC", "Xbox Series X|S"], rating: 8.9,
    description: "驾驶数百辆传奇汽车，在墨西哥充满活力且不断变化的开放世界中探索竞速。", status: "released", isFree: false,
  },
  {
    slug: "resident-evil-4", title: "Resident Evil 4", titleCn: "生化危机 4 重制版", steamAppId: "2050650", developer: "Capcom", publisher: "Capcom",
    releaseDate: "2023-03-24", genres: ["Survival Horror", "Action"], platforms: ["PC", "PlayStation 5", "Xbox Series X|S"], rating: 9.0,
    description: "经典生存恐怖作品以现代玩法、重构故事与细腻画面焕然新生。", status: "released", isFree: false,
  },
  {
    slug: "counter-strike-2", title: "Counter-Strike 2", titleCn: "反恐精英 2", steamAppId: "730", developer: "Valve", publisher: "Valve",
    releaseDate: "2023-09-27", genres: ["Shooter", "Competitive"], platforms: ["PC"], rating: 8.5,
    description: "Counter-Strike 的新时代，以 Source 2 引擎带来动态烟雾、全新地图与精确响应。", status: "released", isFree: true,
  },
  {
    slug: "warframe", title: "Warframe", titleCn: "星际战甲", steamAppId: "230410", developer: "Digital Extremes", publisher: "Digital Extremes",
    releaseDate: "2013-03-25", genres: ["Action", "Co-op"], platforms: ["PC", "PlayStation 5", "Xbox Series X|S", "Nintendo Switch"], rating: 8.3,
    description: "驾驭 Warframe 的强大力量，与好友一同探索不断扩展的太阳系。", status: "released", isFree: true,
  },
  {
    slug: "hollow-knight-silksong", title: "Hollow Knight: Silksong", titleCn: "空洞骑士：丝之歌", steamAppId: "1030300", developer: "Team Cherry", publisher: "Team Cherry",
    releaseDate: "2027-03-01", genres: ["Action", "Adventure", "Indie"], platforms: ["PC", "PlayStation 5", "Xbox Series X|S", "Nintendo Switch"], rating: 9.0,
    description: "扮演致命猎手大黄蜂，探索由丝线与歌声统治的陌生王国。", status: "upcoming", isFree: false,
  },
  {
    slug: "subnautica-2", title: "Subnautica 2", titleCn: "深海迷航 2", steamAppId: "1962700", developer: "Unknown Worlds", publisher: "Krafton",
    releaseDate: "2027-06-15", genres: ["Adventure", "Survival", "Open World"], platforms: ["PC", "Xbox Series X|S"], rating: 8.2,
    description: "潜入全新的海洋世界，建造基地、研究生命并在未知生态中生存。", status: "upcoming", isFree: false,
  },
];

export const games: Game[] = gameSeeds.map(makeGame);

export const genres = [...new Set(games.flatMap((game) => game.genres))].sort();
export const platforms = [...new Set(games.flatMap((game) => game.platforms))].sort();
