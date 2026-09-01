// src/utils/setup-profile-stealth.ts
import { config } from 'dotenv';
config();

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'node:path';
import fs from 'node:fs';

// Add stealth plugin
chromium.use(StealthPlugin());

const ROOT = process.env.PLAYWRIGHT_PROFILE_ROOT || '.cb-profiles';

async function setupProfileWithStealth() {
  const provider = 'claude';
  const ownerLabel = null as string | null;
  
  const bucket = ownerLabel?.trim()?.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') ?? 'default';

  const userDataDir = path.resolve(ROOT, provider, bucket);
  fs.mkdirSync(userDataDir, { recursive: true });
  
  console.log('🌐 Opening stealth browser for manual login...');
  console.log(`   Provider: ${provider}`);
  console.log(`   Profile: ${ownerLabel || 'default'}`);
  
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    
    // Try to use actual Chrome if available (only include channel on Windows)
    ...(process.platform === 'win32' && { channel: 'chrome' }),
    
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1366,850'
    ],
    
    viewport: { width: 1366, height: 850 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles'
  });
  
  const page = await ctx.newPage();
  
  // Add additional evasion
  await (page as any).evaluateOnNewDocument(() => {
    // Remove webdriver property
    delete (navigator as any).__proto__.webdriver;
    
    // Mock plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', length: 1 },
        { name: 'Chrome PDF Viewer', length: 1 },
        { name: 'Native Client', length: 1 }
      ]
    });
    
    // Mock languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });
  });
  
  console.log(`📍 Navigating to Claude login...`);
  await page.goto('https://claude.ai/login', { waitUntil: 'networkidle' });
  
  console.log('\n✋ Please complete the following:');
  console.log('   1. Complete the Cloudflare challenge if it appears');
  console.log('   2. Log in to your Claude account');
  console.log('   3. Make sure you can see your conversations');
  console.log('\n⚠️  Keep this window open until you\'re fully logged in');
  console.log('📌 Press Ctrl+C when done to save the profile\n');
  
  // Keep browser open indefinitely
  await new Promise(() => {});
}

setupProfileWithStealth().catch(console.error);