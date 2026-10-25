import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import { docsQueryPrompt, type RetrievalCase } from "./docs.js";
import { normalize } from "./embedding.js";
import { embedCached } from "./matrix.js";
import { QdrantStore } from "./qdrant-store.js";
import { loadIndex } from "./retriever.js";
import { ExactStore, type SearchOptions, type VectorStore } from "./vector-store.js";

// Scale experiment: where does the in-memory full scan stop being good enough, and what does HNSW
// cost in recall? For each size N it builds the same synthetic corpus in ExactStore (ground truth
// and the brute-force latency) and in a Qdrant collection (upload and HNSW build time, then
// recall@10 and latency over a sweep of hnsw_ef), optionally a second time with int8 quantization.
//
// The corpus is synthetic but shaped by real embeddings: each point mixes two real Think Python
// chunk vectors (dominant weight 0.5–1) plus Gaussian noise, so it is clustered and continuous like
// real text embeddings rather than uniform random (where every neighbour is about equally far and
// HNSW looks worse than it is). Queries are the real evaluation questions, embedded with the docs
// prompt. Treat the numbers as trends for this machine, not as recall on a real corpus.

const K = 10;
const EFS = [16, 32, 64, 128, 256];
const BATCH = 2048;

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** N unit vectors as float32 rows: normalize(a·B[i] + (1−a)·B[j] + noise · g / √d), a in [0.5, 1). */
export function syntheticCorpus(bases: number[][], n: number, noise = 0.3, seed = 7) {
  const dimension = bases[0].length;
  const random = seeded(seed);
  const gaussian = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const data = new Float32Array(n * dimension);
  const row = new Float64Array(dimension);
  for (let p = 0; p < n; p++) {
    const a = 0.5 + random() * 0.5;
    const first = bases[Math.floor(random() * bases.length)], second = bases[Math.floor(random() * bases.length)];
    let norm = 0;
    for (let i = 0; i < dimension; i++) {
      row[i] = a * first[i] + (1 - a) * second[i] + noise * gaussian() / Math.sqrt(dimension);
      norm += row[i] * row[i];
    }
    norm = Math.sqrt(norm);
    for (let i = 0; i < dimension; i++) data[p * dimension + i] = row[i] / norm;
  }
  return data;
}

// Both backends get the same float32 values: ExactStore as doubles, Qdrant as JSON with nine
// significant digits, which parse back to exactly that float32 and are half the size of a double.
const float32 = (values: ArrayLike<number>) => Array.from(Float32Array.from(values));
const json32 = (values: number[]) => values.map((value) => Number(value.toPrecision(9)));
const wire = (store: VectorStore): VectorStore => Object.assign(Object.create(store), {
  upsert: (points: { id: string; vector: number[] }[]) => store.upsert(points.map((point) => ({ ...point, vector: json32(point.vector) }))),
  search: (vector: number[], k: number, options?: SearchOptions) => store.search(json32(vector), k, options),
});

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(p * values.length))];
const ms = (value: number) => Number(value.toFixed(3));

async function timeQueries(store: VectorStore, queries: number[][], options: { ef?: number; exact?: boolean }, truth?: string[][]) {
  await store.search(queries[0], K, options); // warm up
  const times: number[] = [];
  let recall = 0;
  for (const [i, query] of queries.entries()) {
    const start = performance.now();
    const hits = await store.search(query, K, options);
    times.push(performance.now() - start);
    if (truth) recall += hits.filter((hit) => truth[i].includes(hit.id)).length / K;
  }
  return { p50_ms: ms(percentile(times, 0.5)), p95_ms: ms(percentile(times, 0.95)), ...(truth ? { recall_at_10: Number((recall / queries.length).toFixed(4)) } : {}) };
}

/** Resident memory of the local Qdrant process in MB, or null when it cannot be read. */
function qdrantRssMb() {
  try {
    const pid = execFileSync("pgrep", ["-f", ".qdrant/bin/qdrant"], { encoding: "utf8" }).trim().split("\n")[0];
    return Math.round(Number(execFileSync("ps", ["-o", "rss=", "-p", pid], { encoding: "utf8" }).trim()) / 1024);
  } catch {
    return null;
  }
}

export interface ScaleOptions {
  sizes: number[];
  pdfIndex: string;
  out: string;
  quantization?: boolean;
  seed?: number;
}

