import { promises as fs } from "node:fs";
import path from "node:path";
import { listFiles } from "../workspace.js";
import type { VectorIndex } from "../types.js";
import { Bm25Index, reciprocalRankFusion, topK } from "./lexical.js";
import { loadIndex } from "./retriever.js";
import { embed, normalize } from "./embedding.js";

// search_docs: hybrid retrieval over the project's own documentation plus an optional prebuilt
// vector index (e.g. a PDF manual). BM25 always works offline; vectors join only when the index has
// embeddings and an embedding model answers. Rankings are fused by rank, not by raw score.

export const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const MAX_CHUNK_CHARS = 1200;
const MAX_DOC_BYTES = 2_000_000;
const RESULT_CHARS = 800;

export interface DocChunk {
  id: string;
  source: string;
  /** "README.md:10-24" for project files, "manual.pdf 第 12 页" for index chunks. */
  location: string;
  title: string;
  text: string;
  embedding?: number[];
}

/**
 * Split by markdown headings, then pack blank-line separated paragraphs up to maxChars. Each chunk
 * keeps its heading path (useful context for both BM25 and the model) and 1-based line range, so a
 * result can be opened with read_file(start_line, end_line). Oversized paragraphs split by lines.
 */
export function chunkDocument(source: string, text: string, maxChars = MAX_CHUNK_CHARS): DocChunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: DocChunk[] = [];
  const headings: string[] = [];
  let buffer: { line: number; text: string }[] = [];
  const flush = () => {
    const body = buffer.map((entry) => entry.text).join("\n").trim();
    if (body) {
      const start = buffer[0].line, end = buffer.at(-1)!.line;
      chunks.push({ id: `${source}:${start}`, source, location: `${source}:${start}-${end}`, title: headings.filter(Boolean).join(" > "), text: body });
    }
    buffer = [];
  };
  const size = () => buffer.reduce((sum, entry) => sum + entry.text.length + 1, 0);
  let paragraph: { line: number; text: string }[] = [];
  const addParagraph = () => {
    if (!paragraph.length) return;
    const paragraphSize = paragraph.reduce((sum, entry) => sum + entry.text.length + 1, 0);
    if (buffer.length && size() + paragraphSize > maxChars) flush();
    for (const entry of paragraph) {
      if (buffer.length && size() + entry.text.length + 1 > maxChars) flush();
      buffer.push(entry);
    }
    paragraph = [];
  };
  // Inside fenced code blocks "#" starts a shell or Python comment, not a heading, and blank lines
  // do not end a paragraph: the whole block stays together.
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const marker = line.match(/^\s*(```|~~~)/)?.[1];
    if (fence) {
      paragraph.push({ line: index + 1, text: line });
      if (marker === fence) fence = null;
      return;
    }
    if (marker) {
      fence = marker;
      paragraph.push({ line: index + 1, text: line });
      return;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      addParagraph();
      flush();
      headings.length = heading[1].length - 1;
      headings[heading[1].length - 1] = heading[2].trim();
      buffer.push({ line: index + 1, text: line });
    } else if (!line.trim()) {
      addParagraph();
    } else {
      paragraph.push({ line: index + 1, text: line });
    }
  });
  addParagraph();
  flush();
  return chunks;
}

export type Embedder = (texts: string[], model?: string) => Promise<number[][]>;

export interface DocsConfig {
  /** Prebuilt index from `npm run rag -- embed` (chunks with content and embeddings). */
  indexPath?: string;
  /** Injected for tests; defaults to the configured embedding service or local model. */
  embedder?: Embedder;
}

export const docsQueryPrompt = (question: string) =>
  `Instruct: Given a question about a software project, retrieve documentation passages that answer it.\nQuery:${question}`;

export class DocSearch {
  private bm25: Bm25Index;
  constructor(readonly chunks: DocChunk[], private index: VectorIndex | null, private embedder: Embedder) {
    this.bm25 = new Bm25Index(chunks.map((chunk) => `${chunk.title}\n${chunk.text}`));
  }

  static async build(root: string, config: DocsConfig = {}) {
    const chunks: DocChunk[] = [];
    for (const file of await listFiles(root)) {
      if (!DOC_FILE.test(file)) continue;
      const buffer = await fs.readFile(path.join(root, file));
      if (buffer.length > MAX_DOC_BYTES || buffer.includes(0)) continue;
      chunks.push(...chunkDocument(file, buffer.toString("utf8")));
    }
    let index: VectorIndex | null = null;
    if (config.indexPath) {
      index = await loadIndex(config.indexPath);
      const name = path.basename(config.indexPath);
      for (const chunk of index.chunks)
        chunks.push({ id: `${name}#${chunk.chunk_id}`, source: chunk.source, location: `${chunk.source} 第 ${chunk.page} 页`, title: "", text: chunk.content, embedding: chunk.embedding });
    }
    return new DocSearch(chunks, index, config.embedder ?? embed);
  }

  /**
   * BM25 over every chunk; if the index has embeddings, also cosine similarity over those chunks,
   * fused with RRF. Embedding failures degrade to BM25 and are reported, never thrown.
   */
  async search(query: string, k = 5) {
    if (!query.trim()) throw new Error("query 不能为空");
    if (!Number.isInteger(k) || k < 1 || k > 10) throw new Error("top_k 必须是 1–10 的整数");
    const depth = Math.max(20, k * 4);
    const lexical = this.bm25.search(query, depth).map(({ doc }) => this.chunks[doc].id);
    let mode: "bm25" | "hybrid" = "bm25", note: string | null = null;
    const rankings = [lexical];
    const withVectors = this.chunks.filter((chunk) => chunk.embedding);
    if (this.index && withVectors.length) {
      try {
        const [vector] = await this.embedder([docsQueryPrompt(query)], this.index.model);
        if (vector.length !== this.index.dimension) throw new Error("问题向量与索引维度不一致");
        const q = normalize(vector);
        const dot = (e: number[]) => e.reduce((sum, value, i) => sum + value * q[i], 0);
        rankings.push(topK(withVectors, depth, (chunk) => dot(chunk.embedding!)).map(({ item }) => item.id));
        mode = "hybrid";
      } catch (error) {
        note = `向量检索不可用，只用了 BM25：${String(error).slice(0, 200)}`;
      }
    }
    const byId = new Map(this.chunks.map((chunk) => [chunk.id, chunk]));
    const results = reciprocalRankFusion(rankings).slice(0, k).map(({ id, score }) => {
      const chunk = byId.get(id)!;
      return { id, location: chunk.location, title: chunk.title, score: Number(score.toFixed(4)),
        text: chunk.text.length > RESULT_CHARS ? `${chunk.text.slice(0, RESULT_CHARS)}……` : chunk.text };
    });
    return { query, mode, total_chunks: this.chunks.length, results, ...(note ? { note } : {}) };
  }
}

