// packages/backend/src/index.ts

import './env';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { createConversationRoutes } from './routes/conversation.routes';
import { createExtensionCaptureRoutes } from './routes/extension-capture.routes';
import { createQueryRoutes } from './routes/query.routes';
import { createContextInjectionRoutes } from './routes/context-injection.routes';
import { createScraperRoutes } from './routes/scraper.routes';
import { createCaptureProgressRoutes } from './routes/capture-progress.routes';
import { createServer } from 'http';
import { createWsHub } from './services/ws-hub.js';
import { createKnowledgeGraphRoutes } from './routes/knowledge-graph.routes';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import testEmbeddingRoutes from './routes/test-embedding.routes';
import {
  registerContextInjectionRoutes_Prepare,
  registerContextInjectionLogging,
  registerContextInjectionSearch      
} from './routes/context-injection.adapter.routes.js';
import intentParserTestRoutes from './routes/intent-parser-test.routes';
import agentIntegrationTestRoutes from './routes/agent-integration-test.routes';
import { createAgentLiveRoutes } from './routes/agent-live.routes';
import { embeddingsRouter } from './routes/embeddings.routes.js';
import { createBackfillRoutes } from './routes/tools.backfill.routes';
import { createCodexRoutes } from './routes/codex.routes';
import { createGithubRoutes } from './routes/github.routes';
import { createCodexIngestionRoutes } from './routes/codex-ingestion.routes';
import downloadRoutes from './routes/download.routes';
import { createUtilsRoutes } from './routes/utils.routes';
import { createSyncRoutes } from './routes/sync.routes';
import { createAuthRoutes } from './routes/auth.routes';
import { createAdminRoutes } from './routes/admin.routes';
import { requireAuth, optionalAuth } from './middleware/auth.middleware';
import { createAutoContextRoutes } from './routes/auto-context.routes';

import type { Request, Response } from 'express';

import dns from 'dns';
dns.setServers(['8.8.8.8', '8.8.4.4']);

// Create __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// Debug environment loading
console.log('SUPABASE_URL loaded?', !!process.env.SUPABASE_URL);
console.log('SERVICE ROLE KEY loaded?', !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY));

// Initialize Supabase client
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!process.env.SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or Service Role key');
  process.exit(1);
}

export const supabase = createClient(
  process.env.SUPABASE_URL,
  SERVICE_KEY,
  { global: { fetch }, auth: { persistSession: false } }
);

