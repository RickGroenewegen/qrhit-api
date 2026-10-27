import sharp from 'sharp';

/**
 * The pages a format tile shows (tiles.ts): the A4 sheet of cards to cut out,
 * and the digital PDF on a laptop's screen. A page's picture is laid out from
 * card pictures, so it shows the playlist's design like the cards do; the
 * scene's face for it (a `page` face, export-passes.py) is mapped onto the
 * whole picture.
 *
 * A layout is in its own pixels: plain shapes under the cards (paper, the PDF
 * viewer) and over them (the fold lines, the toolbar), and the square cells
 * the card pictures go into, cut to the picture where they run off it. The
 * site's browser compositor lays the same pages out from the same data,
 * which webPasses.ts sends along with the tile scenes; it draws the shapes on
 * a canvas itself (an SVG drawn into a canvas can keep Safari from reading
 * the pixels back), so keep to the shapes below.
 */

export type PageShape =
  | {
      kind: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      fill?: string;
      opacity?: number;
      radius?: number;
      stroke?: string;
      strokeWidth?: number;
    }
  | { kind: 'circle'; x: number; y: number; r: number; fill: string }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; strokeWidth: number; dash?: number[] };

export interface PageCell {
  x: number;
  y: number;
  size: number;
  /** which of the cards, and which side */
  card: number;
  side: 'front' | 'back';
}

export interface PageLayout {
  width: number;
  height: number;
  /** under the cards, in the layout's pixels */
  underlay: PageShape[];
  /** over the cards */
  overlay: PageShape[];
  cells: PageCell[];
}

/** Twelve fronts on A4 at 100 px per cm, as the sheets product prints them: 3 x 4 cards of 6 cm, centred. */
function sheetLayout(): PageLayout {
  const width = 2100;
  const height = 2970;
  const card = 600;
  const left = (width - 3 * card) / 2;
  const top = (height - 4 * card) / 2;
  const cells: PageCell[] = [];
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 3; column++) {
      cells.push({ x: left + column * card, y: top + row * card, size: card, card: row * 3 + column, side: 'front' });
    }
  }
  return { width, height, underlay: [{ kind: 'rect', x: 0, y: 0, width, height, fill: '#ffffff' }], overlay: [], cells };
}

/**
 * The digital PDF (views/pdf_digital.ejs) in a PDF viewer, zoomed to the
 * screen's width: A4 with 15 mm by 10 mm padding, each card a fold-out pair
 * of 60 x 120 mm (front over back, a dashed fold line, a thin border), three
 * across. The first row shows whole, the second's fronts below it.
 */
function screenLayout(): PageLayout {
  const width = 1600;
  const height = 1000;
  const bar = 52;
  const mm = 4.6;
  const pageWidth = Math.round(210 * mm);
  const pageLeft = Math.round((width - pageWidth) / 2);
  const pageTop = bar + 26;
  const card = Math.round(60 * mm);
  const cells: PageCell[] = [];
  const folds: PageShape[] = [];
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 3; column++) {
      const index = row * 3 + column;
      const x = pageLeft + Math.round((10 + 60 * column) * mm);
      const y = pageTop + Math.round((15 + 120 * row) * mm);
      cells.push({ x, y, size: card, card: index, side: 'front' }, { x, y: y + card, size: card, card: index, side: 'back' });
      folds.push(
        { kind: 'rect', x: x - 1, y: y - 1, width: card + 2, height: 2 * card + 2, stroke: '#c8c8c8', strokeWidth: 2 },
        { kind: 'line', x1: x, y1: y + card, x2: x + card, y2: y + card, stroke: '#bdbdbd', strokeWidth: 3, dash: [9, 7] }
      );
    }
  }
  return {
    width,
    height,
    underlay: [
      { kind: 'rect', x: 0, y: 0, width, height, fill: '#e4e4e6' },
      { kind: 'rect', x: pageLeft - 4, y: pageTop - 2, width: pageWidth + 8, height, fill: '#000000', opacity: 0.08 },
      { kind: 'rect', x: pageLeft, y: pageTop, width: pageWidth, height, fill: '#ffffff' },
    ],
    overlay: [
      ...folds,
      { kind: 'rect', x: 0, y: 0, width, height: bar, fill: '#f4f4f5' },
      { kind: 'rect', x: 0, y: bar - 1, width, height: 1, fill: '#d4d4d8' },
      { kind: 'circle', x: 28, y: 26, r: 7, fill: '#ff5f57' },
      { kind: 'circle', x: 52, y: 26, r: 7, fill: '#febc2e' },
      { kind: 'circle', x: 76, y: 26, r: 7, fill: '#28c840' },
      { kind: 'rect', x: 640, y: 17, width: 320, height: 18, radius: 4, fill: '#e4e4e7' },
    ],
    cells,
  };
}

