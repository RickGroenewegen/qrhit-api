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
  eco?: boolean;
  isSlug?: boolean;
  emoji?: string;
}
