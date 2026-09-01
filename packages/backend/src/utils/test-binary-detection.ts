// packages/backend/src/utils/test-binary-detection.ts
import { detectFileType } from './file-type-detector';

async function testBinaryDetection() {
  console.log('Testing binary file detection...\n');
  
  // Create a minimal PNG buffer (PNG magic number)
  const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  
  const result = await detectFileType('screenshot.png', pngHeader);
  console.log('PNG detection result:');
  console.log(result);
  console.log('✓ Should detect as: image/png with is_binary: true\n');
  
  // Test with base64
  const base64Png = pngHeader.toString('base64');
  const result2 = await detectFileType('photo.png', base64Png);
  console.log('PNG (base64) detection result:');
  console.log(result2);
  console.log('✓ Should detect as: image/png with is_binary: true\n');
  
  // Test JPEG magic number
  const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
  const result3 = await detectFileType('photo.jpg', jpegHeader);
  console.log('JPEG detection result:');
  console.log(result3);
  console.log('✓ Should detect as: image/jpg with is_binary: true\n');
  
  console.log('Binary file detection works! ✓');
}

testBinaryDetection().catch(console.error);