export const PAGE_LAYOUTS: Record<string, PageLayout> = { sheet: sheetLayout(), screen: screenLayout() };

/** The picture's size at `scale` (picture pixels per layout pixel). */
export function pageSize(layout: PageLayout, scale: number): { width: number; height: number } {
  return { width: Math.round(layout.width * scale), height: Math.round(layout.height * scale) };
}

function shapeSvg(shape: PageShape): string {
  if (shape.kind === 'circle') return `<circle cx="${shape.x}" cy="${shape.y}" r="${shape.r}" fill="${shape.fill}"/>`;
  if (shape.kind === 'line') {
    const dash = shape.dash ? ` stroke-dasharray="${shape.dash.join(' ')}"` : '';
    return `<line x1="${shape.x1}" y1="${shape.y1}" x2="${shape.x2}" y2="${shape.y2}" stroke="${shape.stroke}" stroke-width="${shape.strokeWidth}"${dash}/>`;
  }
  const paint = [
    `fill="${shape.fill ?? 'none'}"`,
    shape.opacity !== undefined ? `fill-opacity="${shape.opacity}"` : '',
    shape.radius ? `rx="${shape.radius}"` : '',
    shape.stroke ? `stroke="${shape.stroke}" stroke-width="${shape.strokeWidth ?? 1}"` : '',
  ];
  return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" ${paint.filter(Boolean).join(' ')}/>`;
}

/** Shapes as a whole SVG document at the picture's size. */
function pageSvg(layout: PageLayout, shapes: PageShape[], scale: number): Buffer {
  const { width, height } = pageSize(layout, scale);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${layout.width} ${layout.height}" preserveAspectRatio="none">${shapes.map(shapeSvg).join('')}</svg>`
  );
}

/**
 * Where a cell lands in the picture at `scale`: the card's square (`size`,
 * from rounded edges, so neighbouring cards meet without a gap) and how much
 * of it is inside the picture. Null for a cell entirely off it.
 */
export function cellRect(
  cell: PageCell,
  layout: PageLayout,
  scale: number
): { left: number; top: number; size: number; width: number; height: number } | null {
  const left = Math.round(cell.x * scale);
  const top = Math.round(cell.y * scale);
  const size = Math.round((cell.x + cell.size) * scale) - left;
  const picture = pageSize(layout, scale);
  const width = Math.min(size, picture.width - left);
  const height = Math.min(size, picture.height - top);
  return width > 0 && height > 0 ? { left, top, size, width, height } : null;
}

/**
 * A page's picture (PNG) at `scale`, with `picture(card, side)` (a card side
 * as printed) in each cell. The cards are shrunk in linear light, like the
 * photo's card pictures (compose.ts).
 */
export async function pagePicture(
  layout: PageLayout,
  picture: (card: number, side: 'front' | 'back') => Buffer,
  scale: number
): Promise<Buffer> {
  const layers: sharp.OverlayOptions[] = [];
  // a page repeats its cards (twelve cells, five songs): each picture is shrunk once per size
  const shrunk = new Map<Buffer, Map<number, Promise<Buffer>>>();
  const shrink = (source: Buffer, size: number) => {
    const sizes = shrunk.get(source) ?? new Map<number, Promise<Buffer>>();
    shrunk.set(source, sizes);
    let done = sizes.get(size);
    if (!done) {
      done = sharp(source)
        .removeAlpha()
        .pipelineColourspace('scrgb')
        .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
        .toColourspace('srgb')
        .png()
        .toBuffer();
      sizes.set(size, done);
    }
    return done;
  };
  for (const cell of layout.cells) {
    const rect = cellRect(cell, layout, scale);
    if (!rect) continue;
    let card = await shrink(picture(cell.card, cell.side), rect.size);
    if (rect.width < rect.size || rect.height < rect.size) {
      card = await sharp(card).extract({ left: 0, top: 0, width: rect.width, height: rect.height }).png().toBuffer();
    }
    layers.push({ input: card, left: rect.left, top: rect.top });
  }
  if (layout.overlay.length) layers.push({ input: pageSvg(layout, layout.overlay, scale), left: 0, top: 0 });
  return sharp(pageSvg(layout, layout.underlay, scale)).composite(layers).png().toBuffer();
}
