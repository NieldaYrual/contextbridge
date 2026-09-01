// src/utils/manual-capture.ts - CORRECTED VERSION
import { config } from 'dotenv';
config();

import { chromium } from 'playwright';
import { normalizeClaude } from '../core/normalizer.js';
import { upsertThread, listDueTargets, startCaptureRow, finishCaptureRow, touchTarget } from '../core/supabase.js';
import { getConversationUpdateTimes } from '../core/capture-state.js';
import path from 'path';
import readline from 'node:readline';
import type { Response } from 'playwright';

async function manualCapture() {
  console.log('🔧 Manual capture with Cloudflare handling\n');
  
  // Get due targets
  const targets = await listDueTargets();
  if (targets.length === 0) {
    console.log('No targets due');
    return;
  }
  
  const target = targets[0];
  if (!target) {
    console.log('No valid target found');
    return;
  }
  
  console.log(`📋 Processing: ${target.project_url}\n`);
  
  const capture = await startCaptureRow(target.id, target.provider);
  const hits: { url: string; json: any }[] = [];
  const conversationIds: string[] = [];
  
  const profilePath = path.resolve('.cb-profiles', 'claude', 'chrome-copy');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const waitForEnter = () => new Promise<void>((resolve) => {
    rl.question('Press Enter to continue...', () => {
      resolve();
    });
  });
  
  try {
    const context = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      channel: 'chrome',
      viewport: { width: 1366, height: 850 },
      args: ['--disable-blink-features=AutomationControlled']
    });
    
    const page = await context.newPage();
    
    // Set up response listener
    page.on('response', async (res: Response) => {
      try {
        const url = res.url();
        if (!res.ok()) return;
        
        const ct = res.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        
        const json = await res.json().catch(() => null);
        if (!json) return;
        
        // Capture conversation list
        if (url.includes('/conversations_v2') && json.data) {
          console.log(`📋 Found ${json.data.length} conversations in project`);
          for (const conv of json.data) {
            if (!conversationIds.includes(conv.uuid)) {
              conversationIds.push(conv.uuid);
            }
          }
        }
        
        // Log messages
        if (json.chat_messages) {
          console.log(`   💬 Captured ${json.chat_messages.length} messages`);
        }
        
        hits.push({ url, json });
        
      } catch (err) {
        // Silent
      }
    });
    
    console.log(`🌐 Navigating to: ${target.project_url}`);
    await page.goto(target.project_url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    
    // Check if we're on a login or cloudflare page
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('challenge') || currentUrl.includes('cloudflare')) {
      console.log('\n⚠️  Authentication or Cloudflare challenge detected!');
      console.log('Waiting for it to complete automatically or for you to help...\n');
      
      // Wait up to 60 seconds for Cloudflare to resolve
      let resolved = false;
      for (let i = 0; i < 20; i++) { // 20 * 3 seconds = 60 seconds
        await page.waitForTimeout(3000);
        const newUrl = page.url();
        if (!newUrl.includes('challenge') && !newUrl.includes('cloudflare') && newUrl.includes('claude.ai')) {
          console.log('✅ Challenge resolved!\n');
          resolved = true;
          break;
        }
      }
      
      if (!resolved) {
        console.log('Still on challenge page. Press Enter when ready:\n');
        await waitForEnter();
      }
    }
    
    // Wait longer for conversations to load after Cloudflare
    console.log('⏳ Waiting for conversations to load...');
    
    // Try multiple times to get conversations
    for (let attempt = 0; attempt < 10; attempt++) {
      await page.waitForTimeout(2000);
      
      // Trigger potential lazy loading
      await page.keyboard.press('End').catch(() => null);
      await page.waitForTimeout(1000);
      
      if (conversationIds.length > 0) {
        console.log(`✅ Conversations loaded: ${conversationIds.length} found\n`);
        break;
      }
      
      if (attempt === 9) {
        console.log('⚠️ No conversations found after waiting. Proceeding anyway...\n');
      }
    }
    
    // Navigate to each conversation
    if (conversationIds.length > 0) {
      console.log(`\n🔄 Loading ${conversationIds.length} conversations...\n`);
      
      for (let i = 0; i < conversationIds.length; i++) {
        const convId = conversationIds[i];
        if (!convId) continue;
        
        console.log(`[${i+1}/${conversationIds.length}] Loading conversation...`);
        
        const convUrl = `https://claude.ai/chat/${convId}`;
        await page.goto(convUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);
      }
    }
    
    // Process data
    const threads = normalizeClaude(hits);
    console.log(`\n📊 Captured ${threads.length} conversations`);
    
    let totalMessages = 0;
    for (const thread of threads) {
      totalMessages += thread.messages.length;
      await upsertThread('claude', thread, {
        providerProjectId: target.project_url,
        projectName: target.owner_label || 'Claude Project'
      });
    }
    
    console.log(`💾 Saved ${totalMessages} messages`);
    
    await finishCaptureRow(capture.id, true);
    await touchTarget(target.id);
    
    console.log('\n✅ Capture complete!');
    console.log('Press Enter to close browser...');
    await waitForEnter();
    
    await context.close();
    rl.close();
    
  } catch (error) {
    console.error('❌ Error:', error);
    await finishCaptureRow(capture.id, false, String(error));
    rl.close();
  }
}

manualCapture().catch(console.error);