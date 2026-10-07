// What getOrderType answers: the sales price of one deck in EUR incl. VAT,
// and in `alternatives` what the other card types cost on top of it.
export interface OrderTypePrice {
  digital: boolean;
  amount: number;
  alternatives: any;
}
