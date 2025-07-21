export interface SingleItemCalculation {
  productType: 'cards' | 'giftcard';
  type: 'physical' | 'digital';
  //format: 'cards' | 'a4' | 'single' | 'double';
  //colorMode: 'color' | 'bw';
  subType: 'sheets' | 'none';
  quantity: number;
  alternatives: any;
}
