// packages/backend/src/debug-links.js
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

async function debugEntityMentions() {
  console.log('Debugging entity mentions...\n');
  
  // Check if we have entity mentions at all
  const { count: mentionCount } = await supabase
    .from('entity_mentions')
    .select('*', { count: 'exact', head: true });
  
  console.log(`Total entity mentions: ${mentionCount}`);
  
  // Check a sample conversation
  const { data: sampleConv } = await supabase
    .from('conversations')
    .select('id, summary')
    .limit(1)
    .single();
  
  if (sampleConv) {
    console.log(`\nChecking conversation: ${sampleConv.id}`);
    
    // Get messages for this conversation
    const { data: messages } = await supabase
      .from('cb_messages')
      .select('id')
      .eq('conversation_id', sampleConv.id);
    
    console.log(`  Messages: ${messages?.length || 0}`);
    
    if (messages && messages.length > 0) {
      const messageIds = messages.map(m => m.id);
      
      // Check for entity mentions in these messages
      const { data: mentions, count } = await supabase
        .from('entity_mentions')
        .select('*', { count: 'exact' })
        .in('message_id', messageIds);
      
      console.log(`  Entity mentions in these messages: ${count || 0}`);
      
      if (mentions && mentions.length > 0) {
        console.log('  Sample mention:', mentions[0]);
      }
    }
  }
  
  // Check if entities have the correct project_id
  const { data: projects } = await supabase
    .from('projects')
    .select('id, name');
  
  console.log('\nEntities per project:');
  for (const project of projects || []) {
    const { count } = await supabase
      .from('entities')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id);
    
    console.log(`  ${project.name}: ${count} entities`);
  }
}

debugEntityMentions().catch(console.error);