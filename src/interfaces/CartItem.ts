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
  serviceType?: string; // Music service: spotify, youtube_music, apple_music, deezer, tidal
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
  frontOpacity?: number; // Front background image opacity 0-100 (default 100% fully visible)
  backOpacity?: number; // Back background image opacity 0-100 (default 50%)
  design?: any; // Complete design object from localStorage (saved to database for new playlists)
  gamesEnabled?: boolean; // Whether games (bingo/quiz) are included (default: true for digital)
}
