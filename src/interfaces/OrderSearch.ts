export interface OrderSearch {
  status?: string;
  finalized?: boolean;
  page: number;
  itemsPerPage: number;
  textSearch: string;
  printerHold?: boolean;
  notSubmitted?: boolean;
  printerType?: string;
}
