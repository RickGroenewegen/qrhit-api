// Test the rounding fix for Tromp calculation

function calculateTromp(quantity, printingType, profitMargin = 0) {
  let boxPrice;
  let cardPrice;

  if (printingType === 'voorbedrukt') {
    boxPrice = 1.165 * quantity;
  } else {
    boxPrice = (quantity * 0.335) + 830;
  }

  cardPrice = (quantity * 5.9) + 250;

  // Calculate per-unit prices
  const baseCostPerSet = (boxPrice + cardPrice) / quantity;
  const profitPerSet = profitMargin || 0;
  const pricePerSet = Math.round((baseCostPerSet + profitPerSet) * 100) / 100;

  // Calculate totals from the rounded pricePerSet to maintain consistency
  const subtotalFromRounded = pricePerSet * quantity;
  const clientPrice = subtotalFromRounded;

  // Calculate ourProfit and trompCost for display
  const ourProfit = profitMargin * quantity;
  const trompCost = subtotalFromRounded - ourProfit;

  return {
    quantity,
    printingType,
    profitMargin,
    boxPrice: boxPrice.toFixed(2),
    cardPrice: cardPrice.toFixed(2),
    baseCostPerSet: baseCostPerSet.toFixed(4),
    pricePerSet: pricePerSet.toFixed(2),
    subtotalFromRounded: subtotalFromRounded.toFixed(2),
    trompCost: trompCost.toFixed(2),
    ourProfit: ourProfit.toFixed(2),
    clientPrice: clientPrice.toFixed(2),
    verification: `${quantity} × €${pricePerSet.toFixed(2)} = €${subtotalFromRounded.toFixed(2)}`
  };
}

// Test case that user mentioned: 75 sets
console.log('\n=== Testing 75 sets with different scenarios ===\n');

// Test various profit margins to find which gives €27.64
const testProfits = [0, 5, 7, 7.01, 7.02];
testProfits.forEach(profit => {
  const result = calculateTromp(75, 'eigen', profit);
  console.log(`Profit margin: €${profit}/unit`);
  console.log(`  Per set: €${result.pricePerSet}`);
  console.log(`  Total: €${result.clientPrice}`);
  console.log(`  Verification: ${result.verification}`);
  console.log('');
});
