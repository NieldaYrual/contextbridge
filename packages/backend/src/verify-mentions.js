// packages/backend/src/verify-mentions.js
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

async function verifyMentions() {
  // Check total messages vs messages with mentions
  const { count: totalMessages } = await supabase
    .from('cb_messages')
    .select('*', { count: 'exact', head: true });
  
  // Get unique message IDs that have mentions
  const { data: mentionedMessages } = await supabase
    .from('entity_mentions')
    .select('message_id');
  
  const uniqueMessageIds = new Set(mentionedMessages?.map(m => m.message_id));
  
  console.log(`Total messages: ${totalMessages}`);
  console.log(`Messages with mentions: ${uniqueMessageIds.size}`);
  console.log(`Coverage: ${Math.round(uniqueMessageIds.size / totalMessages * 100)}%`);
  
  // Check entities per project
  const { data: projects } = await supabase
    .from('projects')
    .select('id, name');
  
  console.log('\nEntities per project:');
  for (const project of projects || []) {
    const { count: entities } = await supabase
      .from('entities')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id);
    
    const { count: mentions } = await supabase
      .from('entity_mentions')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id);
    
    console.log(`  ${project.name}: ${entities} entities, ${mentions} mentions`);
  }
}

verifyMentions().catch(console.error);