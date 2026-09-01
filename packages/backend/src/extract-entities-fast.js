// packages/backend/src/extract-entities-fast.js
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

// Simplified patterns for faster processing
const QUICK_PATTERNS = [
  // Common tech (simplified)
  { regex: /\b(React|Vue|Angular|Next\.js|Node\.js|Python|JavaScript|TypeScript|PostgreSQL|Supabase|Docker|AWS|Claude|GPT-4)\b/gi, type: 'technology' },
  // Files
  { regex: /\b([a-zA-Z0-9_.-]+\.(tsx?|jsx?|py|json|md|yaml))\b/g, type: 'file' },
  // JIRA/GitHub issues
  { regex: /\b([A-Z]+-\d+|#\d+)\b/g, type: 'task_or_issue' },
  // Versions
  { regex: /\bv?\d+\.\d+\.\d+\b/g, type: 'version_or_release' },
];

async function processInBatches() {
  console.log('Starting fast extraction...\n');
  
  // Get total count
  const { count } = await supabase
    .from('conversations')
    .select('*', { count: 'exact', head: true });
  
  console.log(`Total conversations to process: ${count}\n`);
  
  const batchSize = 10; // Process more at once
  let processed = 0;
  let totalEntities = 0;
  
  for (let offset = 0; offset < count; offset += batchSize) {
    // Get batch of conversations with their messages in one query
    const { data: conversations } = await supabase
      .from('conversations')
      .select('id, project_id')
      .range(offset, offset + batchSize - 1);
    
    if (!conversations) break;
    
    // Process batch in parallel
    const batchPromises = conversations.map(async (conv) => {
      const { data: messages } = await supabase
        .from('cb_messages')
        .select('id, content')
        .eq('conversation_id', conv.id);
      
      if (!messages || messages.length === 0) return 0;
      
      let entityCount = 0;
      const entities = [];
      
      // Quick pattern matching
      for (const msg of messages) {
        if (!msg.content) continue;
        
        for (const { regex, type } of QUICK_PATTERNS) {
          const matches = [...msg.content.matchAll(regex)];
          for (const match of matches) {
            entities.push({
              project_id: conv.project_id,
              canonical_name: (match[1] || match[0]).toLowerCase().replace(/\s+/g, '_'),
              entity_type: type,
              source: 'extraction'
            });
            entityCount++;
          }
        }
      }
      
      // Bulk insert entities (deduplicated)
      if (entities.length > 0) {
        const unique = Array.from(new Map(
          entities.map(e => [`${e.canonical_name}_${e.entity_type}`, e])
        ).values());
        
        await supabase
          .from('entities')
          .upsert(unique, {
            onConflict: 'project_id,canonical_name,entity_type',
            ignoreDuplicates: true
          });
      }
      
      return entityCount;
    });
    
    const results = await Promise.all(batchPromises);
    const batchEntities = results.reduce((sum, n) => sum + n, 0);
    totalEntities += batchEntities;
    processed += conversations.length;
    
    // Progress update
    const pct = Math.round((processed / count) * 100);
    console.log(`Progress: ${processed}/${count} (${pct}%) - Found ${batchEntities} entities in batch`);
  }
  
  console.log(`\nComplete! Processed ${processed} conversations, found ${totalEntities} entity occurrences`);
}

processInBatches().catch(console.error);