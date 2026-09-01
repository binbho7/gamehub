export type RequirementSet = {
  os: string;
  cpu: string;
  ram: string;
  gpu: string;
  directX: string;
  storage: string;
};

export type OfficialLink = {
  provider: string;
  platform: string;
  type: "官方网站" | "官方商店";
  url: string;
};

export type ReleaseStatus = "released" | "upcoming";
export type GameSort = "popular" | "rating" | "newest" | "oldest" | "title";

export type Game = {
  id: string;
  slug: string;
  title: string;
  titleCn: string;
  steamAppId: string;
  cover: string;
  hero: string;
  developer: string;
  publisher: string;
  releaseDate: string;
  genres: string[];
  platforms: string[];
  rating: number;
  description: string;
  screenshots: string[];
  systemRequirements: { minimum: RequirementSet; recommended: RequirementSet };
  officialLinks: OfficialLink[];
  status: ReleaseStatus;
  isFree: boolean;
  modes: string[];
  controllerSupport: boolean;
  trailerId?: string;
};
