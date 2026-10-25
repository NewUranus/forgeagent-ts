export class LRUCache<K, V> {
  private readonly capacity: number;
  private readonly entries = new Map<K, V>();

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
    this.capacity = capacity;
  }

  get(key: K): V | undefined {
    return this.entries.get(key);
  }

  set(key: K, value: V): void {
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as K;
      this.entries.delete(oldest);
    }
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
