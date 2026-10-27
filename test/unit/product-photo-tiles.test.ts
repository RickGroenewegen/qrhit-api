import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { cellRect, PAGE_LAYOUTS, pagePicture, pageSize } from '../../src/productPhoto/pages';
import { TILE_WIDTHS, tileOutputs } from '../../src/productPhoto/tiles';

const solid = (rgb: [number, number, number]) =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .png()
    .toBuffer();

describe('format tile pages', () => {
  it('the screen shows the digital PDF: three fold-out pairs across, each back right under its front', () => {
    const { cells } = PAGE_LAYOUTS.screen;
    const fronts = cells.filter((cell) => cell.side === 'front');
    expect(fronts.slice(0, 3).map((cell) => cell.card)).toEqual([0, 1, 2]);
    for (const front of fronts) {
      const back = cells.find((cell) => cell.side === 'back' && cell.card === front.card)!;
      expect(back.x).toBe(front.x);
      expect(back.y).toBe(front.y + front.size);
    }
  });

  it('the sheet holds twelve fronts, 3 x 4, centred on A4', () => {
    const { cells, width, height } = PAGE_LAYOUTS.sheet;
    expect(cells).toHaveLength(12);
    expect(cells.every((cell) => cell.side === 'front')).toBe(true);
    const right = Math.max(...cells.map((cell) => cell.x + cell.size));
    const bottom = Math.max(...cells.map((cell) => cell.y + cell.size));
    expect(cells[0].x).toBe(width - right);
    expect(cells[0].y).toBe(height - bottom);
  });

  it('neighbouring cells meet without a gap at any scale', () => {
    const layout = PAGE_LAYOUTS.sheet;
    for (const scale of [0.1, 0.1676, 0.37, 1]) {
      const [a, b] = [cellRect(layout.cells[0], layout, scale)!, cellRect(layout.cells[1], layout, scale)!];
      expect(b.left).toBe(a.left + a.size);
    }
  });

  it('cuts a cell that runs off the picture, and leaves out one entirely off it', () => {
    const layout = { width: 100, height: 100, underlay: [], overlay: [], cells: [] };
    expect(cellRect({ x: 80, y: 0, size: 40, card: 0, side: 'front' }, layout, 1)).toMatchObject({ size: 40, width: 20, height: 40 });
    expect(cellRect({ x: 0, y: 120, size: 40, card: 0, side: 'front' }, layout, 1)).toBeNull();
  });

  it('lays a page out at its scale with each card picture in its cell', async () => {
    const red = await solid([220, 40, 40]);
    const teal = await solid([20, 90, 100]);
    const layout = PAGE_LAYOUTS.screen;
    const scale = 0.25;
    const png = await pagePicture(layout, (_card, side) => (side === 'front' ? red : teal), scale);
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect({ width: info.width, height: info.height }).toEqual(pageSize(layout, scale));

    const at = (x: number, y: number) => {
      const i = (Math.round(y) * info.width + Math.round(x)) * 3;
      return Array.from(data.subarray(i, i + 3));
    };
    const near = (actual: number[], expected: number[]) => actual.forEach((value, c) => expect(Math.abs(value - expected[c])).toBeLessThanOrEqual(2));
    const front = cellRect(layout.cells[0], layout, scale)!;
    const back = cellRect(layout.cells[1], layout, scale)!;
    near(at(front.left + front.size / 2, front.top + front.size / 4), [220, 40, 40]);
    near(at(back.left + back.size / 2, back.top + back.size / 2), [20, 90, 100]);
    // the viewer's grey beside the page
    near(at(4, info.height - 4), [228, 228, 230]);
  });
});

describe('format tile files', () => {
  it('writes every width in avif, webp and png, named for the kind', async () => {
    const master = await sharp({ create: { width: 640, height: 512, channels: 4, background: { r: 200, g: 100, b: 50, alpha: 1 } } })
      .png()
      .toBuffer();
    const files = await tileOutputs(master, 'sheets');
    expect(files.map((file) => file.file).sort()).toEqual(
      TILE_WIDTHS.flatMap((width) => ['avif', 'png', 'webp'].map((ext) => `tile-sheets-${width}.${ext}`)).sort()
    );
    for (const width of TILE_WIDTHS) {
      const { width: w, height: h } = await sharp(files.find((file) => file.file === `tile-sheets-${width}.png`)!.data).metadata();
      expect([w, h]).toEqual([width, (width * 4) / 5]);
    }
  });
});
