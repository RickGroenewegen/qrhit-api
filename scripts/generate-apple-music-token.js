/**
 * Generate Apple Music Developer Token
 *
 * Usage: node scripts/generate-apple-music-token.js /path/to/AuthKey_XXXXX.p8
 *
 * This will output a JWT token valid for 180 days (maximum allowed by Apple)
 */

const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

// Your Apple Music API credentials
const TEAM_ID = '7CNC4K97KZ';
const KEY_ID = 'SDLGY6JW4Y';

// Get the P8 file path from command line argument
const p8FilePath = process.argv[2];

if (!p8FilePath) {
  console.error('Usage: node scripts/generate-apple-music-token.js /path/to/AuthKey_XXXXX.p8');
  process.exit(1);
}

// Read the private key
let privateKey;
try {
  privateKey = fs.readFileSync(path.resolve(p8FilePath), 'utf8');
} catch (error) {
  console.error(`Error reading P8 file: ${error.message}`);
  process.exit(1);
}

// Generate the token
const now = Math.floor(Date.now() / 1000);
const expirationTime = now + (180 * 24 * 60 * 60); // 180 days (maximum allowed)

const token = jwt.sign(
  {
    iss: TEAM_ID,
    iat: now,
    exp: expirationTime,
  },
  privateKey,
  {
    algorithm: 'ES256',
    header: {
      alg: 'ES256',
      kid: KEY_ID,
    },
  }
);

console.log('\n=== Apple Music Developer Token ===\n');
console.log(token);
console.log('\n=== Token Info ===');
console.log(`Team ID: ${TEAM_ID}`);
console.log(`Key ID: ${KEY_ID}`);
console.log(`Issued: ${new Date(now * 1000).toISOString()}`);
console.log(`Expires: ${new Date(expirationTime * 1000).toISOString()}`);
console.log('\n=== Add to .env ===');
console.log(`APPLE_MUSIC_DEVELOPER_TOKEN=${token}`);
console.log('');