// One index per project, rebuilt when any doc file's size or mtime changes (e.g. the agent edited a README).
const cache = new Map<string, { signature: string; search: Promise<DocSearch> }>();

async function signature(root: string, config: DocsConfig) {
  const parts: string[] = [config.indexPath ?? ""];
  for (const file of await listFiles(root)) {
    if (!DOC_FILE.test(file)) continue;
    const stat = await fs.stat(path.join(root, file));
    parts.push(`${file}:${stat.size}:${stat.mtimeMs}`);
  }
  return parts.join("|");
}

export async function docSearchFor(root: string, config: DocsConfig = {}) {
  const key = `${root}\0${config.indexPath ?? ""}`;
  const current = await signature(root, config);
  const cached = cache.get(key);
  if (cached && cached.signature === current && !config.embedder) return cached.search;
  const search = DocSearch.build(root, config);
  cache.set(key, { signature: current, search });
  search.catch(() => cache.delete(key));
  return search;
}

/** Whether search_docs has anything to search, so the tool is only offered when useful. */
export async function hasDocs(root: string, config: DocsConfig = {}) {
  if (config.indexPath) return true;
  return (await listFiles(root)).some((file) => DOC_FILE.test(file));
}

export interface RetrievalCase {
  query: string;
  /**
   * A result is relevant when its id or location starts with one of these, or, for entries written
   * "title:<text>", when its heading path contains the text (stable when line numbers move).
   */
  relevant: string[];
}

/** recall@k: share of cases with a relevant result in the top k. MRR: mean of 1 / rank of the first hit. */
export async function evaluateRetrieval(search: DocSearch, cases: RetrievalCase[], k = 5) {
  const perCase = [];
  for (const item of cases) {
    const { results } = await search.search(item.query, k);
    const matches = (r: (typeof results)[number], wanted: string) => wanted.startsWith("title:")
      ? r.title.includes(wanted.slice(6))
      : r.id.startsWith(wanted) || r.location.startsWith(wanted);
    const rank = results.findIndex((r) => item.relevant.some((wanted) => matches(r, wanted))) + 1;
    perCase.push({ query: item.query, rank: rank || null, top: results.map((r) => r.location) });
  }
  const hits = perCase.filter((c) => c.rank !== null);
  return {
    k, cases: cases.length,
    recall_at_k: cases.length ? hits.length / cases.length : 0,
    mrr: cases.length ? hits.reduce((sum, c) => sum + 1 / c.rank!, 0) / cases.length : 0,
    per_case: perCase,
  };
}
