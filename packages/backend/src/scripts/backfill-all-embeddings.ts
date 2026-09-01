import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const PROJECT_ID = process.env.PROJECT_ID || '0198a07b-7fa1-75e2-8834-ca8a703c3469';

// Initialize Supabase for direct checks
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// Check how many items need embedding (before starting)
async function checkPendingEmbeddings() {
  console.log('🔍 Checking what needs embedding...\n');
  
  const [messages, files, blocks] = await Promise.all([
    supabase.rpc('cb_next_messages_to_embed', { p_project: PROJECT_ID, p_limit: 10000 }),
    supabase.rpc('cb_next_files_to_embed', { p_project: PROJECT_ID, p_limit: 10000 }),
    supabase.rpc('cb_next_blocks_to_embed', { p_project: PROJECT_ID, p_limit: 10000 })
  ]);
  
  return {
    messages: messages.data?.length || 0,
    files: files.data?.length || 0,
    blocks: blocks.data?.length || 0
  };
}

interface BackfillResponse {
  inserted: number;
  fetched: number;
  done: boolean;
  modelUsed: string;
}

async function backfillType(type: 'messages' | 'files' | 'blocks', batchSize: number, expectedCount: number) {
  if (expectedCount === 0) {
    console.log(`⏭️  Skipping ${type} - already fully embedded`);
    return 0;
  }
  
  console.log(`\n🔄 Starting ${type} backfill (${expectedCount} items needed)...`);
  
  let totalProcessed = 0;
  let batchNum = 0;
  
  while (true) {
    batchNum++;
    
    const response = await fetch(`${BACKEND_URL}/api/context/_backfill/embeddings/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT_ID, limit: batchSize })
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error(`❌ Error in ${type} batch ${batchNum}:`, error);
      break;
    }
    
    const result = await response.json() as BackfillResponse;
    totalProcessed += result.inserted;
    
    const progress = ((totalProcessed / expectedCount) * 100).toFixed(1);
    console.log(`  ✓ Batch ${batchNum}: ${result.inserted} ${type} (${totalProcessed}/${expectedCount} = ${progress}%) | Model: ${result.modelUsed}`);
    
    if (result.done || result.fetched === 0) {
      console.log(`✅ ${type} backfill complete! Total: ${totalProcessed}`);
      break;
    }
    
    // Small delay to avoid overwhelming the API
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  return totalProcessed;
}

async function main() {
  console.log('🚀 Starting Complete Embedding Backfill');
  console.log(`📦 Project: ${PROJECT_ID}`);
  console.log(`🔗 Backend: ${BACKEND_URL}\n`);
  
  // Pre-check: What needs embedding?
  const pending = await checkPendingEmbeddings();
  const totalPending = pending.messages + pending.files + pending.blocks;
  
  console.log('📊 Items needing embeddings:');
  console.log(`   - Messages: ${pending.messages}`);
  console.log(`   - Files: ${pending.files}`);
  console.log(`   - Blocks: ${pending.blocks}`);
  console.log(`   - Total: ${totalPending}\n`);
  
  if (totalPending === 0) {
    console.log('✨ Everything is already embedded! Nothing to do.');
    return;
  }
  
  // Estimate cost and time
  const estimatedMinutes = (totalPending / 100 * 0.5).toFixed(1); // ~100 items per batch, 0.5 min per batch
  console.log(`⏱️  Estimated time: ~${estimatedMinutes} minutes`);
  console.log(`💰 Estimated cost: ~$${(totalPending * 0.00002).toFixed(4)} (OpenAI embeddings)\n`);
  
  const startTime = Date.now();
  
  try {
    // Backfill each type (sequential to avoid rate limits)
    const filesCount = await backfillType('files', 100, pending.files);
    const messagesCount = await backfillType('messages', 200, pending.messages);
    const blocksCount = await backfillType('blocks', 100, pending.blocks);
    
    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    
    console.log('\n🎉 All backfills complete!');
    console.log(`📊 Summary:`);
    console.log(`   - Files: ${filesCount}/${pending.files}`);
    console.log(`   - Messages: ${messagesCount}/${pending.messages}`);
    console.log(`   - Blocks: ${blocksCount}/${pending.blocks}`);
    console.log(`   - Total: ${filesCount + messagesCount + blocksCount}/${totalPending}`);
    console.log(`   - Duration: ${duration} minutes`);
    
    // Verify nothing left
    const remaining = await checkPendingEmbeddings();
    const totalRemaining = remaining.messages + remaining.files + remaining.blocks;
    
    if (totalRemaining > 0) {
      console.log(`\n⚠️  Warning: ${totalRemaining} items still need embedding. Run again to complete.`);
    } else {
      console.log('\n✨ All embeddings up to date!');
    }
    
  } catch (error) {
    console.error('❌ Backfill failed:', error);
    process.exit(1);
  }
}

main();