// Test Supabase connection
if (process.env.SUPABASE_URL && SERVICE_KEY) {
  fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`
    }
  })
  .then(res => console.log('Supabase connection test:', res.status))
  .catch(err => console.error('Supabase connection failed:', err.message));
}

const app = express();
const server = createServer(app);

// Set server timeout for large payloads (default is 2 minutes)
server.timeout = 300000; // 5 minutes (300 seconds)
server.keepAliveTimeout = 310000; // Slightly longer than timeout

createWsHub(server);

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, { auth: { persistSession: false } });

app.use('/api/kg', createKnowledgeGraphRoutes(sb)); // <- base path

// Middleware
app.use(cors());
// Security headers (replaces vercel.json headers)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});
// Mount GitHub webhook BEFORE express.json so the raw body can be HMAC-verified.
app.use('/api', createGithubRoutes(supabase));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve website static assets (CSS, SVG, images)
const websitePath = path.resolve(__dirname, '../../website');

// 301 redirect: /install/vscode → /install/editor (after VS Code Marketplace launch)
app.get(['/install/vscode', '/install/vscode/'], (_req, res) => {
  res.redirect(301, '/install/editor/');
});

app.use(express.static(websitePath));

// Optional auth - extracts user from token if present
app.use('/api', optionalAuth);

// Require auth for all /api routes EXCEPT /api/auth/* and internal endpoints
app.use('/api', (req, res, next) => {
  // Skip auth for auth routes (login, register, etc.)
  if (req.path.startsWith('/auth')) {
    return next();
  }
  // Skip auth for internal backfill endpoints (only called server-to-server)
  // These endpoints don't expose user data - they just process embeddings
  if (req.path.startsWith('/context/_backfill')) {
    return next();
  }
  // Require auth for everything else
  return requireAuth(req, res, next);
});

registerContextInjectionRoutes_Prepare(app);
registerContextInjectionLogging(app, supabase);
registerContextInjectionSearch(app);

// Mount route modules
app.use('/api', createConversationRoutes(supabase));
app.use('/api', createScraperRoutes(supabase));
app.use('/api', createQueryRoutes(supabase));
app.use(createExtensionCaptureRoutes(supabase));
app.use(createCaptureProgressRoutes(supabase));
app.use('/api/context', createContextInjectionRoutes(supabase));
app.use('/api', createCodexIngestionRoutes(supabase));
app.use(testEmbeddingRoutes);
app.use(intentParserTestRoutes);
app.use(agentIntegrationTestRoutes);
app.use('/api', createAgentLiveRoutes(supabase));
app.use(embeddingsRouter);
app.use('/api', createBackfillRoutes(supabase));
app.use('/api', createCodexRoutes(supabase));
app.use('/download', downloadRoutes);
app.use('/api', createUtilsRoutes(supabase));
app.use('/api', createSyncRoutes(supabase));
app.use('/api/auth', createAuthRoutes(supabase));
app.use('/api/admin', createAdminRoutes(supabase));
app.use('/api', createAutoContextRoutes(supabase));

// === TEMP: echo to verify body parsing ===
app.post('/api/_echo', (req, res) => {
  res.json({
    ok: true,
    contentType: req.headers['content-type'],
    hasBody: req.body != null,
    bodyType: typeof req.body,
    body: req.body
  });
});


// Lightweight endpoint specifically for extension to check capture status
app.get('/api/projects/:projectId/conversations/status', async (req: Request, res: Response) => {
  const { projectId } = req.params;
  
  try {
    // Get actual message counts using RPC function
    const { data, error } = await supabase.rpc('get_actual_message_counts', {
      p_project_id: projectId
    });
    
    if (error) {
      console.error('RPC error:', error);
      throw error;
    }
    
    console.log('[Status] RPC returned:', data?.length, 'conversations');
    
    // Add updated_at timestamp to each conversation
    // The RPC function should ideally return this, but if not, we fetch it
    if (data && data.length > 0) {
      const conversationIds = data.map((c: any) => c.id);
      
      // Get updated_at timestamps
      const { data: timestampData, error: timestampError } = await supabase
        .from('cb_conversations')
        .select('id, updated_at, captured_at')
        .in('id', conversationIds);
      
      if (!timestampError && timestampData) {
        // Create a map of id -> updated_at
        const timestampMap = new Map(
          timestampData.map(t => [t.id, t.updated_at])
        );
        const capturedMap = new Map(
          timestampData.map(t => [t.id, t.captured_at])
        );
        
        // Add updated_at to each conversation
        data.forEach((conv: any) => {
          conv.updated_at = timestampMap.get(conv.id) || null;
          conv.captured_at = capturedMap.get(conv.id) || null;
        });
      }
      
      console.log('[Status] Sample conversation with timestamp:', data[0]);
    }
    
    // Return the data with timestamps
    res.json({ conversations: data || [] });
  } catch (err: any) {
    console.error('Status endpoint error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get existing content IDs for a single conversation (for incremental capture)
app.get('/api/conversations/:conversationId/existing-content', async (req: Request, res: Response) => {
  const { conversationId } = req.params;
  
  try {
    console.log(`[Existing Content] Checking conversation ${conversationId}`);
    
    // Check if conversation exists
    const { data: conversation, error: convError } = await supabase
      .from('cb_conversations')
      .select('id')
      .eq('id', conversationId)
      .single();
    
    // If conversation doesn't exist, return empty arrays
    if (convError || !conversation) {
      console.log(`[Existing Content] Conversation ${conversationId} not found - returning empty`);
      return res.json({
        conversation_id: conversationId,
        exists: false,
        existing_message_ids: [],
        existing_file_ids: [],
        existing_block_ids: []
      });
    }
    
    // Get existing message IDs
    const { data: messages, error: msgError } = await supabase
      .from('cb_messages')
      .select('id')
      .eq('conversation_id', conversationId);
    
    // Get existing file IDs
    const { data: files, error: fileError } = await supabase
      .from('cb_files')
      .select('id')
      .eq('conversation_id', conversationId);
    
    // Get existing block IDs (blocks are linked to messages)
    // Batch query to avoid exceeding URL length limits
    let blocks: { id: any }[] = [];
    let blockError = null;
    if (messages && messages.length > 0) {
      const messageIds = messages.map(m => m.id);
      const BATCH_SIZE = 100;
      
      for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
        const batch = messageIds.slice(i, i + BATCH_SIZE);
        const { data: blockData, error: blockErr } = await supabase
          .from('cb_blocks')
          .select('id')
          .in('message_id', batch);
        
        if (blockErr) {
          blockError = blockErr;
          break;
        }
        if (blockData) {
          blocks = blocks.concat(blockData);
        }
      }
    }
    
    if (msgError || fileError || blockError) {
      throw new Error(`Query errors: ${msgError?.message}, ${fileError?.message}, ${blockError?.message}`);
    }
    
    const messageIds = messages?.map(m => m.id) || [];
    const fileIds = files?.map(f => f.id) || [];
    const blockIds = blocks?.map(b => b.id) || [];
    
    console.log(`[Existing Content] Found: ${messageIds.length} messages, ${fileIds.length} files, ${blockIds.length} blocks`);
    
    res.json({
      conversation_id: conversationId,
      exists: true,
      existing_message_ids: messageIds,
      existing_file_ids: fileIds,
      existing_block_ids: blockIds
    });
    
  } catch (err: any) {
    console.error('[Existing Content] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects/:projectId/stats', async (req, res) => {
  console.log('=== STATS ENDPOINT CALLED ===');
  const { projectId } = req.params;
  try {
    // Get all conversations with their latest message date
    const { data: conversations, error: convError } = await supabase
      .from('cb_conversations')
      .select(`
        id,
        message_count,
        started_at,
        captured_at,
        updated_at
      `)
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false });
    
    if (convError) throw convError;
    
    // Get file counts from cb_files
    const [textFilesRes, codeFilesRes] = await Promise.all([
      supabase.from('cb_files').select('id', { count: 'exact', head: true })
        .eq('project_id', projectId).eq('file_type', 'text'),
      supabase.from('cb_files').select('id', { count: 'exact', head: true })
        .eq('project_id', projectId).eq('file_type', 'code'),
    ]);

    // Get entity counts
    let entityCount = 0;
    try {
      const { count, error: entError } = await supabase
        .from('cb_entities')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId);
      if (!entError) entityCount = count || 0;
    } catch (e) {
      console.error('Error getting entity count:', e);
    }
    
    // Get block counts from cb_blocks
    let blockCounts = { codeBlocks: 0, textBlocks: 0 };
    try {
      const { data: counts, error } = await supabase.rpc('get_block_counts', {
        p_project_id: projectId
      });
      if (!error && counts && counts[0]) {
        blockCounts = {
          codeBlocks: Number(counts[0].code_count) || 0,
          textBlocks: Number(counts[0].file_count) || 0
        };
      }
    } catch (e) {
      console.error('Error getting block counts:', e);
    }
    
    // Determine which conversations need capture
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    let conversationsWithMessages = 0;
    let conversationsNeedingCapture = 0;
    const staleConversationIds: string[] = [];
    
    conversations?.forEach(conv => {
      const capturedAt = conv.captured_at ? new Date(conv.captured_at) : null;
      const updatedAt = conv.updated_at ? new Date(conv.updated_at) : null;
      
      // Needs capture if: no messages yet, OR updated since last capture
      const needsCapture = conv.message_count === 0 || 
        (updatedAt && (!capturedAt || updatedAt > capturedAt));
      
      if (needsCapture) {
        conversationsNeedingCapture++;
        staleConversationIds.push(conv.id);
      } else {
        conversationsWithMessages++;
      }
    });
    
    const totalMessages = conversations?.reduce((sum, conv) => 
      sum + (conv.message_count || 0), 0) || 0;
    
    res.json({
      totalConversations: conversations?.length || 0,
      conversationsWithMessages,
      conversationsNeedingCapture,
      staleConversationIds,
      totalMessages: totalMessages,
      textFiles: textFilesRes.count ?? 0,
      codeFiles: codeFilesRes.count ?? 0,
      textBlocks: blockCounts.textBlocks,
      codeBlocks: blockCounts.codeBlocks,
      entityCount,
    });
  } catch (err: any) {
    console.error('[stats] error:', err.message || err);
    res.status(500).json({ error: err.message || 'Failed to load stats' });
  }
});

// Get embedding statistics for a project
app.get('/api/projects/:projectId/embedding-stats', async (req, res) => {
  const { projectId } = req.params;
  
  try {
    const [messageEmbed, fileEmbed, convEmbed] = await Promise.all([
      supabase.from('cb_message_embeddings')
        .select('*', { count: 'exact', head: true })
        .eq('project_id', projectId),
      supabase.from('cb_file_embeddings')
        .select('*', { count: 'exact', head: true })
        .eq('project_id', projectId),
      supabase.from('cb_conversation_embeddings')
        .select('*', { count: 'exact', head: true })
        .eq('project_id', projectId)
    ]);
    
    res.json({
      messages: messageEmbed.count ?? 0,
      files: fileEmbed.count ?? 0,
      conversations: convEmbed.count ?? 0
    });
  } catch (err: any) {
    console.error('[embedding-stats] error:', err.message || err);
    res.status(500).json({ error: err.message || 'Failed to load embedding stats' });
  }
});

// Page routes
app.get('/query-assistant', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public/query-assistant.html'));
});

app.get('/project-dashboard', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  const filePath = path.join(__dirname, 'public/project-dashboard.html');
  console.log('Serving dashboard from:', filePath);
  
  res.sendFile(filePath);
});

app.get('/admin', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  const filePath = path.join(__dirname, 'public/admin.html');
  console.log('Serving admin from:', filePath);
  
  res.sendFile(filePath);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    services: {
      supabase: !!supabase,
      environment: process.env.NODE_ENV
    }
  });
});

// Test Supabase connection
app.get('/api/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cb_projects')
      .select('count')
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows, which is ok
      throw error;
    }

    res.json({ 
      success: true, 
      message: 'Database connection successful',
      tables: ['projects', 'conversations', 'artifacts', 'entities']
    });
  } catch (error: any) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get all projects
app.get('/api/projects', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cb_projects')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(data || []);
  } catch (error: any) {
    res.status(500).json({ 
      error: error.message 
    });
  }
});

// Get all projects for multi-select (uses cb_projects table)
app.get('/api/projects/list', async (req, res) => {
    try {
      // Use authenticated user if available, fall back to query param for backward compatibility
      const userId = req.user?.userId || req.query.userId as string;
      console.log('[Projects List] Fetching projects for user:', userId, req.user ? '(from token)' : '(from query)');

      if (!userId) {
        return res.status(400).json({ success: false, error: 'User ID required' });
      }

      let query = supabase
        .from('cb_projects')
        .select('id, name, created_at, provider, provider_project_id')
        .order('name', { ascending: true });

      // Filter by user_id if not 'all'
      if (userId !== 'all') {
        query = query.eq('user_id', userId);
      }
    
    const { data: projects, error } = await query;

    if (error) {
      console.error('[Projects List] Query error:', error);
      throw error;
    }

    console.log('[Projects List] Found', projects?.length || 0, 'projects');

    // Get conversation counts for each project
    const projectsWithCounts = await Promise.all(
      (projects || []).map(async (project) => {
        const { count, error: countError } = await supabase
          .from('cb_conversations')
          .select('*', { count: 'exact', head: true })
          .eq('project_id', project.id);

        if (countError) {
          console.warn(`[Projects List] Count error for ${project.id}:`, countError);
        }

        return {
          ...project,
          conversation_count: count || 0
        };
      })
    );

    console.log('[Projects List] Returning', projectsWithCounts.length, 'projects with counts');

    res.json({
      success: true,
      projects: projectsWithCounts
    });
  } catch (error: any) {
    console.error('[Projects List] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch projects'
    });
  }
});

// Create a new project
app.post('/api/projects', async (req, res) => {
  try {
    const { id, name, description } = req.body;
    
    const projectData: any = {
      name,
      description,
      settings: {}
    };
    
    // If ID provided (from Claude auto-detection), use it
    if (id) {
      projectData.id = id;
    }
    
    const { data, error } = await supabase
      .from('cb_projects')
      .insert(projectData)
      .select()
      .single();

    if (error) throw error;

    // Create default branch
    const { error: branchError } = await supabase
      .from('branches')
      .insert({
        project_id: data.id,
        name: 'main'
      });

    if (branchError) throw branchError;

    res.json(data);
  } catch (error: any) {
    res.status(500).json({ 
      error: error.message 
    });
  }
});

// Create a test project
app.post('/api/test-project', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cb_projects')
      .insert([
        {
          name: 'Test Project',
          description: 'Testing database connection',
          settings: { test: true }
        }
      ])
      .select()
      .single();

    if (error) throw error;

    res.json({ 
      success: true, 
      project: data 
    });
  } catch (error: any) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get single project details
app.get('/api/projects/:projectId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cb_projects')
      .select('*')
      .eq('id', req.params.projectId)
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Types for the RPC row and the object we return to the UI
interface RpcConversationRow {
  id: string;
  created_at: string;
  started_at: string | null;
  updated_at: string | null;
  summary: string | null;
  message_count: number | null;
  token_count: number | null;
}

interface ParsedConversation {
  id: string;
  created_at: string;
  started_at: string | null;
  updated_at: string | null;
  summary: string | null;
  message_count: number;
  token_count: number;
  raw_messages: unknown[];
  extracted_context: Record<string, unknown>;
}

function safeJSON(s: string) { try { return JSON.parse(s); } catch { return null; } }

type ConvRow = {
  id: string;
  title: string | null;
  summary?: string | null;
  started_at: string | null;
  created_at: string | null;
  raw_messages: any;
  extracted_context: any;
  message_count: number | null;
  token_count: number | null;
};

app.get('/api/projects/:projectId/conversations', async (req: Request, res: Response) => {
  const { projectId } = req.params;
  console.log('CONVERSATIONS ENDPOINT HIT - Project:', projectId);

  const limit  = Number.isFinite(Number(req.query.limit))  ? Number(req.query.limit)  : 50;
  const offset = Number.isFinite(Number(req.query.offset)) ? Number(req.query.offset) : 0;
  const range  = (req.query.range as string) || 'all';
  const isFull = String(req.query.full ?? '').toLowerCase() === '1'
              || String(req.query.full ?? '').toLowerCase() === 'true';

  console.log('[conversations]', { projectId, limit, offset, range, full: isFull });

  if (!projectId) return res.status(400).json({ error: 'projectId is required' });

  // Use RPC approach by default
  try {
    const { data, error } = await supabase.rpc('api_get_conversations', {
      p_project: projectId,
      p_limit:   limit,
      p_offset:  offset,
      p_range:   range,
    });

    console.log('[conversations] RPC returned', data?.length, 'conversations');
    if (data && data.length > 0) {
      const emptyCount = data.filter((c: any) => c.message_count === 0).length;
      console.log('[conversations] Empty conversations in RPC result:', emptyCount);
    }

    if (error) {
      console.error('Supabase RPC error:', error);
      return res.status(502).json({ error: error?.message });
    }

    const rows: RpcConversationRow[] = Array.isArray(data) ? (data as RpcConversationRow[]) : [];

    const parsedConversations: ParsedConversation[] = rows.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      started_at: r.started_at ?? null,
      updated_at: r.updated_at ?? null,
      summary: r.summary ?? null,
      message_count: r.message_count ?? 0,
      token_count: r.token_count ?? 0,
      raw_messages: [],
      extracted_context: {},
    }));

    const totalMessages = rows.reduce<number>((sum, r) => sum + (r.message_count ?? 0), 0);
    
    // Get file and block counts
    const [codeFileRes, textFileRes] = await Promise.all([
      supabase.from('cb_files').select('id', { count: 'exact', head: true })
        .eq('project_id', projectId).eq('file_type', 'code'),
      supabase.from('cb_files').select('id', { count: 'exact', head: true })
        .eq('project_id', projectId).in('file_type', ['text', 'document'])
    ]);
    
    const { data: blockData } = await supabase.rpc('get_block_counts', {
      p_project_id: projectId
    });

    return res.json({
      conversations: parsedConversations,
      totalMessages,
      textFiles: textFileRes.count || 0,
      codeFiles: codeFileRes.count || 0,
      textBlocks: blockData?.[0]?.file_count || 0,
      codeBlocks: blockData?.[0]?.code_count || 0,
    });
  } catch (e: any) {
    console.error('Error in conversations endpoint (RPC):', e);
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// ============================================
  // BUNDLE ROUTES
  // ============================================

  // GET /api/bundles - List user's bundles
  app.get('/api/bundles', async (req, res) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { data, error } = await supabase
        .from('cb_bundles')
        .select(`
          id,
          name,
          description,
          created_at,
          cb_bundle_projects (
            project_id,
            cb_projects (
              id,
              name,
              provider
            )
          )
        `)
        .eq('user_id', userId)
        .order('name');

      if (error) throw error;

      // Transform the data to a cleaner format
      const bundles = (data || []).map(bundle => ({
        id: bundle.id,
        name: bundle.name,
        description: bundle.description,
        created_at: bundle.created_at,
        projects: bundle.cb_bundle_projects?.map((bp: any) => ({
          id: bp.cb_projects?.id,
          name: bp.cb_projects?.name,
          provider: bp.cb_projects?.provider
        })) || []
      }));

      res.json({ success: true, bundles });
    } catch (error: any) {
      console.error('[Bundles] List error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/bundles - Create a bundle
  app.post('/api/bundles', async (req, res) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { name, description, projectIds } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'Bundle name required' });
      }

      // Create the bundle
      const { data: bundle, error: bundleError } = await supabase
        .from('cb_bundles')
        .insert({ user_id: userId, name, description })
        .select()
        .single();

      if (bundleError) throw bundleError;

      // Add projects if provided
      if (projectIds && projectIds.length > 0) {
        const bundleProjects = projectIds.map((projectId: string) => ({
          bundle_id: bundle.id,
          project_id: projectId
        }));

        const { error: linkError } = await supabase
          .from('cb_bundle_projects')
          .insert(bundleProjects);

        if (linkError) throw linkError;
      }

      console.log(`[Bundles] Created bundle "${name}" with ${projectIds?.length || 0} projects`);
      res.json({ success: true, bundle });
    } catch (error: any) {
      console.error('[Bundles] Create error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/bundles/:id - Get bundle details
  app.get('/api/bundles/:id', async (req, res) => {
    try {
      const userId = req.user?.userId;
      const { id } = req.params;

      const { data, error } = await supabase
        .from('cb_bundles')
        .select(`
          id,
          name,
          description,
          created_at,
          cb_bundle_projects (
            project_id,
            cb_projects (
              id,
              name,
              provider
            )
          )
        `)
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (error) throw error;

      const bundle = {
        id: data.id,
        name: data.name,
        description: data.description,
        created_at: data.created_at,
        projects: data.cb_bundle_projects?.map((bp: any) => ({
          id: bp.cb_projects?.id,
          name: bp.cb_projects?.name,
          provider: bp.cb_projects?.provider
        })) || []
      };

      res.json({ success: true, bundle });
    } catch (error: any) {
      console.error('[Bundles] Get error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // PUT /api/bundles/:id - Update bundle
  app.put('/api/bundles/:id', async (req, res) => {
    try {
      const userId = req.user?.userId;
      const { id } = req.params;
      const { name, description } = req.body;

      const { data, error } = await supabase
        .from('cb_bundles')
        .update({ name, description, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) throw error;
      res.json({ success: true, bundle: data });
    } catch (error: any) {
      console.error('[Bundles] Update error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/bundles/:id - Delete bundle
  app.delete('/api/bundles/:id', async (req, res) => {
    try {
      const userId = req.user?.userId;
      const { id } = req.params;

      const { error } = await supabase
        .from('cb_bundles')
        .delete()
        .eq('id', id)
        .eq('user_id', userId);

      if (error) throw error;
      res.json({ success: true });
    } catch (error: any) {
      console.error('[Bundles] Delete error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/bundles/:id/projects - Add projects to bundle
  app.post('/api/bundles/:id/projects', async (req, res) => {
    try {
      const userId = req.user?.userId;
      const { id } = req.params;
      const { projectIds } = req.body;

      // Verify bundle ownership
      const { data: bundle } = await supabase
        .from('cb_bundles')
        .select('id')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (!bundle) {
        return res.status(404).json({ error: 'Bundle not found' });
      }

      const bundleProjects = projectIds.map((projectId: string) => ({
        bundle_id: id,
        project_id: projectId
      }));

      const { error } = await supabase
        .from('cb_bundle_projects')
        .upsert(bundleProjects, { onConflict: 'bundle_id,project_id' });

      if (error) throw error;
      res.json({ success: true });
    } catch (error: any) {
      console.error('[Bundles] Add projects error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/bundles/:id/projects/:projectId - Remove project from bundle
  app.delete('/api/bundles/:id/projects/:projectId', async (req, res) => {
    try {
      const userId = req.user?.userId;
      const { id, projectId } = req.params;

      // Verify bundle ownership
      const { data: bundle } = await supabase
        .from('cb_bundles')
        .select('id')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (!bundle) {
        return res.status(404).json({ error: 'Bundle not found' });
      }

      const { error } = await supabase
        .from('cb_bundle_projects')
        .delete()
        .eq('bundle_id', id)
        .eq('project_id', projectId);

      if (error) throw error;
      res.json({ success: true });
    } catch (error: any) {
      console.error('[Bundles] Remove project error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // === Website HTML pages (served from packages/website) ===
  const websitePages: Record<string, string> = {
    '/':                'index.html',
    '/github/setup':    'github/setup/index.html',
    '/install/chrome':  'install/chrome/index.html',
    '/install/vscode':  'install/vscode/index.html',
    '/privacy':         'privacy/index.html',
    '/reset-password':  'reset-password/index.html',
    '/verify-email':    'verify-email/index.html',
  };

for (const [route, file] of Object.entries(websitePages)) {
  app.get(route, (_req, res) => {
    res.sendFile(path.resolve(websitePath, file));
  });
}

// Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Backend server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔌 Test DB: http://localhost:${PORT}/api/test-db`);
  console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
});