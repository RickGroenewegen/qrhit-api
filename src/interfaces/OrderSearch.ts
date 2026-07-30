export interface OrderSearch {
  status?: string;
  finalized?: boolean;
  page: number;
  itemsPerPage: number;
  textSearch: string;
  printerHold?: boolean;
  notSubmitted?: boolean;
  printerType?: string;
  // Music service of the ordered playlists: spotify, youtube_music, ...
  serviceType?: string;
}
