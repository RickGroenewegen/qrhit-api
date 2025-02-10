export interface SingleItemCalculation {
  type: 'physical' | 'digital';
  format: 'cards' | 'a4' | 'single' | 'double';
  colorMode: 'color' | 'bw';
  quantity: number;
  alternatives: any;
}
