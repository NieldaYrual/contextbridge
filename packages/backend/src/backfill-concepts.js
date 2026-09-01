// packages/backend/src/backfill-concepts.js
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from root
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const supabase = createClient(
  process.env.SB_URL || process.env.SUPABASE_URL,
  process.env.SB_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY
);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Config (mirrors search-config.ts conceptExtraction)
const CONFIG = {
  model: 'claude-sonnet-4-5-20250929',
  maxConcepts: 15,
  minConcepts: 3,
  messagesHead: 2,
  messagesTail: 2,
  maxCharsPerMessage: 1500,
  delayBetweenCalls: 1000,  // 1 second between API calls
};

/**
 * Extract concepts for a single conversation
 */
async function extractConceptsForConversation(conversation) {
  const { id: conversationId, project_id, title, summary } = conversation;
  const convTitle = title || summary || 'Untitled';

  // Fetch messages
  const { data: messages, error: msgErr } = await supabase
    .from('cb_messages')
    .select('id, content, role')
    .eq('conversation_id', conversationId)
    .order('index_in_thread', { ascending: true });

  if (msgErr || !messages || messages.length === 0) {
    return { success: false, reason: 'no messages', concepts: 0 };
  }

  // Select head + tail
  const head = messages.slice(0, CONFIG.messagesHead);
  const tail = messages.length > CONFIG.messagesHead
    ? messages.slice(-CONFIG.messagesTail)
    : [];
  const selected = [...head, ...tail];

  const messageText = selected
    .map(m => {
      const truncated = (m.content || '').slice(0, CONFIG.maxCharsPerMessage);
      return `[${m.role}]: ${truncated}`;
    })
    .join('\n\n');

  if (messageText.trim().length === 0) {
    return { success: false, reason: 'empty content', concepts: 0 };
  }

  // Call Claude API
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CONFIG.model,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Extract the key domain concepts from this conversation. Return ONLY a JSON array of strings, no explanation.

Rules:
- Extract ${CONFIG.minConcepts}-${CONFIG.maxConcepts} concepts
- Focus on domain-specific terms, methodologies, patterns, and topics (NOT generic words)
- Include technical concepts, business terms, named frameworks, algorithms, or domain jargon
- Each concept should be 1-4 words
- Do NOT include file names, generic programming terms like "function" or "variable", or stop words

Conversation title: "${convTitle}"

${messageText}

Respond with ONLY a JSON array like: ["concept one", "concept two", "concept three"]`
      }]
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    return { success: false, reason: `API ${response.status}: ${errBody.slice(0, 100)}`, concepts: 0 };
  }

  const data = await response.json();
  const responseText = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  let concepts = [];
  try {
    const cleaned = responseText.replace(/```json\s*|```/g, '').trim();
    concepts = JSON.parse(cleaned);
    if (!Array.isArray(concepts)) concepts = [];
  } catch {
    return { success: false, reason: 'parse error', concepts: 0 };
  }

  // Deduplicate and limit
  concepts = [...new Set(concepts.map(c => c.trim()).filter(c => c.length > 0))]
    .slice(0, CONFIG.maxConcepts);

  // Insert via RPC
  let inserted = 0;
  for (const concept of concepts) {
    try {
      const { error } = await supabase.rpc('cb_upsert_entity_mention', {
        p_project_id: project_id,
        p_name: concept,
        p_type: 'concept',
        p_message_id: messages[0]?.id || null,
        p_cb_file_id: null,
        p_block_id: null,
        p_snippet: null,
      });
      if (!error) inserted++;
    } catch {
      // skip
    }
  }

  return { success: true, concepts: inserted, total: concepts.length };
}

/**
 * Check which conversations already have concepts
 */
async function checkStatus(projectId) {
  // Total conversations
  const { count: totalConvs } = await supabase
    .from('cb_conversations')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .gt('message_count', 0);

  // Conversations that have concept entities
  const { data: conceptEntities } = await supabase
    .from('cb_entities')
    .select('id')
    .eq('project_id', projectId)
    .eq('type', 'concept');

  const { data: mentions } = await supabase
    .from('cb_entity_mentions')
    .select('entity_id, message_id')
    .in('entity_id', (conceptEntities || []).map(e => e.id))
    .not('message_id', 'is', null);

  // Get unique conversation IDs that have concepts
  const msgIds = [...new Set((mentions || []).map(m => m.message_id))];
  let convsWithConcepts = 0;
  if (msgIds.length > 0) {
    const { data: msgs } = await supabase
      .from('cb_messages')
      .select('conversation_id')
      .in('id', msgIds);
    convsWithConcepts = new Set((msgs || []).map(m => m.conversation_id)).size;
  }

  console.log('\n=== Concept Backfill Status ===');
  console.log(`Project: ${projectId}`);
  console.log(`Total conversations with messages: ${totalConvs}`);
  console.log(`Conversations with concepts: ${convsWithConcepts}`);
  console.log(`Conversations needing concepts: ${totalConvs - convsWithConcepts}`);
  console.log(`Total concept entities: ${conceptEntities?.length || 0}`);
}

/**
 * Main backfill function
 */
async function backfillConcepts(projectId) {
  if (!ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set!');
    process.exit(1);
  }

  console.log(`\nStarting concept backfill for project: ${projectId}`);
  console.log(`Model: ${CONFIG.model}`);
  console.log(`Delay between calls: ${CONFIG.delayBetweenCalls}ms\n`);

  // Get all conversations with messages
  const { data: conversations, error } = await supabase
    .from('cb_conversations')
    .select('id, project_id, title, summary, message_count')
    .eq('project_id', projectId)
    .gt('message_count', 0)
    .order('updated_at', { ascending: false });

  if (error || !conversations) {
    console.error('Failed to fetch conversations:', error);
    return;
  }

  console.log(`Found ${conversations.length} conversations with messages\n`);

  // Check which already have concepts (by checking entity_mentions linked to messages in each conv)
  const { data: existingConcepts } = await supabase
    .from('cb_entities')
    .select('id')
    .eq('project_id', projectId)
    .eq('type', 'concept');

  const existingConceptIds = (existingConcepts || []).map(e => e.id);
  
  let convsWithConcepts = new Set();
  if (existingConceptIds.length > 0) {
    const { data: mentions } = await supabase
      .from('cb_entity_mentions')
      .select('message_id')
      .in('entity_id', existingConceptIds)
      .not('message_id', 'is', null);

    if (mentions && mentions.length > 0) {
      const msgIds = [...new Set(mentions.map(m => m.message_id))];
      const { data: msgs } = await supabase
        .from('cb_messages')
        .select('conversation_id')
        .in('id', msgIds);
      convsWithConcepts = new Set((msgs || []).map(m => m.conversation_id));
    }
  }

  const toProcess = conversations.filter(c => !convsWithConcepts.has(c.id));
  console.log(`Skipping ${conversations.length - toProcess.length} conversations (already have concepts)`);
  console.log(`Processing ${toProcess.length} conversations\n`);

  let stats = { processed: 0, succeeded: 0, failed: 0, totalConcepts: 0 };

  for (let i = 0; i < toProcess.length; i++) {
    const conv = toProcess[i];
    const convTitle = conv.title || conv.summary || 'Untitled';
    
    process.stdout.write(`[${i + 1}/${toProcess.length}] "${convTitle.slice(0, 50)}"... `);

    try {
      const result = await extractConceptsForConversation(conv);
      stats.processed++;

      if (result.success) {
        stats.succeeded++;
        stats.totalConcepts += result.concepts;
        console.log(`✅ ${result.concepts}/${result.total} concepts`);
      } else {
        stats.failed++;
        console.log(`⚠️  ${result.reason}`);
      }
    } catch (err) {
      stats.processed++;
      stats.failed++;
      console.log(`❌ ${err.message}`);
    }

    // Delay between API calls
    if (i < toProcess.length - 1) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.delayBetweenCalls));
    }
  }

  console.log('\n=== Backfill Complete ===');
  console.log(`Processed: ${stats.processed}`);
  console.log(`Succeeded: ${stats.succeeded}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Total concepts inserted: ${stats.totalConcepts}`);
}

// Main execution
const command = process.argv[2];
const projectId = process.argv[3];

if (command === 'check' && projectId) {
  checkStatus(projectId);
} else if (command === 'run' && projectId) {
  backfillConcepts(projectId);
} else {
  console.log('Usage:');
  console.log('  node backfill-concepts.js check <projectId>  - Check status');
  console.log('  node backfill-concepts.js run <projectId>    - Run backfill');
  console.log('\nExample:');
  console.log('  node backfill-concepts.js check 0198a07b-7fa1-75e2-8834-ca8a703c3469');
  console.log('  node backfill-concepts.js run 0198a07b-7fa1-75e2-8834-ca8a703c3469');
}