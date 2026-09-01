// packages/backend/src/debug-extraction.js
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const supabase = createClient(
  process.env.SB_URL || process.env.SUPABASE_URL,
  process.env.SB_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY
);

async function debugFirstConversation() {
  // Check the first conversation
  const convId = '3cb33b95-c501-40e9-b43e-a34066a04543';
  
  const { data: messages, error } = await supabase
    .from('cb_messages')
    .select('id, content, role')
    .eq('conversation_id', convId)
    .limit(3);
  
  console.log(`Messages in conversation ${convId}:`);
  console.log('Number of messages:', messages?.length || 0);
  
  if (messages && messages.length > 0) {
    console.log('\nFirst message:');
    console.log('Role:', messages[0].role);
    console.log('Content length:', messages[0].content?.length || 0);
    console.log('Content preview:', messages[0].content?.substring(0, 200));
    
    // Test some patterns
    const content = messages[0].content || '';
    const techMatches = content.match(/\b(React|Python|Node\.js|PostgreSQL|Supabase)\b/gi);
    const fileMatches = content.match(/\b([a-zA-Z0-9_.-]+\.(tsx?|jsx?|py|json))\b/g);
    
    console.log('\nPattern test results:');
    console.log('Tech matches:', techMatches);
    console.log('File matches:', fileMatches);
  }
}

debugFirstConversation();