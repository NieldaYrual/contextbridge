// packages/backend/src/routes/utils.routes.ts
// Utility functions moved server-side to protect IP

import { Router, Request, Response } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';

/**
 * Generate deterministic UUID from OpenAI gizmo_id
 * Moved from chrome extension to protect algorithm
 */
function gizmoIdToUUID(gizmoId: string): string {
  // Create a consistent hash from the gizmo_id string
  let hash = 0;
  for (let i = 0; i < gizmoId.length; i++) {
    const char = gizmoId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  
  // Convert to positive hex and pad to 32 characters
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  
  // Repeat to get 32 characters
  const fullHex = (hex + hex + hex + hex).substring(0, 32);
  
  // Format as UUID v4: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  return `${fullHex.substring(0, 8)}-${fullHex.substring(8, 12)}-4${fullHex.substring(13, 16)}-${fullHex.substring(16, 20)}-${fullHex.substring(20, 32)}`;
}

/**
 * Parse OpenAI's tree structure into flat message array
 * Moved from chrome extension to protect parsing logic
 */
interface OpenAINode {
  message?: {
    id: string;
    author?: { role: string };
    content?: {
      parts?: (string | { content_type?: string; text?: string; asset_pointer?: string })[];
    };
    create_time?: number;
    update_time?: number;
    metadata?: { attachments?: any[] };
  };
  children?: string[];
  parent?: string | null;
}

interface ParsedMessage {
  uuid: string;
  sender: string;
  text: string;
  created_at: string;
  updated_at: string;
  attachments: any[];
  index: number;
}

function parseOpenAIMessages(mapping: Record<string, OpenAINode>): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  
  function traverse(nodeId: string, depth: number = 0): void {
    const node = mapping[nodeId];
    if (!node) return;
    
    if (!node.message) {
      if (node.children) {
        for (const childId of node.children) {
          traverse(childId, depth + 1);
        }
      }
      return;
    }
    
    const msg = node.message;
    
    if (msg.author?.role === 'user' || msg.author?.role === 'assistant') {
      let textContent = '';
      if (msg.content?.parts) {
        for (const part of msg.content.parts) {
          if (typeof part === 'string') {
            textContent += part;
          } else if (part?.content_type === 'text') {
            textContent += part.text || '';
          } else if (part?.content_type === 'image_asset_pointer') {
            textContent += `[Image: ${part.asset_pointer}]\n`;
          }
        }
      }
      
      messages.push({
        uuid: msg.id,
        sender: msg.author.role,
        text: textContent,
        created_at: new Date((msg.create_time || 0) * 1000).toISOString(),
        updated_at: new Date((msg.update_time || msg.create_time || 0) * 1000).toISOString(),
        attachments: msg.metadata?.attachments || [],
        index: messages.length
      });
    }
    
    if (node.children && node.children.length > 0) {
      for (const childId of node.children) {
        traverse(childId, depth + 1);
      }
    }
  }
  
  // Find root node
  const rootNode = Object.keys(mapping).find(id => {
    const node = mapping[id];
    return !node.parent || node.parent === null;
  });
  
  if (rootNode) {
    traverse(rootNode);
  }
  
  return messages;
}

/**
 * Filter captured conversation data to remove existing content
 * Moved from chrome extension to protect deduplication logic
 */
interface ExistingContent {
  existing_message_ids: string[];
  existing_file_ids: string[];
  existing_block_ids?: string[];
}

interface ConversationMessage {
  uuid: string;
  attachments?: { id: string; file_name?: string }[];
  [key: string]: any;
}

interface ConversationData {
  id: string;
  messages?: ConversationMessage[];
  message_count?: number;
  [key: string]: any;
}

