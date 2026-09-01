// src/utils/copy-chrome-profile.ts
import { config } from 'dotenv';
config();

import fs from 'fs-extra';
import path from 'path';
import os from 'os';

async function copyChrome() {
  console.log('📋 Copying Chrome profile for Playwright use...\n');
  
  const homeDir = os.homedir();
  const chromeSource = path.join(homeDir, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  const playwrightDest = path.join('.cb-profiles', 'claude', 'chrome-copy');
  
  // Check if Chrome profile exists
  if (!fs.existsSync(chromeSource)) {
    console.error('❌ Chrome profile not found at:', chromeSource);
    return;
  }
  
  console.log('📁 Source:', chromeSource);
  console.log('📁 Destination:', path.resolve(playwrightDest));
  
  // Important files to copy for session
  const importantFiles = [
    'Default/Cookies',
    'Default/Cookies-journal',
    'Default/Network/Cookies',
    'Default/Network/Cookies-journal',
    'Default/Preferences',
    'Default/Network/Network Persistent State',
    'Local State'
  ];
  
  console.log('\n📦 Copying essential files...');
  
  // Create destination directory
  await fs.ensureDir(playwrightDest);
  await fs.ensureDir(path.join(playwrightDest, 'Default'));
  await fs.ensureDir(path.join(playwrightDest, 'Default', 'Network'));
  
  for (const file of importantFiles) {
    const srcFile = path.join(chromeSource, file);
    const destFile = path.join(playwrightDest, file);
    
    if (fs.existsSync(srcFile)) {
      await fs.copy(srcFile, destFile, { overwrite: true });
      console.log(`   ✅ Copied: ${file}`);
    } else {
      console.log(`   ⚠️  Skipped (not found): ${file}`);
    }
  }
  
  console.log('\n✅ Profile copy complete!');
  console.log('📌 You can now run: npx tsx src/utils/test-copied-profile.ts');
}

copyChrome().catch(console.error);