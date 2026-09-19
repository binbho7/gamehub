export type TaxonomyRecord = { name: string; slug: string };
export type TaxonomyLink = { label: string; href: string };

export function buildTaxonomyNavigation(platforms: TaxonomyRecord[], genres: TaxonomyRecord[]): { platforms: TaxonomyLink[]; genres: TaxonomyLink[]; desktop: TaxonomyLink[]; mobile: TaxonomyLink[] } {
  const uniquePlatforms = [...new Map(platforms.map((item) => [item.slug, item])).values()].sort((a, b) => a.slug.localeCompare(b.slug));
  const uniqueGenres = [...new Map(genres.map((item) => [item.slug, item])).values()].sort((a, b) => a.slug.localeCompare(b.slug));
  const platformLinks = uniquePlatforms.map((item) => ({ label: item.name === "Windows" ? "PC" : item.name, href: `/platforms/${item.slug}` }));
  const genreLinks = uniqueGenres.map((item) => ({ label: item.name, href: `/genres/${item.slug}` }));
  const links = [...platformLinks, ...genreLinks];
  return { platforms: platformLinks, genres: genreLinks, desktop: links, mobile: links };
}
