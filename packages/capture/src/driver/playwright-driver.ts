// packages/capture/src/driver/playwright-driver.ts

import { chromium } from 'playwright';
import type { BrowserContext, Page, Browser } from 'playwright';
import WebSocket from 'ws';
import path from 'path';
import fs from 'fs-extra';
import readline from 'readline';
import { encoding_for_model } from 'tiktoken';

interface ConversationToCapture {
  id: string;
  url: string;
  title?: string;
}

const tokenEncoder = encoding_for_model('gpt-4');

function countTokens(text: string): number {
  try {
    const tokens = tokenEncoder.encode(text);
    return tokens.length;
  } catch (error) {
    return Math.ceil(text.length / 4);
  }
}

async function getProjectInfo(): Promise<{ projectUrl: string; projectId: string }> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    console.log('\n📋 ContextBridge Project Capture');
    console.log('=================================');
    console.log('\n1. Make sure Chrome is open with your Claude project');
    console.log('2. Make sure the ContextBridge extension is installed');
    console.log('3. Enter your project URL below:\n');
    console.log('Example: https://claude.ai/project/0198a07b-7fa1-75e2-8834-ca8a703c3469');
    
    rl.question('\nProject URL: ', (url) => {
      const match = url.match(/\/project\/([a-f0-9-]+)/);
      const projectId = match?.[1] || 'default-project';
      
      console.log(`\n✅ Project ID: ${projectId}`);
      rl.close();
      
      resolve({
        projectUrl: url.trim(),
        projectId: projectId
      });
    });
  });
}

function waitForKey(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    });
  });
}

