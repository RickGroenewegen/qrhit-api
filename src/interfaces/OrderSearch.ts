export interface OrderSearch {
  status?: string;
  finalized?: boolean;
  page: number;
  itemsPerPage: number;
  textSearch: string;
  printerHold?: boolean;
  needsAttention?: boolean;
  // Former name of needsAttention
  notSubmitted?: boolean;
  printerType?: string;
  // Music service of the ordered playlists: spotify, youtube_music, ...
  serviceType?: string;
}
