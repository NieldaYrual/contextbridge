// packages/backend/src/generate-summaries.js
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';

const limit = pLimit(Number(process.env.SUMMARY_CONCURRENCY || 8));

// get conversations first (unchanged)
const { data: conversations, count } = await supabase
  .from('conversations')
  .select('id, project_id', { count: 'exact' });

// p-limited parallel generation
let done = 0;
await Promise.all(
  (conversations || []).map(c =>
    limit(async () => {
      await generateConversationSummary(c.id, c.project_id);
      // optional: lightweight progress
      done++;
      if (done % 25 === 0) console.log(`Summaries: ${done}/${count}`);
    })
  )
);


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const supabase = createClient(
  process.env.SB_URL || process.env.SUPABASE_URL,
  process.env.SB_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY
);

/**
 * Generate a basic summary from messages (without LLM for now)
 */
function generateBasicSummary(messages) {
  if (!messages || messages.length === 0) return null;
  
  // Extract key information
  const messageCount = messages.length;
  const userMessages = messages.filter(m => m.role === 'user');
  const assistantMessages = messages.filter(m => m.role === 'assistant');
  
  // Find mentioned entities (basic extraction)
  const entities = new Set();
  const codeFiles = new Set();
  
  messages.forEach(msg => {
    const content = msg.content || '';
    
    // Extract file mentions
    const fileMatches = content.match(/\b([a-zA-Z0-9_.-]+\.(tsx?|jsx?|py|json|md))\b/g);
    if (fileMatches) {
      fileMatches.forEach(f => codeFiles.add(f));
    }
    
    // Extract technology mentions
    const techMatches = content.match(/\b(React|Python|TypeScript|Node\.js|Supabase|PostgreSQL|Docker)\b/gi);
    if (techMatches) {
      techMatches.forEach(t => entities.add(t));
    }
  });
  
  // Create summary
  const summary = {
    message_count: messageCount,
    user_messages: userMessages.length,
    assistant_messages: assistantMessages.length,
    mentioned_files: Array.from(codeFiles).slice(0, 10),
    mentioned_technologies: Array.from(entities).slice(0, 10),
    first_message_preview: userMessages[0]?.content?.substring(0, 200) || '',
    last_message_preview: messages[messages.length - 1]?.content?.substring(0, 200) || ''
  };
  
  return summary;
}

/**
 * Generate conversation summary
 */
async function generateConversationSummary(conversationId, projectId) {
  // Get messages
  const { data: messages } = await supabase
    .from('cb_messages')
    .select('content, role, ts')
    .eq('conversation_id', conversationId)
    .order('ts');
  
  if (!messages || messages.length === 0) return null;
  
  const summary = generateBasicSummary(messages);
  
  // Create summary text
  const summaryText = `
Conversation with ${summary.message_count} messages (${summary.user_messages} user, ${summary.assistant_messages} assistant).
Technologies discussed: ${summary.mentioned_technologies.join(', ') || 'none identified'}.
Files mentioned: ${summary.mentioned_files.join(', ') || 'none identified'}.
Topic: ${summary.first_message_preview}...
  `.trim();
  
  // Store summary - FIX: use projectId not project_id
  const { data, error } = await supabase
    .from('summaries')
    .insert({
      project_id: projectId,  // Fixed: was using undefined project_id
      level: 'conversation',
      target_id: conversationId,
      model: 'rule-based',
      content: summaryText,
      citations: JSON.stringify({
        message_count: summary.message_count,
        files: summary.mentioned_files,
        technologies: summary.mentioned_technologies
      })
    })
    .select()
    .single();
  
  return data;
}

/**
 * Generate project-level summary
 */
async function generateProjectSummary(projectId) {
  // Get all conversation summaries for this project
  const { data: conversationSummaries } = await supabase
    .from('summaries')
    .select('content, citations')
    .eq('project_id', projectId)
    .eq('level', 'conversation');
  
  if (!conversationSummaries || conversationSummaries.length === 0) return null;
  
  // Aggregate information
  const allTechs = new Set();
  const allFiles = new Set();
  let totalMessages = 0;
  
  conversationSummaries.forEach(s => {
    if (s.citations) {
      const citations = typeof s.citations === 'string' ? JSON.parse(s.citations) : s.citations;
      if (citations.technologies) {
        citations.technologies.forEach(t => allTechs.add(t));
      }
      if (citations.files) {
        citations.files.forEach(f => allFiles.add(f));
      }
      if (citations.message_count) {
        totalMessages += citations.message_count;
      }
    }
  });
  
  // Create project summary
  const projectSummaryText = `
Project contains ${conversationSummaries.length} conversations with ${totalMessages} total messages.
Primary technologies: ${Array.from(allTechs).slice(0, 15).join(', ')}.
Key files: ${Array.from(allFiles).slice(0, 15).join(', ')}.
  `.trim();
  
  // Store project summary
  await supabase
    .from('summaries')
    .insert({
      project_id: projectId,
      level: 'project',
      target_id: projectId,
      model: 'rule-based',
      content: projectSummaryText,
      citations: JSON.stringify({
        conversation_count: conversationSummaries.length,
        total_messages: totalMessages,
        technologies: Array.from(allTechs),
        files: Array.from(allFiles)
      })
    });
  
  return projectSummaryText;
}

/**
 * Main summarization pipeline
 */
async function main() {
  console.log('Starting summary generation...\n');
  
  // Get all conversations
  const { data: conversations, count } = await supabase
    .from('conversations')
    .select('id, project_id', { count: 'exact' });
  
  console.log(`Found ${count} conversations to summarize\n`);
  
  let processed = 0;
  
  // Generate conversation summaries
  for (const conv of conversations) {
    await generateConversationSummary(conv.id, conv.project_id);
    processed++;
    
    if (processed % 10 === 0) {
      const pct = Math.round((processed / count) * 100);
      console.log(`Progress: ${processed}/${count} (${pct}%)`);
    }
  }
  
  console.log('\nGenerating project summaries...');
  
  // Get unique project IDs
  const projectIds = [...new Set(conversations.map(c => c.project_id))];
  
  for (const projectId of projectIds) {
    const summary = await generateProjectSummary(projectId);
    console.log(`Project ${projectId}: Generated summary`);
  }
  
  console.log('\n=== Summary Generation Complete ===');
  console.log(`Generated ${count} conversation summaries`);
  console.log(`Generated ${projectIds.length} project summaries`);
}

main().catch(console.error);