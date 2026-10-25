import { topK } from "./lexical.js";

// The seam between retrieval and vector storage. DocSearch and the evaluation code only see this
// interface: ExactStore scans every vector in memory (exact, zero dependencies), QdrantStore keeps
// them in a Qdrant collection with an HNSW index (approximate, persistent, scales past memory).
//
// Contract: vectors are unit length, so cosine similarity is the dot product and scores from both
// backends are comparable. Callers normalize; stores never renormalize, so rankings stay bit-exact.

export interface VectorPoint {
  id: string;
  vector: number[];
}

export interface VectorHit {
  id: string;
  score: number;
}

export interface SearchOptions {
  /** HNSW candidate list size at query time (Qdrant `hnsw_ef`); larger is slower and more accurate. */
  ef?: number;
  /** Force a full scan even when an approximate index exists. */
  exact?: boolean;
}

export interface VectorStore {
  readonly name: string;
  readonly dimension: number;
  upsert(points: VectorPoint[]): Promise<void>;
  /** The k nearest points by cosine similarity, best first. */
  search(vector: number[], k: number, options?: SearchOptions): Promise<VectorHit[]>;
  delete(ids: string[]): Promise<void>;
  count(): Promise<number>;
}

export function checkVector(vector: number[], dimension: number) {
  if (vector.length !== dimension) throw new Error(`向量维度 ${vector.length} 与库维度 ${dimension} 不一致`);
}

/**
 * Brute force over a contiguous Float64Array: O(n·d) per query, exact. Float64 keeps the same
 * arithmetic as a dot product over number[], so rankings match the previous in-line code exactly.
 * Rows keep insertion order (ties break the same way every run); delete moves the last row into
 * the hole.
 */
export class ExactStore implements VectorStore {
  readonly name = "exact";
  private ids: string[] = [];
  private rows = new Map<string, number>();
  private data: Float64Array;

  /** capacity pre-sizes the buffer for that many rows, so bulk loads in batches never copy it. */
  constructor(readonly dimension: number, points: VectorPoint[] = [], capacity = points.length) {
    if (!Number.isInteger(dimension) || dimension < 1) throw new Error("维度必须是正整数");
    this.data = new Float64Array(Math.max(1, capacity, points.length) * dimension);
    this.add(points);
  }

  private add(points: VectorPoint[]) {
    for (const point of points) {
      checkVector(point.vector, this.dimension);
      let row = this.rows.get(point.id);
      if (row === undefined) {
        row = this.ids.length;
        if ((row + 1) * this.dimension > this.data.length) {
          const grown = new Float64Array(Math.max(this.data.length * 2, (row + 1) * this.dimension));
          grown.set(this.data);
          this.data = grown;
        }
        this.ids.push(point.id);
        this.rows.set(point.id, row);
      }
      this.data.set(point.vector, row * this.dimension);
    }
  }

  async upsert(points: VectorPoint[]) {
    this.add(points);
  }

  async search(vector: number[], k: number) {
    checkVector(vector, this.dimension);
    const { data, dimension } = this;
    const score = (row: number) => {
      let sum = 0;
      for (let i = 0, offset = row * dimension; i < dimension; i++) sum += data[offset + i] * vector[i];
      return sum;
    };
    return topK(this.ids.keys(), k, score).map(({ item, score }) => ({ id: this.ids[item], score }));
  }

  async delete(ids: string[]) {
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row === undefined) continue;
      const last = this.ids.length - 1;
      if (row !== last) {
        this.data.copyWithin(row * this.dimension, last * this.dimension, (last + 1) * this.dimension);
        this.ids[row] = this.ids[last];
        this.rows.set(this.ids[row], row);
      }
      this.ids.pop();
      this.rows.delete(id);
    }
  }

  async count() {
    return this.ids.length;
  }
}
