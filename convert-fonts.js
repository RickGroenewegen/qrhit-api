const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const fontsDir = path.join(__dirname, 'assets', 'fonts');
const fonts = [
  'Moret-Bold.otf',
  'Moret-BookOblique.otf'
];

console.log('Converting OTF fonts to WOFF2...\n');

fonts.forEach(font => {
  const inputPath = path.join(fontsDir, font);
  const outputPath = inputPath.replace('.otf', '.woff2');

  if (!fs.existsSync(inputPath)) {
    console.error(`❌ Font not found: ${inputPath}`);
    return;
  }

  try {
    // Use pyftsubset from fonttools to convert OTF to WOFF2
    // This preserves all glyphs and metadata
    const cmd = `pyftsubset "${inputPath}" --output-file="${outputPath}" --flavor=woff2 --unicodes="*"`;
    console.log(`Converting ${font}...`);
    execSync(cmd, { stdio: 'inherit' });
    console.log(`✓ Created ${path.basename(outputPath)}\n`);
  } catch (error) {
    console.error(`❌ Error converting ${font}:`, error.message);
    console.log('\nMake sure fonttools is installed:');
    console.log('  pip install fonttools brotli\n');
  }
});

console.log('Done!');
