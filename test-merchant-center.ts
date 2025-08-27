#!/usr/bin/env node

/**
 * Test script for Google Merchant Center integration
 * Usage: npx tsx test-merchant-center.ts
 */

import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

import { merchantCenter } from './src/merchantcenter';
import Logger from './src/logger';
import { blue, green, red, white } from 'console-log-colors';

const logger = new Logger();

async function testMerchantCenter() {
  try {
    const isDevelopment = process.env['ENVIRONMENT'] === 'development';
    logger.log(blue.bold(`Starting Merchant Center test${isDevelopment ? ' (DEVELOPMENT MODE)' : ''}`));
    
    if (isDevelopment) {
      logger.log(blue.bold(`Development mode: ${white.bold('1 playlist')}, ${white.bold('en/nl/de')} locales only`));
    }
    
    // Test uploading featured playlists (limited in dev mode)
    logger.log(blue.bold('Uploading featured playlists...'));
    await merchantCenter.uploadFeaturedPlaylists(2);
    
    // List all products
    logger.log(blue.bold('Listing products...'));
    const products = await merchantCenter.listProducts();
    logger.log(blue.bold(`Found ${white.bold(products.length.toString())} products`));
    
    logger.log(green.bold('✓ Test completed successfully'));
  } catch (error) {
    logger.log(red(`Test failed: ${error}`));
    process.exit(1);
  }
}

// Run test if this file is executed directly
if (require.main === module) {
  testMerchantCenter()
    .then(() => {
      logger.log(green.bold('✓ All tests passed'));
      process.exit(0);
    })
    .catch((error) => {
      logger.log(red(`Test execution failed: ${error}`));
      process.exit(1);
    });
}