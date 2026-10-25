export function pageCount(total: number, size: number): number {
  if (size <= 0) throw new RangeError("size must be positive");
  return Math.floor(total / size);
}

export function pageItems<T>(items: T[], page: number, size: number): T[] {
  const pages = pageCount(items.length, size);
  if (page < 1 || page > pages) return [];
  return items.slice((page - 1) * size, page * size);
}
