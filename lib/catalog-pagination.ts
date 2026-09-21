export const INITIAL_PAGE_SIZE = 24;

export function takeInitialPage<T>(items: T[]): T[] {
  return items.slice(0, INITIAL_PAGE_SIZE);
}

export function nextPageSize(visibleCount: number): number {
  return visibleCount + INITIAL_PAGE_SIZE;
}

export function takeVisiblePage<T>(items: T[], visibleCount: number): T[] {
  return items.slice(0, Math.max(INITIAL_PAGE_SIZE, visibleCount));
}
