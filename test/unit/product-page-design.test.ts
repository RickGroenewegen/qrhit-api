import { describe, it, expect } from 'vitest';
import { productPageDesign } from '../../src/data/productPageDesign';

const DESIGN = { backgroundImage: 'birthday.png', qrColor: '#ff0000' };

describe('productPageDesign', () => {
  it('shows the stored design when the customer shared it and no admin vetoed it', () => {
    expect(
      productPageDesign({ design: DESIGN, promotionalShareDesign: true, featuredDesignHidden: false })
    ).toBe(DESIGN);
  });

  it('keeps the design of a curated list or an older submission, which never answered', () => {
    // The customer column defaults to true and the veto to false.
    expect(productPageDesign({ design: DESIGN })).toBe(DESIGN);
  });

  it('falls back to the standard design when the customer kept theirs private', () => {
    expect(
      productPageDesign({ design: DESIGN, promotionalShareDesign: false, featuredDesignHidden: false })
    ).toBeNull();
  });

  it('falls back to the standard design when an admin vetoed it, whatever the customer answered', () => {
    expect(
      productPageDesign({ design: DESIGN, promotionalShareDesign: true, featuredDesignHidden: true })
    ).toBeNull();
  });

  it('has nothing to show without a stored design', () => {
    expect(productPageDesign({ design: null, promotionalShareDesign: true })).toBeNull();
  });
});
