// packages/backend/src/backfill-messages.js
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from root
dotenv.config({ path: path.join(__dirname, '../../../.env') });

// Initialize Supabase client
const supabase = createClient(
  process.env.SB_URL || process.env.SUPABASE_URL,
  process.env.SB_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY
);

/**
 * Calculate SHA-256 hash for message deduplication
 */
function calculateMessageHash(conversationId, role, content, index) {
  const data = `${conversationId}-${role}-${content}-${index}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Estimate token count (rough approximation)
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Extract message content from various formats
 */
function extractMessageContent(msg) {
  // Handle content array format (from your extension)
  if (msg.content && Array.isArray(msg.content)) {
    const textItems = msg.content.filter(item => item.type === 'text');
    return textItems.map(item => item.text || '').join('\n');
  }
  
  // Handle simple text field
  if (msg.text) {
    return msg.text;
  }
  
  // Handle string content
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  
  return '';
}

/**
 * Determine role from message
 */
function determineRole(msg) {
  if (msg.role) {
    // Map any role variations
    if (msg.role === 'human') return 'user';
    if (msg.role === 'assistant' || msg.role === 'claude') return 'assistant';
    return msg.role;
  }
  
  if (msg.sender) {
    if (msg.sender === 'human') return 'user';
    if (msg.sender === 'assistant' || msg.sender === 'claude') return 'assistant';
  }
  
  return 'user'; // default
}

/**
 * Check sample conversation structure
 */
async function checkSampleConversation() {
  const { data: sample, error } = await supabase
    .from('conversations')
    .select('id, project_id, raw_messages')
    .not('raw_messages', 'is', null)
    .limit(1)
    .single();

  if (error) {
    console.error('Failed to fetch sample:', error);
    return;
  }

  console.log('\n=== Sample Conversation ===');
  console.log('Conversation ID:', sample.id);
  console.log('Project ID:', sample.project_id);
  
  const messages = sample.raw_messages;
  console.log('Number of messages:', Array.isArray(messages) ? messages.length : 0);
  
  if (Array.isArray(messages) && messages.length > 0) {
    console.log('\nFirst message structure:');
    console.log(JSON.stringify(messages[0], null, 2));
    
    // Test extraction
    const content = extractMessageContent(messages[0]);
    const role = determineRole(messages[0]);
    console.log('\nExtracted:');
    console.log('  Role:', role);
    console.log('  Content preview:', content.substring(0, 100) + '...');
  }
}

/**
 * Backfill messages for a single conversation
 */
async function backfillConversationMessages(conversation) {
  const { id: conversationId, project_id, raw_messages } = conversation;
  
  if (!raw_messages) {
    return { success: 0, skipped: 1, errors: 0 };
  }

  const messages = Array.isArray(raw_messages) ? raw_messages : [];
  if (messages.length === 0) {
    return { success: 0, skipped: 1, errors: 0 };
  }

  const messagesToInsert = [];
  
  messages.forEach((msg, index) => {
    const role = determineRole(msg);
    const content = extractMessageContent(msg);
    
    if (!content) return; // Skip empty messages
    
    const sha256 = calculateMessageHash(conversationId, role, content, index);
    const tokenCount = estimateTokens(content);
    
    messagesToInsert.push({
      project_id,
      conversation_id: conversationId,
      role,
      content,
      ts: msg.created_at || msg.timestamp || msg.ts || new Date().toISOString(),
      token_count: tokenCount,
      sha256
    });
  });

  if (messagesToInsert.length === 0) {
    return { success: 0, skipped: 1, errors: 0 };
  }

  // Insert messages
  try {
    const { data, error } = await supabase
      .from('cb_messages')
      .insert(messagesToInsert)
      .select();

    if (error) {
      // Check if it's a duplicate error
      if (error.code === '23505') {
        console.log(`   ⚠️ Some messages already exist for ${conversationId}`);
        return { success: 0, skipped: messagesToInsert.length, errors: 0 };
      }
      console.error(`Error inserting messages for ${conversationId}:`, error.message);
      return { success: 0, skipped: 0, errors: messagesToInsert.length };
    }

    console.log(`✓ Inserted ${messagesToInsert.length} messages for conversation ${conversationId}`);
    return { success: messagesToInsert.length, skipped: 0, errors: 0 };
    
  } catch (error) {
    console.error(`Unexpected error for conversation ${conversationId}:`, error);
    return { success: 0, skipped: 0, errors: messagesToInsert.length };
  }
}

/**
 * Main backfill function
 */
async function backfillAllMessages() {
  console.log('Starting message backfill process...\n');
  
  let totalStats = {
    conversations: 0,
    messagesCreated: 0,
    messagesSkipped: 0,
    errors: 0
  };

  let hasMore = true;
  let offset = 0;
  const batchSize = 10;

  while (hasMore) {
    const { data: conversations, error } = await supabase
      .from('conversations')
      .select('id, project_id, raw_messages')
      .not('raw_messages', 'is', null)
      .range(offset, offset + batchSize - 1);

    if (error) {
      console.error('Failed to fetch conversations:', error);
      break;
    }

    if (!conversations || conversations.length === 0) {
      hasMore = false;
      break;
    }

    for (const conversation of conversations) {
      const stats = await backfillConversationMessages(conversation);
      totalStats.conversations++;
      totalStats.messagesCreated += stats.success;
      totalStats.messagesSkipped += stats.skipped;
      totalStats.errors += stats.errors;
      
      // Small delay between conversations
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    offset += batchSize;
    console.log(`Processed ${totalStats.conversations} conversations so far...`);
  }

  // Final report
  console.log('\n=== Backfill Complete ===');
  console.log(`Conversations processed: ${totalStats.conversations}`);
  console.log(`Messages created: ${totalStats.messagesCreated}`);
  console.log(`Messages skipped: ${totalStats.messagesSkipped}`);
  console.log(`Errors: ${totalStats.errors}`);
}

// Main execution
const command = process.argv[2];

if (command === 'check') {
  checkSampleConversation();
} else if (command === 'run') {
  backfillAllMessages();
} else {
  console.log('Usage:');
  console.log('  node backfill-messages.js check  - Check sample conversation structure');
  console.log('  node backfill-messages.js run    - Run the full backfill');
}