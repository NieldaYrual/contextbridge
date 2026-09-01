import { ClaudeScraper } from './providers/claudeScraper';
import * as dotenv from 'dotenv';
import * as readline from 'readline';

dotenv.config({ path: '../../.env' });

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function testScraper() {
  const scraper = new ClaudeScraper();
  
  try {
    console.log('Initializing browser...');
    await scraper.initialize(false);
    
    console.log('\n=== BROWSER OPENED ===');
    console.log('1. Navigate to claude.ai');
    console.log('2. Login to your account');
    console.log('3. Go to your conversations page');
    console.log('4. When ready, come back here and type "ready"\n');
    
    // Wait for user to explicitly say they're ready
    let userInput = '';
    while (userInput.toLowerCase() !== 'ready') {
      userInput = await ask('Type "ready" when you are logged in and on the conversations page: ');
    }
    
    console.log('\nAttempting to get conversation list...');
    const conversations = await scraper.getConversationList();
    console.log(`Found ${conversations.length} conversations\n`);
    
    if (conversations.length === 0) {
      console.log('No conversations found. Make sure you are on the right page.');
      console.log('The URL should be something like: https://claude.ai/chats');
    } else {
      conversations.forEach((conv, index) => {
        console.log(`${index + 1}. ${conv.title || conv.id}`);
      });
      
      const captureFirst = await ask('\nCapture first conversation? (yes/no): ');
      if (captureFirst.toLowerCase() === 'yes') {
        console.log('Capturing first conversation...');
        const firstConv = await scraper.captureConversation(conversations[0].url);
        console.log(`Captured ${firstConv?.messages.length || 0} messages`);
      }
    }
    
    await ask('\nPress Enter to close browser...');
    
  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await scraper.cleanup();
    rl.close();
    console.log('Test completed');
  }
}

testScraper();