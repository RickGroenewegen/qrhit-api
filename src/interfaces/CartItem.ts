export interface CartItem {
  type: 'digital' | 'physical';
  playlistId: string;
  playlistName: string;
  numberOfTracks: number;
  amount: number;
  price: number;
  image: string;
}
