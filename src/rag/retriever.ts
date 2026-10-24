import { promises as fs } from "node:fs";
import type { VectorIndex, VectorChunk } from "../types.js";
import { normalize } from "./embedding.js";
export async function loadIndex(file: string): Promise<VectorIndex> {
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  const dimension = raw.dimension ?? raw.demension;
  if (!Number.isInteger(dimension) || dimension < 1 || !Array.isArray(raw.chunks)) throw new Error("索引格式错误");
  for (const chunk of raw.chunks) {
    if (typeof chunk.content !== "string" || !Array.isArray(chunk.embedding) || chunk.embedding.length !== dimension) throw new Error("片段或向量维度错误");
    normalize(chunk.embedding);
  }
  return { model: raw.model || "Qwen3-Embedding-0.6B", dimension, normalized: raw.normalized === true, chunks: raw.chunks };
}
export function search(index: VectorIndex, vector: number[], k = 3, minChars = 0) {
  if (!Number.isInteger(k) || k < 1) throw new Error("top-k 必须是正整数");
  if (vector.length !== index.dimension) throw new Error("问题向量与文档向量维度不一致");
  const query = normalize(vector);
  return index.chunks.filter(c => c.content.trim().length >= minChars).map(chunk => {
    const embedding = normalize(chunk.embedding);
    const score = embedding.reduce((sum, value, i) => sum + value * query[i], 0);
    const { embedding: _, ...rest } = chunk;
    return { ...rest, score };
  }).sort((a, b) => b.score - a.score).slice(0, k);
}
