// Dependency-free lexical retrieval: tokenizer for mixed Chinese/English/code text, BM25 over an
// inverted index, heap-based top-K selection and reciprocal rank fusion.

const STOPWORDS = new Set(["the", "a", "an", "of", "to", "in", "and", "or", "is", "are", "be", "for", "on", "with", "as", "by", "it", "this", "that", "at", "from"]);

/**
 * English and code: lowercase words, with camelCase / snake_case identifiers also split into parts
 * ("parseRetryAfter" -> parseretryafter, parse, retry, after). Chinese has no spaces: use
 * overlapping character bigrams ("上下文" -> 上下, 下文), plus the character itself for single-character runs.
 */
export function tokenize(text: string): string[] {
  const terms: string[] = [];
  for (const word of text.match(/[A-Za-z0-9_]+/g) ?? []) {
    const lower = word.toLowerCase();
    const parts = word.split(/_|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).map((p) => p.toLowerCase()).filter(Boolean);
    if (!STOPWORDS.has(lower)) terms.push(lower);
    if (parts.length > 1) for (const part of parts) if (part.length > 1 && !STOPWORDS.has(part)) terms.push(part);
  }
  for (const run of text.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) terms.push(run);
    for (let i = 0; i + 1 < run.length; i++) terms.push(run.slice(i, i + 2));
  }
  return terms;
}

/** The k largest items by score, in descending order: O(n log k) with a size-k min-heap. */
export function topK<T>(items: Iterable<T>, k: number, score: (item: T) => number): { item: T; score: number }[] {
  if (!Number.isInteger(k) || k < 1) throw new Error("k 必须是正整数");
  const heap: { item: T; score: number }[] = [];
  const less = (i: number, j: number) => heap[i].score < heap[j].score;
  const swap = (i: number, j: number) => { [heap[i], heap[j]] = [heap[j], heap[i]]; };
  const up = (i: number) => {
    while (i > 0 && less(i, (i - 1) >> 1)) { swap(i, (i - 1) >> 1); i = (i - 1) >> 1; }
  };
  const down = (i: number) => {
    for (;;) {
      let min = i;
      for (const child of [2 * i + 1, 2 * i + 2]) if (child < heap.length && less(child, min)) min = child;
      if (min === i) return;
      swap(i, min);
      i = min;
    }
  };
  for (const item of items) {
    const entry = { item, score: score(item) };
    if (heap.length < k) { heap.push(entry); up(heap.length - 1); }
    else if (entry.score > heap[0].score) { heap[0] = entry; down(0); }
  }
  return heap.sort((a, b) => b.score - a.score);
}

/**
 * Okapi BM25. Term frequency saturates through k1; b normalises by document length against the
 * average; idf uses the non-negative form log(1 + (N - df + 0.5) / (df + 0.5)).
 */
export class Bm25Index {
  private postings = new Map<string, Map<number, number>>(); // term -> (doc -> term frequency)
  private lengths: number[] = [];
  private averageLength = 0;

  constructor(texts: string[], private k1 = 1.2, private b = 0.75) {
    texts.forEach((text, doc) => {
      const terms = tokenize(text);
      this.lengths.push(terms.length);
      for (const term of terms) {
        if (!this.postings.has(term)) this.postings.set(term, new Map());
        const counts = this.postings.get(term)!;
        counts.set(doc, (counts.get(doc) ?? 0) + 1);
      }
    });
    this.averageLength = this.lengths.reduce((sum, n) => sum + n, 0) / Math.max(1, this.lengths.length);
  }

  get size() {
    return this.lengths.length;
  }

  idf(term: string) {
    const df = this.postings.get(term)?.size ?? 0;
    return Math.log(1 + (this.size - df + 0.5) / (df + 0.5));
  }

  /** Only documents sharing at least one query term are scored, via the inverted index. */
  search(query: string, k: number) {
    const scores = new Map<number, number>();
    for (const term of new Set(tokenize(query))) {
      const counts = this.postings.get(term);
      if (!counts) continue;
      const idf = this.idf(term);
      for (const [doc, tf] of counts) {
        const norm = this.k1 * (1 - this.b + this.b * this.lengths[doc] / (this.averageLength || 1));
        scores.set(doc, (scores.get(doc) ?? 0) + idf * (tf * (this.k1 + 1)) / (tf + norm));
      }
    }
    return topK(scores, k, ([, score]) => score).map(({ item: [doc], score }) => ({ doc, score }));
  }
}

/**
 * Reciprocal rank fusion: each list contributes 1 / (k + rank). It only needs ranks, so BM25 scores
 * and cosine similarities, which live on different scales, can be combined without calibration.
 */
export function reciprocalRankFusion(rankings: string[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings)
    ranking.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
