export interface CartItem {
  type: 'digital' | 'physical';
  playlistId: string;
  playlistName: string;
  amountOfTracks: number;
  amount: number;
  price: number;
}
