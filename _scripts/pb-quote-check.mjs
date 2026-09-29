#!/usr/bin/env node
// Sends the request PrintEnBindV2.quoteShippingCost() sends (POST
// /orders/calculate, which never creates anything) with this machine's .env,
// and prints which endpoint and which key it used plus Print&Bind's answer.
// Run it on two machines to tell "different config" from "different cart".
//
//   node _scripts/pb-quote-check.mjs [--country NL] [--tracks 100] [--amount 1]
//                                    [--box] [--sheets] [--howto]
//
// The key is shown as a sha256 fingerprint only. Keep the request in step
// with createOrderItem / toPbArticle / buildOrderRequest in
// src/printers/printenbindV2.ts.
import 'dotenv/config';
import { createHash } from 'crypto';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const QUOTE_POSTCODES = { BE: '1000', DE: '10115', FR: '75001', GB: 'SW1A 1AA' };

const country = option('country', 'NL').toUpperCase();
const tracks = parseInt(option('tracks', '100'), 10);
const amount = Math.max(1, parseInt(option('amount', '1'), 10) || 1);

const article = {
  product: 'losbladig',
  color: 'all',
  size: 'custom',
  printside: 'double',
  finishing: 'loose',
  finishing2: 'none',
  finishing_extra: 'none',
  accessory_item: 'none',
  papertype: 'card',
  size_custom_width: 60,
  size_custom_height: 60,
  number: amount,
  copies: tracks * 2 + (flag('howto') ? 2 : 0),
  check_doc: false,
  borderless: true,
  add_inserts: false,
};
if (flag('sheets')) {
  article.copies = Math.ceil(tracks / 12) * 2;
  article.size = 'a4';
  article.borderless = false;
  delete article.size_custom_width;
  delete article.size_custom_height;
}
if (flag('box')) {
  article.accessory_group = 'packaging';
  article.accessory_item = 'box_qrsong';
}

const request = {
  contact: 'John Doe',
  street: 'Some lane',
  number: '1',
  postalcode: QUOTE_POSTCODES[country] || '1234AB',
  city: 'Amsterdam',
  country,
  email: 'orders@qrsong.io',
  delivery_method: country === 'NL' ? 'post' : 'international',
  production_method: 'standard',
  anonymous: true,
  articles: [article],
};

const baseUrl = (process.env.PRINTENBIND_API_URL || '').replace(/\/+$/, '');
const key = process.env.PRINTENBIND_API_KEY || '';
const fingerprint = key
  ? createHash('sha256').update(key).digest('hex').slice(0, 12)
  : '(no key)';

console.log(`endpoint     ${baseUrl}/orders/calculate`);
console.log(`key sha256   ${fingerprint}`);
console.log(`environment  ${process.env.ENVIRONMENT}`);
console.log(`request      ${JSON.stringify(request)}`);

const response = await fetch(`${baseUrl}/orders/calculate`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(request),
  signal: AbortSignal.timeout(15000),
});
const text = await response.text();
console.log(`status       ${response.status} ${response.statusText}`);
console.log(`response     ${text.slice(0, 1500)}`);
