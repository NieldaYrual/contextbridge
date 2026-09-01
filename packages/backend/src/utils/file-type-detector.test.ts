// packages/backend/src/utils/file-type-detector.test.ts
import { detectFileType } from './file-type-detector';

async function runTests() {
  console.log('Testing robust file type detection...\n');

  // Test 1: JavaScript file by extension
  const jsResult = await detectFileType('app.js', 'const x = 5;');
  console.log('Test 1 - JavaScript by extension:');
  console.log(jsResult);
  console.log('✓ Should be: code/js/javascript\n');

  // Test 2: Python file by shebang
  const pyResult = await detectFileType('script', '#!/usr/bin/env python\nprint("hello")');
  console.log('Test 2 - Python by shebang:');
  console.log(pyResult);
  console.log('✓ Should be: code/py/python\n');

  // Test 3: TypeScript by syntax
  const tsResult = await detectFileType('module.ts', 'const name: string = "test";');
  console.log('Test 3 - TypeScript by syntax:');
  console.log(tsResult);
  console.log('✓ Should be: code/ts/typescript\n');

  // Test 4: Markdown by syntax
  const mdResult = await detectFileType('README.md', '# Title\n\n## Subtitle\n\n- Item 1');
  console.log('Test 4 - Markdown by syntax:');
  console.log(mdResult);
  console.log('✓ Should be: document/md/markdown\n');

  // Test 5: JSON
  const jsonResult = await detectFileType('config.json', '{"key": "value"}');
  console.log('Test 5 - JSON:');
  console.log(jsonResult);
  console.log('✓ Should be: data/json/json\n');

  console.log('All tests completed!');
}

runTests().catch(console.error);