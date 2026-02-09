// QRGames upgrade price in EUR
export const QRGAMES_UPGRADE_PRICE = 9.00;

// Discount tiers for multiple playlist upgrades
export const QRGAMES_DISCOUNT_TIERS = [
  { minCount: 4, discount: 0.30 },  // 30% off for 4+
  { minCount: 3, discount: 0.20 },  // 20% off for 3
  { minCount: 2, discount: 0.10 },  // 10% off for 2
];

// Calculate price per playlist based on quantity
export function calculateGamesUpgradePrice(quantity: number): {
  pricePerPlaylist: number;
  totalPrice: number;
  originalTotal: number;
  discount: number;
  savings: number;
} {
  const originalTotal = quantity * QRGAMES_UPGRADE_PRICE;

  let discount = 0;
  for (const tier of QRGAMES_DISCOUNT_TIERS) {
    if (quantity >= tier.minCount) {
      discount = tier.discount;
      break;
    }
  }

  const pricePerPlaylist = QRGAMES_UPGRADE_PRICE * (1 - discount);
  const totalPrice = quantity * pricePerPlaylist;
  const savings = originalTotal - totalPrice;

  return {
    pricePerPlaylist: Math.round(pricePerPlaylist * 100) / 100,
    totalPrice: Math.round(totalPrice * 100) / 100,
    originalTotal: Math.round(originalTotal * 100) / 100,
    discount: discount * 100,
    savings: Math.round(savings * 100) / 100,
  };
}
