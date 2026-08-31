// Mollie method and locale ids as plain string unions, mirroring the wire
// values of the generated SDK's MethodEnum and Locale2.
//
// The SDK exposes those two enums only behind a subpath export, which this
// project's node10 module resolution cannot see. The values are plain strings
// and are what we persist and compare against anyway (Payment.paymentMethod
// doubles as an invoice translation key, see src/views/invoice.ejs), so the
// ids are mirrored here instead. Regenerate from the SDK's
// dist/commonjs/models/{methodenum,locale2}.d.ts when it adds new values.
//
// Which methods we actually offer per country lives in METHODS_BY_COUNTRY in
// src/mollie.ts; its client-side mirror is qrhit/src/data/payment-methods.ts.

/** Every payment method Mollie accepts when creating a payment. */
export type MollieMethod =
  | 'alma'
  | 'applepay'
  | 'bacs'
  | 'bancomatpay'
  | 'bancontact'
  | 'banktransfer'
  | 'belfius'
  | 'billie'
  | 'billink'
  | 'bizum'
  | 'blik'
  | 'creditcard'
  | 'directdebit'
  | 'eps'
  | 'giftcard'
  | 'ideal'
  | 'in3'
  | 'kbc'
  | 'klarna'
  | 'mbway'
  | 'mobilepay'
  | 'multibanco'
  | 'mybank'
  | 'paybybank'
  | 'paypal'
  | 'paysafecard'
  | 'pointofsale'
  | 'przelewy24'
  | 'riverty'
  | 'satispay'
  | 'swish'
  | 'trustly'
  | 'twint'
  | 'vipps'
  | 'voucher';

/** Every locale Mollie accepts for a payment's checkout page. */
export type MollieLocale =
  | 'ca_ES'
  | 'cs_CZ'
  | 'da_DK'
  | 'de_AT'
  | 'de_CH'
  | 'de_DE'
  | 'de_LU'
  | 'en_BE'
  | 'en_GB'
  | 'en_NL'
  | 'en_US'
  | 'es_ES'
  | 'fi_FI'
  | 'fr_BE'
  | 'fr_FR'
  | 'fr_LU'
  | 'hu_HU'
  | 'is_IS'
  | 'it_IT'
  | 'lt_LT'
  | 'lv_LV'
  | 'nb_NO'
  | 'nl_BE'
  | 'nl_NL'
  | 'pl_PL'
  | 'pt_PT'
  | 'sk_SK'
  | 'sv_SE';
