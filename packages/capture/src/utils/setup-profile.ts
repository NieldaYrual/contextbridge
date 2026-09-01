// src/utils/setup-profile.ts
import { config } from 'dotenv';
config();

import { getContextFor } from '../core/browser.js';

async function setupProfile() {
  const provider = process.argv[2] || 'claude';
  const ownerLabel = process.argv[3] || null;
  
  console.log('🌐 Opening browser for manual login...');
  console.log(`   Provider: ${provider}`);
  console.log(`   Profile: ${ownerLabel || 'default'}`);
  
  const ctx = await getContextFor(provider, ownerLabel, false); // false = not headless
  const page = await ctx.newPage();
  
  const loginUrl = provider === 'claude' 
    ? 'https://claude.ai/login'
    : 'https://chat.openai.com/auth/login';
    
  console.log(`📍 Navigating to: ${loginUrl}`);
  await page.goto(loginUrl);
  
  console.log('\n✋ Please complete the following:');
  console.log('   1. Log in to your account');
  console.log('   2. Complete any verification steps');
  console.log('   3. Make sure you can see your conversations');
  console.log('\n⚠️  Keep this window open until you\'re fully logged in');
  console.log('📌 Press Ctrl+C when done to save the profile\n');
  
  // Keep browser open indefinitely
  await new Promise(() => {});
}

setupProfile().catch(console.error);