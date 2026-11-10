import { describe, it, expect } from 'vitest';
import { CARD_DESIGN_COLUMNS, sanitizeCardDesign, type CardDesign } from '../../src/cardDesigns';
import {
  BACK_COLUMNS,
  FRONT_COLUMNS,
  copiedDesign,
  designCopyRefusal,
  type DesignEditState,
} from '../../src/orderLineDesign';

// Esther Brauhardt, 100009410, line 10458: design 9 as she made it, design 10 after the designer lost its front
const design9 = sanitizeCardDesign({
  background: '1plhcp3h6cb7kqp5uu3kq9mahx0ztkwj.png',
  backgroundFrontType: 'image',
  qrBackgroundType: 'circle',
  qrBackgroundColor: '#fcfcfc',
  backgroundBackType: 'solid',
  backgroundBackColor: '#1f86c7',
  fontColor: '#050505',
  backOpacity: 100,
});
const design10: CardDesign = {
  ...design9,
  background: null,
  qrBackgroundType: 'square',
  backgroundBackColor: '#b842ae',
};

const line = (extra: Partial<DesignEditState> = {}): DesignEditState => ({
  orderId: '100009410',
  status: 'paid',
  sentToPrinter: false,
  printApiOrderId: '',
  type: 'physical',
  designCount: 10,
  ...extra,
});

describe('design-copy: the two sides', () => {
  it('splits every design column into exactly one side', () => {
    const both = [...FRONT_COLUMNS, ...BACK_COLUMNS];
    expect(new Set(both).size).toBe(both.length);
    expect([...both].sort()).toEqual([...CARD_DESIGN_COLUMNS].sort());
  });
});

describe('design-copy: which copies are allowed', () => {
  it('lets a paid printed line through that is not at the printer', () => {
    expect(designCopyRefusal(line(), 10, 1, 'front')).toBeNull();
  });

  it('refuses a design the line does not have, the same design twice and an unknown side', () => {
    expect(designCopyRefusal(line(), 11, 1, 'front')).toMatch(/position must be a design of this line: 1 to 10/);
    expect(designCopyRefusal(line(), 10, 0, 'front')).toMatch(/copyFrom must be/);
    expect(designCopyRefusal(line(), 10, 10, 'front')).toMatch(/same design/);
    expect(designCopyRefusal(line(), 10, 1, 'qr')).toMatch(/front, back or both/);
  });

  it('refuses an order at the printer, by the flag or by a printer order id, and points at printer-reset', () => {
    expect(designCopyRefusal(line({ sentToPrinter: true }), 10, 1, 'front')).toMatch(/printer-reset/);
    expect(designCopyRefusal(line({ printApiOrderId: '1541189' }), 10, 1, 'front')).toMatch(/1541189/);
  });

  it('refuses an unpaid order and a digital line', () => {
    expect(designCopyRefusal(line({ status: 'open' }), 10, 1, 'front')).toMatch(/not paid/);
    expect(designCopyRefusal(line({ type: 'digital' }), 10, 1, 'front')).toMatch(/only a printed line/);
  });
});

describe('design-copy: what changes', () => {
  it('puts the front back and keeps the back colour of design 10', () => {
    const { design, changes } = copiedDesign(design10, design9, 'front');
    expect(Object.keys(changes).sort()).toEqual(['background', 'qrBackgroundType']);
    expect(changes['background']).toEqual({ from: null, to: '1plhcp3h6cb7kqp5uu3kq9mahx0ztkwj.png' });
    expect(changes['qrBackgroundType']).toEqual({ from: 'square', to: 'circle' });
    expect(design.backgroundBackColor).toBe('#b842ae');
  });

  it('copies the back alone, or everything', () => {
    expect(Object.keys(copiedDesign(design10, design9, 'back').changes)).toEqual(['backgroundBackColor']);
    expect(Object.keys(copiedDesign(design10, design9, 'both').changes).sort()).toEqual([
      'background',
      'backgroundBackColor',
      'qrBackgroundType',
    ]);
  });

  it('finds nothing to change when the side is already the same', () => {
    expect(copiedDesign(design9, design9, 'front').changes).toEqual({});
  });

  it('reads stored 0/1 booleans as the same value', () => {
    const stored = { ...design9, hideCircle: 0, useFrontGradient: 0 } as unknown as CardDesign;
    expect(copiedDesign(stored, design9, 'front').changes).toEqual({});
  });
});
