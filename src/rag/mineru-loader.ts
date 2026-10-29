import { promises as fs } from "node:fs";
import type { Chunk } from "../types.js";

/** MinerU 4.x structured_content.json: pages of typed blocks; page_idx is 0-based. */
interface Block {
  type: string;
  /** [x0, y0, x1, y1] as fractions of the page. */
  bbox: number[];
  content?: string;
  /** Set on paragraph_title (and title) blocks: 1 = top level. */
  level?: number;
  captions?: { content: string }[];
  footnotes?: { content: string }[];
}
interface StructuredContent {
  pages: { page_idx: number; blocks: Block[] }[];
}

/** Running heads, page numbers and footers repeat on every page and carry no content. */
const SKIP = new Set(["page_number", "header", "footer", "page_header", "page_footer"]);
const HEADING = new Set(["paragraph_title", "title"]);

function blockText(block: Block): string {
  return [block.content ?? "", ...(block.captions ?? []).map((c) => c.content), ...(block.footnotes ?? []).map((f) => f.content)]
    .filter(Boolean).join("\n").trim();
}

/**
 * Chunks from MinerU's structured_content.json, shaped like chunkPages() output so `rag embed` and
 * search_docs take them unchanged. Blocks pack up to `size` characters within one heading section;
 * a heading starts a new chunk, and every chunk starts with its heading path, so BM25 and the
 * vectors both see it. A chunk spanning pages keeps the page it starts on (1-based, as in PDF.js).
 * A block longer than `size` (a long code listing) is split by lines, then by characters.
 */
export async function loadMineru(file: string, source: string, size = 1000): Promise<Chunk[]> {
  const { pages }: StructuredContent = JSON.parse(await fs.readFile(file, "utf8"));
  const chunks: Chunk[] = [];
  const headings: string[] = [];
  let body: string[] = [], page = 0, start = 0, offset = 0;
  const flush = () => {
    if (!body.length) return;
    const title = headings.filter(Boolean).join(" > ");
    const content = (title ? `${title}\n` : "") + body.join("\n");
    chunks.push({ source, page: page + 1, content, chunk_id: `${source}:p${page + 1}:${start}`, start_char: start, end_char: offset });
    body = [];
  };
  const add = (text: string, at: number) => {
    if (body.length && body.reduce((sum, part) => sum + part.length + 1, 0) + text.length > size) flush();
    if (!body.length) { page = at; start = offset; }
    body.push(text);
    offset += text.length + 1;
  };
  for (const { page_idx, blocks } of pages) {
    // A running head is sometimes typed paragraph_title (Think Python's "5.11. Keyboard input" on
    // odd pages), which would relabel the section carried over from the previous page. Anything on
    // the same line as the page number or header is part of the running head.
    const heads = blocks.filter((block) => SKIP.has(block.type));
    const inHead = (block: Block) => heads.some((head) => block.bbox[1] < head.bbox[3] && block.bbox[3] > head.bbox[1]);
    for (const block of blocks) {
      if (SKIP.has(block.type) || inHead(block)) continue;
      const text = blockText(block);
      if (!text) continue;
      if (HEADING.has(block.type)) {
        flush();
        const level = Math.max(1, block.level ?? 1);
        headings.length = level - 1;
        headings[level - 1] = text;
        continue;
      }
      if (text.length <= size) { add(text, page_idx); continue; }
      let piece = "";
      for (const line of text.split("\n").flatMap((line) => line.match(new RegExp(`[^]{1,${size}}`, "g")) ?? [""])) {
        if (piece && piece.length + line.length + 1 > size) { add(piece, page_idx); piece = ""; }
        piece = piece ? `${piece}\n${line}` : line;
      }
      if (piece) add(piece, page_idx);
    }
  }
  flush();
  return chunks;
}
