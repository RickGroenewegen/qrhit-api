/**
 * Prints the blog price token names (src/priceTokens.ts) as JSON, for
 * growth-oracle's blog lint (`pillars.blog.priceTokensCommand`). Names only:
 * no database, no running API.
 *
 *   npm run -s price-tokens
 */
import { priceTokenNames } from '../src/priceTokens';

process.stdout.write(JSON.stringify({ names: priceTokenNames() }) + '\n');
