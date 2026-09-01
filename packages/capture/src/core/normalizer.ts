// src/core/normalizer.ts
import { createHash } from 'crypto';
import type { NormalizedMessage, NormalizedThread } from './types.js';

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function normalizeClaude(hits: { url: string; json: any }[]): NormalizedThread[] {
  const byConv: Record<string, NormalizedThread> = {};
  
  // First, check if we have project-specific conversations
  const projectConvHit = hits.find(h => 
    h.url.includes('/projects/') && h.url.includes('/conversations_v2')
  );
  
  // If we have project-specific conversations, use ONLY those
  if (projectConvHit) {
    const projectConvs = projectConvHit.json?.data || [];
    console.log(`   Using ${projectConvs.length} PROJECT-SPECIFIC conversations only`);
    
    for (const c of projectConvs) {
      const id = c.uuid || c.id || c.conversation_id;
      if (!id) continue;
      
      byConv[id] = {
        provider: 'claude',
        providerConversationId: id,
        title: c.name || c.title || 'Untitled',
        startedAt: c.created_at || c.createdAt,
        lastActivityAt: c.updated_at || c.updatedAt,
        messages: []
      };
      
      if (c.summary) (byConv[id] as any).summary = c.summary;
      if (c.model) (byConv[id] as any).model = c.model;
    }
  } else {
    // Fallback to processing all hits if no project-specific endpoint found
    for (const { url, json } of hits) {
      // Skip the general chat_conversations endpoint if we're looking for project-specific
      if (url.includes('/chat_conversations') && !url.includes('/projects/')) {
        console.log(`   Skipping general conversations endpoint (not project-specific)`);
        continue;
      }
      
      // Handle different conversation response formats
      let convs: any[] = [];
      
      // Format 1: Direct array (from /chat_conversations endpoint)
      if (Array.isArray(json) && json.length > 0 && json[0]?.uuid) {
        convs = json;
        console.log(`   Found ${convs.length} conversations (direct array)`);
      }
      // Format 2: Object with data field (from /conversations_v2 endpoint)
      else if (json?.data && Array.isArray(json.data)) {
        convs = json.data;
        console.log(`   Found ${convs.length} conversations (data field)`);
      }
      // Format 3: Legacy formats
      else if (json?.conversations || json?.items) {
        convs = json.conversations || json.items;
        console.log(`   Found ${convs.length} conversations (legacy format)`);
      }
      
      // Process conversations
      for (const c of convs) {
        const id = c.uuid || c.id || c.conversation_id;
        if (!id) continue;
        
        byConv[id] ??= {
          provider: 'claude',
          providerConversationId: id,
          title: c.name || c.title || 'Untitled',
          startedAt: c.created_at || c.createdAt,
          lastActivityAt: c.updated_at || c.updatedAt,
          messages: []
        };
        
        // If there's a summary, add it as metadata
        if (c.summary) {
          (byConv[id] as any).summary = c.summary;
        }
        if (c.model) {
          (byConv[id] as any).model = c.model;
        }
      }
    }
  }
    
  // Handle messages (if any endpoint returns them)
  for (const { url, json } of hits) {
    // Check for chat_messages in conversation responses
    if (json?.chat_messages) {
      const convId = json.uuid || extractConversationId(url);
      if (!convId) continue;
      
      const t = (byConv[convId] ??= { 
        provider: 'claude', 
        providerConversationId: convId, 
        messages: [] 
      });
      
      console.log(`   Processing ${json.chat_messages.length} messages for conversation ${convId}`);
      
      for (const m of json.chat_messages) {
        // Map sender to role (human -> user, assistant -> assistant)
        const role = m.sender === 'human' ? 'user' : 'assistant';
        
        // Extract text from the complex content structure
        let text = '';
        if (m.text) {
          text = m.text;
        } else if (Array.isArray(m.content)) {
          // Extract text from content array
          text = m.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text || '')
            .join('\n');
        }
        
        const nm: NormalizedMessage = {
          providerMessageId: m.uuid,
          role,
          content: text,
          blocks: extractBlocks(m),
          timestamp: m.created_at
        };
        t.messages.push(nm);
      }
    }
    
    // Also check for regular messages field (keep existing logic)
    const msgs = json?.messages || [];
    if (Array.isArray(msgs) && msgs.length > 0) {
      // Try to find conversation ID from the URL or context
      const convId = extractConversationId(url) || json.conversation_id || json.thread_id || json.chat_id;
      if (!convId) continue;
      
      const t = (byConv[convId] ??= { 
        provider: 'claude', 
        providerConversationId: convId, 
        messages: [] 
      });
      
      for (const m of msgs) {
        const role = mapRole(m.role || m.author || 'assistant');
        const text = extractText(m);
        const blocks = extractBlocks(m);
        const nm: NormalizedMessage = {
          providerMessageId: m.id || m.uuid,
          role,
          content: text,
          blocks,
          timestamp: m.created_at || m.ts
        };
        t.messages.push(nm);
      }
    }
  }
  
  return Object.values(byConv).map(t => {
    t.messages = dedupeAndOrder(t.messages);
    return t;
  });
}

function extractConversationId(url: string): string | null {
  // Try to extract conversation ID from URL patterns like:
  // /conversations/[uuid]/messages
  // /chat/[uuid]
  const match = url.match(/\/conversations?\/([a-f0-9-]+)/i) || 
                url.match(/\/chat\/([a-f0-9-]+)/i);
  return match?.[1] ?? null;  // Your fix here is correct!
}

function mapRole(r: string): 'user' | 'assistant' | 'system' {
  const x = (r || '').toLowerCase();
  if (x.includes('user') || x === 'human') return 'user';
  if (x.includes('system')) return 'system';
  return 'assistant';
}

function extractText(m: any): string {
  if (typeof m.text === 'string') return m.text;
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.parts)) return m.parts.map((p: any) => p.text || '').join('\n');
  if (m?.content?.text) return m.content.text;
  return '';
}

function extractBlocks(m: any) {
  const out: any[] = [];
  const bs = (m.code_blocks || m.blocks || []).filter((b: any) => b.code || b.content);
  for (const b of bs) {
    out.push({
      kind: 'code',
      language: (b.language || b.lang || '') || undefined,
      content: b.code || b.content
    });
  }
  return out;
}

function dedupeAndOrder(arr: NormalizedMessage[]) {
  const seen = new Set<string>();
  const out: NormalizedMessage[] = [];
  arr.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  let i = 0;
  for (const m of arr) {
    const key = `${m.role}:${sha(m.content || '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (m as any).index_in_thread = i++;
    out.push(m);
  }
  return out;
}