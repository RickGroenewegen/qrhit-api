export interface CartItem {
  type: 'digital' | 'physical' | 'sheets';
  subType: 'sheets' | 'none';
  playlistId: string;
  playlistName: string;
  numberOfTracks: number;
  amount: number;
  price: number;
  extraPrice?: number;
  image: string;
  productType: string;
  fromName?: string;
  personalMessage?: string;
  doubleSided?: boolean;
  qrColor?: string;
  hideCircle?: boolean; // DEPRECATED: Use qrBackgroundType instead
  qrBackgroundType?: 'none' | 'circle' | 'square'; // Background shape for QR code (default: 'square')
  qrBackgroundColor?: string; // Background color of the QR code square/circle (default: '#ffffff')
  eco?: boolean;
  isSlug?: boolean;
  emoji?: string;
  background?: string;
  logo?: string;
  selectedFont?: string;
  selectedFontSize?: string;
  // Front side color/gradient
  backgroundFrontType?: 'solid' | 'image';
  backgroundFrontColor?: string;
  useFrontGradient?: boolean;
  gradientFrontColor?: string;
  gradientFrontDegrees?: number;
  gradientFrontPosition?: number;
  // Back side
  backgroundBackType?: 'solid' | 'image';
  backgroundBack?: string;
  backgroundBackColor?: string;
  fontColor?: string;
  useGradient?: boolean;
  gradientBackgroundColor?: string;
  gradientDegrees?: number;
  gradientPosition?: number;
}
