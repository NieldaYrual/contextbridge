// packages/backend/src/fast-entity-mentions.js
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

const PATTERNS = [
  { regex: /\b(React|Vue|Angular|Next\.js|Node\.js|Python|JavaScript|TypeScript|PostgreSQL|Supabase|Docker|AWS|Claude|GPT-4)\b/gi, type: 'technology' },
  { regex: /\b([a-zA-Z0-9_.-]+\.(tsx?|jsx?|py|json|md|yaml|sql))\b/g, type: 'file' },
];

async function fastEntityMentions() {
  console.log('Fast entity mention creation...\n');
  
  // Get all existing entities to avoid duplicates
  const { data: existingEntities } = await supabase
    .from('entities')
    .select('id, project_id, canonical_name, entity_type');
  
  const entityMap = new Map();
  existingEntities?.forEach(e => {
    entityMap.set(`${e.project_id}_${e.canonical_name}_${e.entity_type}`, e.id);
  });
  
  console.log(`Found ${entityMap.size} existing entities\n`);
  
  // Process all conversations at once
  const { data: conversations } = await supabase
    .from('conversations')
    .select('id, project_id');
  
  // Get ALL messages in one query
  const { data: allMessages } = await supabase
    .from('cb_messages')
    .select('id, conversation_id, project_id, content');
  
  console.log(`Processing ${allMessages?.length || 0} messages...\n`);
  
  // Build message map
  const messagesByConv = new Map();
  allMessages?.forEach(m => {
    if (!messagesByConv.has(m.conversation_id)) {
      messagesByConv.set(m.conversation_id, []);
    }
    messagesByConv.get(m.conversation_id).push(m);
  });
  
  // Collect all entities and mentions
  const newEntities = [];
  const allMentions = [];
  
  for (const conv of conversations || []) {
    const messages = messagesByConv.get(conv.id) || [];
    
    for (const message of messages) {
      if (!message.content) continue;
      
      for (const { regex, type } of PATTERNS) {
        const matches = [...message.content.matchAll(regex)];
        
        for (const match of matches) {
          const text = match[1] || match[0];
          const canonical = text.toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
          const key = `${conv.project_id}_${canonical}_${type}`;
          
          // Check if entity exists or needs to be created
          if (!entityMap.has(key)) {
            entityMap.set(key, `temp_${key}`); // Temporary ID
            newEntities.push({
              project_id: conv.project_id,
              canonical_name: canonical,
              entity_type: type,
              source: 'extraction'
            });
          }
          
          // Add mention
          if (match.index !== undefined) {
            allMentions.push({
              entity_key: key,
              project_id: conv.project_id,
              message_id: message.id,
              start_idx: match.index,
              end_idx: match.index + text.length,
              surface_form: text,
              confidence: 0.8
            });
          }
        }
      }
    }
  }
  
  console.log(`Found ${newEntities.length} new entities`);
  console.log(`Found ${allMentions.length} total mentions\n`);
  
  // Batch insert new entities
  if (newEntities.length > 0) {
    console.log('Creating new entities...');
    const { data: createdEntities } = await supabase
      .from('entities')
      .insert(newEntities)
      .select('id, project_id, canonical_name, entity_type');
    
    // Update entity map with real IDs
    createdEntities?.forEach(e => {
      entityMap.set(`${e.project_id}_${e.canonical_name}_${e.entity_type}`, e.id);
    });
  }
  
  // Map mentions to entity IDs and batch insert
  console.log('Creating mentions in batches...');
  const mentionsWithIds = allMentions.map(m => ({
    entity_id: entityMap.get(m.entity_key),
    project_id: m.project_id,
    message_id: m.message_id,
    start_idx: m.start_idx,
    end_idx: m.end_idx,
    surface_form: m.surface_form,
    confidence: m.confidence
  })).filter(m => m.entity_id && !m.entity_id.startsWith('temp_'));
  
  // Insert in batches of 1000
  const batchSize = 1000;
  for (let i = 0; i < mentionsWithIds.length; i += batchSize) {
    const batch = mentionsWithIds.slice(i, i + batchSize);
    await supabase.from('entity_mentions').insert(batch);
    console.log(`  Inserted ${Math.min(i + batchSize, mentionsWithIds.length)}/${mentionsWithIds.length} mentions`);
  }
  
  console.log('\n✅ Complete!');
  console.log(`  Total entities: ${entityMap.size}`);
  console.log(`  Total mentions: ${mentionsWithIds.length}`);
}

fastEntityMentions().catch(console.error);