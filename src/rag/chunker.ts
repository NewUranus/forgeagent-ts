import type { Chunk, Page } from "../types.js";
export function chunkPages(pages: Page[], size = 1000, overlap = 200): Chunk[] {
  if (!Number.isInteger(size) || !Number.isInteger(overlap) || size <= 0 || overlap < 0 || overlap >= size) throw new Error("要求 0 <= overlap < size，且均为整数");
  const chunks: Chunk[] = [];
  for (const page of pages) {
    if (!page.content.trim()) continue;
    // Count Unicode code points, like Python string slicing.
    const chars = Array.from(page.content);
    for (let start = 0; start < chars.length; start += size - overlap) {
      const end = Math.min(start + size, chars.length);
      chunks.push({ ...page, chunk_id: `${page.source}:p${page.page}:${start}`, start_char: start, end_char: end, content: chars.slice(start, end).join("") });
      if (end === chars.length) break;
    }
  }
  return chunks;
}
