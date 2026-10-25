/** Load every id; results keep the order of `ids`, and any failure rejects the whole call. */
export async function loadAll<T>(ids: string[], fetchOne: (id: string) => Promise<T>): Promise<T[]> {
  return Promise.all(ids.map((id) => fetchOne(id)));
}
