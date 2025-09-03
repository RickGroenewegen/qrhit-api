#!/usr/bin/env node

/**
 * Test script for Google Merchant Center update verification
 * Usage: DEBUG_MERCHANT_CENTER=true npx tsx test-merchant-update.ts
 */

import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

// Enable debug mode for this test
process.env.DEBUG_MERCHANT_CENTER = 'true';

import { merchantCenter } from './src/merchantcenter';
import Logger from './src/logger';
import { blue, green, red, white, yellow } from 'console-log-colors';

const logger = new Logger();

async function testMerchantUpdate() {
  try {
    logger.log(blue.bold('Starting Merchant Center Update Test'));
    logger.log(blue.bold(`Debug mode: ${white.bold('ENABLED')}`));
    
    // First, do a sync to ensure products exist
    logger.log(blue.bold('\n1. Initial sync to ensure products exist...'));
    await merchantCenter.uploadFeaturedPlaylists(1);
    
    // Wait for products to be indexed
    logger.log(blue.bold('\n2. Waiting 3 seconds for indexing...'));
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // List products to see what we have
    logger.log(blue.bold('\n3. Listing current products...'));
    const products = await merchantCenter.listProducts();
    logger.log(blue.bold(`Found ${white.bold(products.length.toString())} products`));
    
    if (products.length > 0) {
      // Show first product details
      const firstProduct = products[0];
      logger.log(blue.bold('\nFirst product details:'));
      logger.log(blue(`  ID: ${white.bold(firstProduct.id)}`));
      logger.log(blue(`  Title: ${white.bold(firstProduct.title)}`));
      logger.log(blue(`  Link: ${white.bold(firstProduct.link)}`));
      logger.log(blue(`  Image: ${white.bold(firstProduct.imageLink?.substring(0, 100))}...`));
    }
    
    // Force an update by running sync again
    // This should trigger updates since images get new timestamps
    logger.log(blue.bold('\n4. Running sync again to trigger updates...'));
    logger.log(yellow.bold('Watch for update debug logs below:'));
    logger.log(yellow('-------------------------------------------'));
    
    await merchantCenter.uploadFeaturedPlaylists(1);
    
    logger.log(yellow('-------------------------------------------'));
    
    // Final check
    logger.log(blue.bold('\n5. Final verification...'));
    const updatedProducts = await merchantCenter.listProducts();
    if (updatedProducts.length > 0 && products.length > 0) {
      const originalImage = products[0].imageLink;
      const updatedImage = updatedProducts[0].imageLink;
      
      if (originalImage !== updatedImage) {
        logger.log(green.bold('✓ Image URL changed successfully!'));
        logger.log(green(`  Original: ${white.bold(originalImage?.substring(0, 100))}...`));
        logger.log(green(`  Updated:  ${white.bold(updatedImage?.substring(0, 100))}...`));
      } else {
        logger.log(yellow.bold('⚠️ Image URL did not change - may indicate caching or update issue'));
      }
    }
    
    logger.log(green.bold('\n✓ Update test completed'));
  } catch (error) {
    logger.log(red(`Test failed: ${error}`));
    process.exit(1);
  }
}

// Run test if this file is executed directly
if (require.main === module) {
  testMerchantUpdate()
    .then(() => {
      logger.log(green.bold('✓ All tests completed'));
      process.exit(0);
    })
    .catch((error) => {
      logger.log(red(`Test execution failed: ${error}`));
      process.exit(1);
    });
}