function filterExistingContent(
  conversationData: ConversationData | null,
  existingContent: ExistingContent | null
): ConversationData | null {
  if (!existingContent || !conversationData) {
    return conversationData;
  }
  
  const convId = conversationData.id;
  
  // Convert existing IDs to Sets for fast lookup
  const existingMessageIds = new Set(existingContent.existing_message_ids || []);
  const existingFileIds = new Set(existingContent.existing_file_ids || []);
  
  // Filter messages - keep only NEW messages (not in database)
  const newMessages = (conversationData.messages || []).filter(msg => {
    return !existingMessageIds.has(msg.uuid);
  });
  
  // For each new message, filter attachments
  newMessages.forEach(msg => {
    if (msg.attachments && Array.isArray(msg.attachments)) {
      msg.attachments = msg.attachments.filter(att => {
        return !existingFileIds.has(att.id);
      });
    }
  });
  
  // Create filtered conversation data
  return {
    ...conversationData,
    messages: newMessages,
    message_count: newMessages.length
  };
}

/**
 * Create utility routes
 */
export function createUtilsRoutes(supabase: SupabaseClient): Router {
  const router = Router();

  /**
   * POST /api/utils/gizmo-to-uuid
   * Convert OpenAI gizmo_id to deterministic UUID
   */
  router.post('/utils/gizmo-to-uuid', (req: Request, res: Response) => {
    try {
      const { gizmoId } = req.body;
      
      if (!gizmoId || typeof gizmoId !== 'string') {
        return res.status(400).json({ error: 'gizmoId is required and must be a string' });
      }
      
      const uuid = gizmoIdToUUID(gizmoId);
      
      res.json({ uuid, gizmoId });
    } catch (error: any) {
      console.error('[Utils] gizmo-to-uuid error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/utils/ensure-notebook-project
   * Get or create a CB project for a Gemini Notebook
   */
  router.post('/utils/ensure-notebook-project', async (req: Request, res: Response) => {
    try {
      const { notebookId, notebookTitle, userId } = req.body;

      if (!notebookId || typeof notebookId !== 'string') {
        return res.status(400).json({ error: 'notebookId is required' });
      }

      const projectId = gizmoIdToUUID(notebookId);
      const projectName = notebookTitle || `Gemini: ${notebookId.slice(0, 8)}`;

      const { error } = await supabase
        .from('cb_projects')
        .upsert({
          id: projectId,
          name: projectName,
          provider: 'gemini',
          provider_project_id: notebookId,
          user_id: userId,
          created_at: new Date().toISOString()
        }, { 
          onConflict: 'id',
          ignoreDuplicates: false  // ensure name gets updated
        });

      if (error) {
        console.error('[Utils] ensure-notebook-project upsert error:', error);
        // Return the ID anyway — project may already exist
      }

      res.json({ projectId, notebookId, projectName });
    } catch (error: any) {
      console.error('[Utils] ensure-notebook-project error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/utils/parse-openai-messages
   * Parse OpenAI's tree structure into flat message array
   */
  router.post('/utils/parse-openai-messages', (req: Request, res: Response) => {
    try {
      const { mapping } = req.body;
      
      if (!mapping || typeof mapping !== 'object') {
        return res.status(400).json({ error: 'mapping is required and must be an object' });
      }
      
      const messages = parseOpenAIMessages(mapping);
      
      res.json({ 
        messages,
        count: messages.length
      });
    } catch (error: any) {
      console.error('[Utils] parse-openai-messages error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/utils/filter-existing-content
   * Filter conversation data to remove already-captured content
   */
  router.post('/utils/filter-existing-content', (req: Request, res: Response) => {
    try {
      const { conversationData, existingContent } = req.body;
      
      if (!conversationData) {
        return res.status(400).json({ error: 'conversationData is required' });
      }
      
      const filtered = filterExistingContent(conversationData, existingContent);
      
      const originalCount = conversationData.messages?.length || 0;
      const newCount = filtered?.messages?.length || 0;
      
      res.json({
        filtered,
        stats: {
          originalMessages: originalCount,
          newMessages: newCount,
          skippedMessages: originalCount - newCount
        }
      });
    } catch (error: any) {
      console.error('[Utils] filter-existing-content error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}