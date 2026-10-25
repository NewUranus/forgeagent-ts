import { createHash } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import { checkVector, type SearchOptions, type VectorPoint, type VectorStore } from "./vector-store.js";

// Qdrant backend for VectorStore. The server runs separately (`npm run qdrant`, a native binary,
// no Docker). Distance is cosine; Qdrant normalizes on insert, which is a no-op for our unit vectors.
//
// Qdrant point ids must be unsigned integers or UUIDs, so each string id maps to a UUID derived from
// its SHA-256 and the original id travels in the payload. Upserts are idempotent for the same id.

export const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const BATCH = 256;

export interface QdrantOptions {
  collection: string;
  dimension: number;
  url?: string;
  /** HNSW graph: m = links per node, ef_construct = candidate list while building. Qdrant defaults: 16 / 100. */
  hnsw?: { m?: number; ef_construct?: number };
  /**
   * Qdrant keeps segments under indexing_threshold (20 MB of vectors by default) as a plain
   * full scan and never builds HNSW for them. Set this to build the graph for small collections too.
   */
  forceIndex?: boolean;
  /** int8 scalar quantization kept in RAM; queries rescore the top candidates with the original vectors. */
  quantization?: "int8";
  /** Keep the original float32 vectors on disk (memory-mapped) instead of in RAM. */
  onDisk?: boolean;
}

export function pointId(id: string) {
  const hex = createHash("sha256").update(id).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class QdrantStore implements VectorStore {
  readonly name = "qdrant";
  readonly dimension: number;
  readonly collection: string;

  private constructor(private client: QdrantClient, private options: QdrantOptions) {
    this.dimension = options.dimension;
    this.collection = options.collection;
  }

  /** Opens the collection, creating it when missing; with recreate, drops any existing one first. */
  static async open(options: QdrantOptions & { recreate?: boolean }) {
    const url = options.url ?? QDRANT_URL;
    const client = new QdrantClient({ url, checkCompatibility: false });
    let exists: boolean;
    try {
      ({ exists } = await client.collectionExists(options.collection));
    } catch (error) {
      throw new Error(`无法连接 Qdrant（${url}），请先运行 npm run qdrant：${String(error).slice(0, 200)}`);
    }
    if (exists && options.recreate) await client.deleteCollection(options.collection);
    if (!exists || options.recreate) {
      await client.createCollection(options.collection, {
        vectors: { size: options.dimension, distance: "Cosine", on_disk: options.onDisk ?? false },
        hnsw_config: { m: options.hnsw?.m ?? 16, ef_construct: options.hnsw?.ef_construct ?? 100 },
        ...(options.forceIndex ? { optimizers_config: { indexing_threshold: 1 } } : {}),
        ...(options.quantization ? { quantization_config: { scalar: { type: "int8", always_ram: true } } } : {}),
      });
    } else {
      const info = await client.getCollection(options.collection);
      const vectors = info.config.params.vectors as { size?: number } | undefined;
      if (vectors?.size !== options.dimension) throw new Error(`Qdrant 集合 ${options.collection} 的维度是 ${vectors?.size}，需要 ${options.dimension}`);
    }
    return new QdrantStore(client, options);
  }

  /**
   * Make the collection hold exactly these points. The collection name should identify the content
   * (e.g. include a hash of the index file): a collection with the same number of points is reused
   * as is, anything else is rebuilt.
   */
  static async sync(options: QdrantOptions, points: VectorPoint[]) {
    const store = await QdrantStore.open(options);
    if ((await store.count()) === points.length) return { store, uploaded: 0 };
    const fresh = await QdrantStore.open({ ...options, recreate: true });
    await fresh.upsert(points);
    await fresh.waitIndexed();
    return { store: fresh, uploaded: points.length };
  }

  async upsert(points: VectorPoint[], concurrency = 4) {
    for (const point of points) checkVector(point.vector, this.dimension);
    const batches: VectorPoint[][] = [];
    for (let start = 0; start < points.length; start += BATCH) batches.push(points.slice(start, start + BATCH));
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        await this.client.upsert(this.collection, {
          wait: true,
          points: batch.map((point) => ({ id: pointId(point.id), vector: point.vector, payload: { id: point.id } })),
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  }

  /** Wait until the optimizer has finished (status green) and, with forceIndex, the HNSW graph covers every point. */
  async waitIndexed(timeoutMs = 30 * 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const info = await this.client.getCollection(this.collection);
      const points = info.points_count ?? 0;
      const indexed = info.indexed_vectors_count ?? 0;
      if (info.status === "green" && (!this.options.forceIndex || indexed >= points)) return { points, indexed };
      if (Date.now() > deadline) throw new Error(`等待 Qdrant 建索引超时：${indexed}/${points}，状态 ${info.status}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async search(vector: number[], k: number, options: SearchOptions = {}) {
    checkVector(vector, this.dimension);
    const { points } = await this.client.query(this.collection, {
      query: vector,
      limit: k,
      with_payload: ["id"],
      params: {
        ...(options.ef !== undefined ? { hnsw_ef: options.ef } : {}),
        ...(options.exact ? { exact: true } : {}),
        ...(this.options.quantization ? { quantization: { rescore: true, oversampling: 2 } } : {}),
      },
    });
    return points.map((point) => ({ id: String(point.payload?.id), score: point.score }));
  }

  async delete(ids: string[]) {
    if (ids.length) await this.client.delete(this.collection, { wait: true, points: ids.map(pointId) });
  }

  async drop() {
    await this.client.deleteCollection(this.collection);
  }

  async count() {
    return (await this.client.count(this.collection, { exact: true })).count;
  }

  async info() {
    const info = await this.client.getCollection(this.collection);
    return { status: info.status, points: info.points_count ?? 0, indexed: info.indexed_vectors_count ?? 0, segments: info.segments_count };
  }
}
