export interface OrderSearch {
  status?: string;
  finalized?: boolean;
  page: number;
  itemsPerPage: number;
  textSearch: string;
  physical: boolean;
}