export class PlaywrightDriver {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private ws: WebSocket | null = null;
  private projectId: string;
  private capturedCount = 0;
  private apiCallsReceived = 0;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  async connectToHub(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket('ws://localhost:3001/ws');
      
      this.ws.on('open', () => {
        console.log('✅ Connected to backend');
        this.ws!.send(JSON.stringify({
          t: 'join',
          projectId: this.projectId,
          role: 'driver'
        }));
        resolve();
      });
      
      this.ws.on('error', (err) => {
        console.error('❌ WebSocket error:', err.message);
        reject(err);
      });
      
      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          
          if (msg.t === 'capture_saved') {
            this.capturedCount++;
            console.log(`   💾 Saved: ${msg.conversationId} (${msg.messages} messages, ${msg.tokens} tokens)`);
          }
          
          if (msg.t === 'api_hit') {
            this.apiCallsReceived++;
          }
        } catch {}
      });
    });
  }

  async connectToChrome(): Promise<void> {
    console.log('\n🔍 Looking for Chrome with debugging enabled...');
    
    // First, try the standard debugging port
    try {
      this.browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
      console.log('✅ Connected to Chrome (port 9222)');
    } catch {
      try {
        // Try alternate port
        this.browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
        console.log('✅ Connected to Chrome (port 9333)');
      } catch (err) {
        console.log('\n❌ Could not connect to Chrome!');
        console.log('\nTo fix this:');
        console.log('1. Close ALL Chrome windows');
        console.log('2. Open Chrome with this command:');
        console.log('   chrome.exe --remote-debugging-port=9222');
        console.log('3. Install the ContextBridge extension');
        console.log('4. Navigate to your Claude project');
        console.log('5. Run this script again\n');
        throw new Error('Chrome debugging port not available');
      }
    }
    
    const contexts = this.browser.contexts();
    if (contexts.length === 0) {
      throw new Error('No Chrome windows found');
    }
    
    this.context = contexts[0] || null;
    if (!this.context) {
      throw new Error('No browser context available');
    }
    const pages = this.context.pages();
    
    // Find the Claude tab
    let claudePage = null;
    for (const page of pages) {
      try {
        const url = page.url();
        if (url.includes('claude.ai')) {
          claudePage = page;
          console.log(`✅ Found Claude tab: ${url.substring(0, 50)}...`);
          break;
        }
      } catch (error) {
        // Skip invalid pages
        continue;
      }
    }
    
    if (!claudePage) {
      throw new Error('No Claude.ai tab found. Please open Claude in Chrome first.');
    }
    
    this.page = claudePage;
  }

  async activateExtension(): Promise<void> {
    if (!this.page) return;
    
    console.log('\n🔌 Checking extension...');
    console.log('   Click the ContextBridge extension icon in Chrome NOW');
    console.log('   (Look for it in the Chrome toolbar)\n');
    console.log('   Press any key after clicking the extension...');
    
    await waitForKey();
    console.log('✅ Extension should now be active\n');
  }

  async extractConversations(): Promise<ConversationToCapture[]> {
    if (!this.page) return [];
    
    console.log('📋 Extracting conversation list...');
    
    const conversations = await this.page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/chat/"]'));
      
      // Filter to main content area
      const mainArea = document.querySelector('main') || document;
      const validLinks = links.filter(link => mainArea.contains(link));
      
      return validLinks.map(link => ({
        id: link.getAttribute('href')?.split('/chat/')[1]?.split('?')[0] || '',
        url: (link as HTMLAnchorElement).href,
        title: link.textContent?.trim() || 'Untitled'
      }));
    });
    
    // Remove duplicates
    const unique = Array.from(new Map(conversations.map(c => [c.id, c])).values());
    return unique.filter(c => c.id);
  }

  async captureConversations(conversations: ConversationToCapture[]): Promise<void> {
    console.log(`\n🚀 Starting capture of ${conversations.length} conversations...\n`);
    
    for (let i = 0; i < conversations.length; i++) {
      const conv = conversations[i];
      if (!conv) continue;
      console.log(`[${i+1}/${conversations.length}] ${conv.title}`);
      
      try {
        // Navigate to conversation
        await this.page!.goto(conv.url, { 
          waitUntil: 'domcontentloaded',
          timeout: 30000 
        });
        
        // Wait for content to load
        await this.page!.waitForTimeout(2000);
        
        // Force refresh to trigger API call
        console.log('   🔄 Refreshing to capture data...');
        await this.page!.reload({ waitUntil: 'domcontentloaded' });
        
        // Give extension time to capture
        await this.page!.waitForTimeout(3000);
        
        // Progress update
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            t: 'progress',
            projectId: this.projectId,
            pct: Math.round(((i + 1) / conversations.length) * 100),
            note: `${i + 1} of ${conversations.length}`
          }));
        }
        
      } catch (error) {
        console.log(`   ❌ Failed: ${error}`);
      }
      
      // Rate limiting
      if (i < conversations.length - 1) {
        await this.page!.waitForTimeout(1500);
      }
    }
  }

  async showSummary(): Promise<void> {
    console.log('\n' + '='.repeat(50));
    console.log('📊 CAPTURE COMPLETE');
    console.log('='.repeat(50));
    console.log(`   Conversations processed: ${this.capturedCount}`);
    
    // Check saved files
    const capturesDir = path.join(process.cwd(), 'captures', this.projectId);
    if (fs.existsSync(capturesDir)) {
      const files = fs.readdirSync(capturesDir);
      console.log(`   Files saved: ${files.length}`);
      console.log(`   Location: ${capturesDir}`);
      
      if (files.length === 0) {
        console.log('\n⚠️  No files were saved!');
        console.log('   Make sure the extension is active and working');
      }
    } else {
      console.log('\n⚠️  No captures directory created');
      console.log('   The extension may not be capturing data properly');
    }
  }

  async close(): Promise<void> {
    try {
      tokenEncoder.free();
    } catch (error) {
      console.warn('Error freeing token encoder:', error);
    }
    
    if (this.ws) {
      this.ws.close();
    }
    
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        console.warn('Error closing browser:', error);
      }
    }
  }
}

// Main execution
async function main() {
  console.clear();
  console.log('🚀 ContextBridge Capture Tool\n');
  
  const { projectUrl, projectId } = await getProjectInfo();
  const driver = new PlaywrightDriver(projectId);
  
  try {
    // Connect to backend
    await driver.connectToHub();
    
    // Connect to existing Chrome
    await driver.connectToChrome();
    
    // Make sure extension is active
    await driver.activateExtension();
    
    // Navigate to project if needed
    const page = (driver as any).page;
    if (page) {
      const currentUrl = page.url();
      if (!currentUrl.includes(projectUrl)) {
        console.log('📍 Navigating to project...');
        await page.goto(projectUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
      }
    }
    
    // Extract conversations
    const conversations = await driver.extractConversations();
    console.log(`✅ Found ${conversations.length} conversations\n`);
    
    if (conversations.length === 0) {
      console.log('❌ No conversations found!');
      console.log('   Make sure you\'re on the project page');
      return;
    }
    
    // Confirm before capture
    if (conversations.length > 20) {
      console.log('⚠️  Large number of conversations detected');
      console.log('   Press any key to continue or Ctrl+C to cancel...');
      await waitForKey();
    }
    
    // Capture all conversations
    await driver.captureConversations(conversations);
    
    // Show summary
    await driver.showSummary();
    
  } catch (error) {
    console.error('\n❌ Error:', error);
  } finally {
    await driver.close();
  }
}

main().catch(console.error);