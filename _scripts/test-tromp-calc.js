// Test the Tromp calculation formulas

function calculateTromp(quantity, printingType) {
  let boxPrice;
  let cardPrice;

  if (printingType === 'voorbedrukt') {
    // Voorbedrukt (pre-printed) - Formula from D9
    // Boxes: (1165 / 1000) * quantity = 1.165 * quantity
    boxPrice = 1.165 * quantity;
  } else {
    // Eigen bedrukking (own printing) - Formula from B9
    // Boxes: (quantity * 0.335) + 830
    boxPrice = (quantity * 0.335) + 830;
  }

  // Cards pricing is the same for both types - Formula from B10/D10
  // Cards: (quantity * 5.9) + 250
  cardPrice = (quantity * 5.9) + 250;

  // Calculate per-unit prices
  const boxPricePerUnit = boxPrice / quantity;
  const cardPricePerUnit = cardPrice / quantity;

  // Totals
  const total = boxPrice + cardPrice;
  const perUnit = total / quantity;

  return {
    quantity,
    printingType,
    boxPrice: boxPrice.toFixed(2),
    cardPrice: cardPrice.toFixed(2),
    total: total.toFixed(2),
    perUnit: perUnit.toFixed(2),
    boxPricePerUnit: boxPricePerUnit.toFixed(2),
    cardPricePerUnit: cardPricePerUnit.toFixed(2)
  };
}

// Test cases
console.log('\n=== Testing Tromp Calculator ===\n');

const testCases = [
  { qty: 100, type: 'eigen' },
  { qty: 100, type: 'voorbedrukt' },
  { qty: 500, type: 'eigen' },
  { qty: 500, type: 'voorbedrukt' },
  { qty: 1000, type: 'eigen' },
  { qty: 1000, type: 'voorbedrukt' },
];

testCases.forEach(test => {
  const result = calculateTromp(test.qty, test.type);
  console.log(`Quantity: ${result.quantity} | Type: ${result.printingType}`);
  console.log(`  Boxes: €${result.boxPrice} (€${result.boxPricePerUnit}/unit)`);
  console.log(`  Cards: €${result.cardPrice} (€${result.cardPricePerUnit}/unit)`);
  console.log(`  Total: €${result.total}`);
  console.log(`  Per Unit: €${result.perUnit}`);
  console.log('');
});

console.log('=== Test Complete ===\n');
