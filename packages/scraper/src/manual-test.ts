import { ClaudeScraper } from './providers/claudeScraper';
import * as dotenv from 'dotenv';
import * as readline from 'readline';

dotenv.config({ path: '../../.env' });

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function waitForEnter(message: string): Promise<void> {
  return new Promise((resolve) => {
    rl.question(message, () => {
      resolve();
    });
  });
}

async function manualTest() {
  const scraper = new ClaudeScraper();
  
  try {
    console.log('Starting browser (visible mode for testing)...');
    await scraper.initialize(false); // false = visible browser
    
    await waitForEnter('Navigate to claude.ai and login manually\nPress Enter when logged in...\n');
    
    console.log('Getting conversation list...');
    const conversations = await scraper.getConversationList();
    console.log(`Found ${conversations.length} conversations:`);
    
    conversations.forEach((conv, index) => {
      console.log(`${index + 1}. ${conv.title || 'Untitled'} - ${conv.id}`);
    });
    
    if (conversations.length > 0) {
      console.log('\nCapturing first conversation...');
      const data = await scraper.captureConversation(conversations[0].url);
      console.log(`Captured ${data?.messages.length || 0} messages`);
      
      if (data?.messages && data.messages[0]) {
        console.log('First message preview:', data.messages[0].content.substring(0, 100) + '...');
      }
    }
    
  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await waitForEnter('\nPress Enter to close browser...\n');
    await scraper.cleanup();
    rl.close();
  }
}

manualTest();