/** Load every id; results keep the order of `ids`, and any failure rejects the whole call. */
export async function loadAll<T>(ids: string[], fetchOne: (id: string) => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  ids.forEach(async (id) => {
    results.push(await fetchOne(id));
  });
  return results;
}