export async function runScale(options: ScaleOptions) {
  const index = await loadIndex(options.pdfIndex);
  const bases = index.chunks.map((chunk) => chunk.embedding);
  const dimension = index.dimension;
  const cases: RetrievalCase[] = [
    ...JSON.parse(await fs.readFile(path.join(ROOT, "eval/retrieval/readme.json"), "utf8")),
    ...JSON.parse(await fs.readFile(path.join(ROOT, "eval/retrieval/thinkpython.json"), "utf8")),
  ];
  const queries = (await embedCached(cases.map((item) => docsQueryPrompt(item.query)))).map((vector) => float32(normalize(vector)));
  const seed = options.seed ?? 7;
  const rows = [];
  for (const n of options.sizes) {
    console.error(`N = ${n}：生成向量……`);
    const data = syntheticCorpus(bases, n, 0.3, seed);
    const batches = (handle: (points: { id: string; vector: number[] }[]) => Promise<void>) => (async () => {
      for (let start = 0; start < n; start += BATCH) {
        const points = [];
        for (let p = start; p < Math.min(n, start + BATCH); p++) points.push({ id: `s${p}`, vector: Array.from(data.subarray(p * dimension, (p + 1) * dimension)) });
        await handle(points);
      }
    })();

    const exact = new ExactStore(dimension, [], n);
    await batches((points) => exact.upsert(points));
    const truth = await Promise.all(queries.map(async (query) => (await exact.search(query, K)).map((hit) => hit.id)));
    const memory = await timeQueries(exact, queries, {});
    console.error(`  内存精确检索 p50 ${memory.p50_ms} ms`);

    const configs = [{ name: "hnsw", quantization: undefined }, ...(options.quantization ? [{ name: "hnsw+int8", quantization: "int8" as const }] : [])];
    const qdrant = [];
    for (const config of configs) {
      const collection = `scale_${n}_${seed}_${config.name.replace(/\W/g, "_")}`;
      const rssBefore = qdrantRssMb();
      const qdrantStore = await QdrantStore.open({ collection, dimension, recreate: true, forceIndex: true, quantization: config.quantization });
      const store = wire(qdrantStore);
      let start = performance.now();
      await batches((points) => store.upsert(points));
      const upload = (performance.now() - start) / 1000;
      start = performance.now();
      const { indexed } = await qdrantStore.waitIndexed();
      const build = (performance.now() - start) / 1000;
      console.error(`  ${config.name}：上传 ${upload.toFixed(1)} s，建索引 ${build.toFixed(1)} s`);
      const rssAfter = qdrantRssMb();
      const sweep = [];
      for (const ef of EFS) sweep.push({ ef, ...(await timeQueries(store, queries, { ef }, truth)) });
      qdrant.push({
        config: config.name, collection, indexed_vectors: indexed, upload_s: Number(upload.toFixed(1)), index_build_s: Number(build.toFixed(1)),
        rss_delta_mb: rssBefore !== null && rssAfter !== null ? rssAfter - rssBefore : null,
        exact: await timeQueries(store, queries, { exact: true }, truth),
        sweep,
      });
      await qdrantStore.drop();
    }
    rows.push({ n, raw_vectors_mb: Math.round(n * dimension * 4 / 1048576), memory, qdrant });
  }
  const report = {
    generated_at: new Date().toISOString(), dimension, k: K, queries: queries.length, seed,
    corpus: "合成：两条真实 Think Python 片段向量按 0.5–1 权重混合，加 0.3 高斯噪声后归一化", rows,
  };
  await fs.mkdir(path.dirname(options.out), { recursive: true });
  await fs.writeFile(options.out, JSON.stringify(report, null, 2) + "\n");
  return report;
}

export function renderScale(report: Awaited<ReturnType<typeof runScale>>) {
  const pct = (value?: number) => (value === undefined ? "—" : `${(value * 100).toFixed(1)}%`);
  const lines = [
    `向量规模实验（${report.generated_at}，${report.dimension} 维，${report.queries} 个真实问题，top-${report.k}）`,
    `语料：${report.corpus}`,
    "",
    "| N | 原始向量 | 后端 | 上传 s | 建索引 s | 内存增量 MB | 参数 | recall@10 | p50 ms | p95 ms |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const row of report.rows) {
    lines.push(`| ${row.n} | ${row.raw_vectors_mb} MB | 内存精确 | — | — | — | 全量扫描 | 100.0% | ${row.memory.p50_ms} | ${row.memory.p95_ms} |`);
    for (const q of row.qdrant) {
      lines.push(`| ${row.n} | | Qdrant ${q.config} | ${q.upload_s} | ${q.index_build_s} | ${q.rss_delta_mb ?? "—"} | exact | ${pct(q.exact.recall_at_10)} | ${q.exact.p50_ms} | ${q.exact.p95_ms} |`);
      for (const s of q.sweep) lines.push(`| ${row.n} | | Qdrant ${q.config} | | | | ef=${s.ef} | ${pct(s.recall_at_10)} | ${s.p50_ms} | ${s.p95_ms} |`);
    }
  }
  lines.push("", "recall@10 以内存精确检索为真值；Qdrant 延迟含本机 HTTP 往返；内存增量是建完索引后 Qdrant 进程 RSS 的变化（粗略）。");
  return lines.join("\n");
}
