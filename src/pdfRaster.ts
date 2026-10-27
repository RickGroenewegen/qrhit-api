import sharp from 'sharp';

/** One rendered page and its size on paper. */
export interface RenderedPage {
  png: Buffer;
  widthMm: number;
  heightMm: number;
}

/**
 * Pages of a PDF as PNGs, through @hyzyla/pdfium (MIT, WebAssembly build of
 * Chromium's PDFium: no native deps, no AGPL). Page numbers are 1-based, as
 * in the PDF itself; `scale` is pixels per point (1 = 72 dpi).
 *
 * The bitmap is sized from the page's exact size: left to itself pdfium
 * floors the size in points first, so a 62 mm page (175.7 pt) would come
 * out as 175 pt worth of pixels, the whole page squeezed in.
 *
 * Used by the Merchant Center's AI product images and the dashboard's card
 * previews (src/cardPreview.ts).
 */
export async function renderPdfPages(pdfBuffer: Buffer, pages: number[], scale: number = 4): Promise<RenderedPage[]> {
  const { PDFiumLibrary } = await import('@hyzyla/pdfium');
  const library = await PDFiumLibrary.init();
  try {
    const doc = await library.loadDocument(new Uint8Array(pdfBuffer));
    try {
      const out: RenderedPage[] = [];
      // asking for a page the PDF lacks gives an empty bitmap, which sharp
      // reports as "Input Bit Array is empty"; a Chromium render of an error
      // page (the page it was sent to was down) is one page long
      const count = doc.getPageCount();
      const missing = pages.find((pageNum) => pageNum > count);
      if (missing) throw new Error(`the PDF has ${count} page(s), page ${missing} was asked for`);
      for (const pageNum of pages) {
        // pdfium uses 0-based page indexes
        const page = doc.getPage(pageNum - 1);
        const { originalWidth, originalHeight } = page.getOriginalSize();
        const rendered = await page.render({
          scale: 1,
          width: Math.round(originalWidth * scale),
          height: Math.round(originalHeight * scale),
          render: async (opts) =>
            sharp(opts.data, {
              raw: { width: opts.width, height: opts.height, channels: 4 },
            })
              .png()
              .toBuffer(),
        });
        out.push({ png: Buffer.from(rendered.data), widthMm: (originalWidth * 25.4) / 72, heightMm: (originalHeight * 25.4) / 72 });
      }
      return out;
    } finally {
      doc.destroy();
    }
  } finally {
    library.destroy();
  }
}

/** Pages of a PDF as PNGs (renderPdfPages without the sizes). */
export async function renderPdfPagesToPng(pdfBuffer: Buffer, pages: number[], scale: number = 4): Promise<Buffer[]> {
  return (await renderPdfPages(pdfBuffer, pages, scale)).map((page) => page.png);
}
