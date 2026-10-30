"""Make an image-only "scanned" copy of a PDF, for testing OCR parsers against a text PDF.

Each page is rendered to grayscale, then given a paper tone, a slight tilt, sensor noise, a little
blur and JPEG artifacts, and the pages are written back as an image-only PDF: no text layer, so a
text extractor such as PDF.js gets nothing. Page count and page size are unchanged, so page-labelled
retrieval cases still apply. Effects are seeded per page, so the same input gives the same output.

Needs pypdfium2, Pillow and numpy (all in the MinerU env):
  .mineru/venv/bin/python scripts/scan-pdf.py ../ForgeAgent/rag/thinkpython2.pdf .rag_cache/thinkpython2-scan.pdf
"""
import argparse
import io
import random

import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageFilter


def scan(page_image: Image.Image, rng: random.Random, quality: int) -> Image.Image:
    gray = page_image.convert("L")
    paper = rng.uniform(228, 242)
    pixels = np.asarray(gray, dtype=np.float32) / 255 * paper  # white becomes off-white paper
    tilted = Image.fromarray(pixels.astype(np.uint8)).rotate(rng.uniform(-0.8, 0.8), resample=Image.BICUBIC, fillcolor=int(paper))
    noisy = np.asarray(tilted, dtype=np.float32) + np.random.default_rng(rng.randrange(2**32)).normal(0, 7, tilted.size[::-1])
    blurred = Image.fromarray(np.clip(noisy, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(rng.uniform(0.3, 0.7)))
    buffer = io.BytesIO()
    blurred.save(buffer, "JPEG", quality=quality)
    return Image.open(buffer)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("source")
    parser.add_argument("output")
    parser.add_argument("--dpi", type=int, default=200)
    parser.add_argument("--quality", type=int, default=60, help="JPEG quality")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    pdf = pdfium.PdfDocument(args.source)
    pages = []
    for index in range(len(pdf)):
        rendered = pdf[index].render(scale=args.dpi / 72, grayscale=True).to_pil()
        pages.append(scan(rendered, random.Random(args.seed * 100_000 + index), args.quality))
    # resolution=dpi keeps each page at its original size in points.
    pages[0].save(args.output, "PDF", save_all=True, append_images=pages[1:], resolution=args.dpi)
    print({"pages": len(pages), "dpi": args.dpi, "output": args.output})


if __name__ == "__main__":
    main()
