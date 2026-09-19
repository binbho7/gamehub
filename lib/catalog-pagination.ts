export const INITIAL_PAGE_SIZE = 24;

export function takeInitialPage<T>(items: T[]): T[] {
  return items.slice(0, INITIAL_PAGE_SIZE);
}

