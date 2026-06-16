/**
 * HausFrames – V2 Local Test Script
 * File: test-v2-local.js
 *
 * Run this locally to test the pipeline without going through Shopify/browser.
 *
 * Usage:
 *   node test-v2-local.js path/to/floorplan.png
 *
 * Requirements:
 *   - Your .env.local must have OPENAI_API_KEY, CLOUDINARY_* set
 *   - Run from your project root: node test-v2-local.js
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const [,, inputFile] = process.argv;

if (!inputFile) {
  console.error('Usage: node test-v2-local.js path/to/floorplan.png');
  process.exit(1);
}

async function main() {
  const absPath = path.resolve(inputFile);
  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  const fileBuffer = fs.readFileSync(absPath);
  const ext = path.extname(absPath).slice(1).toLowerCase();
  const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
  const imageDataUri = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;

  console.log(`\n📐 Testing V2 pipeline with: ${absPath}`);
  console.log(`   File size: ${(fileBuffer.length / 1024).toFixed(1)} KB`);
  console.log('   Calling /api/generate-v2-test...\n');

  const response = await fetch('http://localhost:3000/api/generate-v2-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageDataUri }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('❌ Error:', data.error);
    process.exit(1);
  }

  console.log('✅ Pipeline complete!\n');
  console.log('─'.repeat(60));
  console.log(`Job ID:              ${data.jobId}`);
  console.log('─'.repeat(60));
  console.log(`Step 0 – Original:   ${data.step0_originalUrl}`);
  console.log(`Step 1A – B&W PNG:   ${data.step1a_bwUrl}`);
  console.log(`Step 1B – SVG file:  ${data.step1b_svgUrl}`);
  console.log(`Step 1C – SVG→PNG:   ${data.step1c_svgRenderUrl}`);
  console.log(`Step 2 – Furniture:  ${data.step2_furnitureUrl}`);
  console.log(`Step 3 – Wooden:     ${data.step3_woodenUrl}`);
  console.log('─'.repeat(60));
  console.log('\n👆 Open each URL in sequence to validate the pipeline.');
  console.log('   Key things to check:');
  console.log('   • Step 1A: Are all walls solid black? No grey fuzz?');
  console.log('   • Step 1B: Open SVG — do walls look clean and straight?');
  console.log('   • Step 1C: Does SVG→PNG match Step 1A?');
  console.log('   • Step 2: Is furniture placed sensibly inside rooms?');
  console.log('   • Step 3: Does wooden render match Step 2 geometry?\n');
}

main().catch(err => {
  console.error('❌ Unexpected error:', err);
  process.exit(1);
});
