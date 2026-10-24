import { promises as fs } from "node:fs";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Page } from "../types.js";
export async function loadPdf(file: string): Promise<Page[]> {
  const task = getDocument({ data: new Uint8Array(await fs.readFile(file)), useSystemFonts: true, verbosity: 0 });
  const doc = await task.promise;
  try {
    const pages: Page[] = [];
    for (let page = 1; page <= doc.numPages; page++) {
      const data = await (await doc.getPage(page)).getTextContent();
      const content = data.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
      pages.push({ source: path.basename(file), page, content });
    }
    return pages;
  } finally { await task.destroy(); }
}
