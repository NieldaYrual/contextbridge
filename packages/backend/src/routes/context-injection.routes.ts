// packages/backend/src/routes/context-injection.routes.ts
import { Router, type Request, type Response } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import { getEmbeddingService, embedBatch, EMBEDDING_MODEL_NAME, EMBEDDING_DIMENSIONS } from '../services/embedding.service';
import { createClient as createSbClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { env } from '../env';
import { encode as encodeTokens } from 'gpt-tokenizer';
import { retryWithBackoff } from '../utils/retryWithBackoff';
import type { Express} from 'express';
// Using built-in fetch (Node.js 18+)
import { SEARCH_CONFIG, filterStopWords } from '../config/search-config';

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (!env.OPENAI_API_KEY) return null;
  if (_openai) return _openai;
  _openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return _openai;
}
const EMBED_MODEL = env.OPENAI_EMBED_MODEL; // 'text-embedding-3-small'

function exists<T>(x: T | null | undefined): x is T { return x !== null && x !== undefined; }

interface SearchResult {
  type: 'message' | 'file';
  id: string;
  conversation_id: string;
  content: string;
  score: number;        
  original_score?: number; 
  // Added 'entity' to the allowed sources
  source: 'semantic' | 'keyword' | 'hybrid' | 'entity'; 
  created_at: string;
  author_role?: string; 
  file_name?: string;   
  // Added optional field for your existing entity logic
  entity_type?: string; 
}

// Type definitions
interface Entity {
  id: string;
  canonical_name: string;
  entity_type: string;
}

interface Conversation {
  id: string;
  summary: string | null;
  created_at: string;
  message_count: number;
  token_count?: number;
}

interface EntityMention {
  message_id: string;
  entity_id: string;
}

interface Message {
  conversation_id: string;
}

interface RelevantMessage {
  conversation_id: string;
  message_index: number;
  sender: string;
  text_excerpt: string;
  full_text?: string;
}

interface ConversationLink {
  source_conversation_id: string;
  target_conversation_id: string;
  overlap_entities: number;
  similarity_score: number | null;
}

interface ContextInjection {
  project_id: string;
  user_message: string;
  extracted_keywords: string[];
  matched_entities: string[];
  selected_conversations: string[];
  created_at: string;
}

type MessageRow = {
  id: string;
  conversation_id: string;
  content?: string | null;
  author_role?: string | null;
  created_at?: string | null;
};

type EntityMentionRow = {
  message_id: string;
  cb_messages?: MessageRow | null; // relation might be named cb_messages
  messages?: MessageRow | null;    // ...or messages
};

type EntityRow = {
  id: string;
  entity_type?: string | null;
  entity_mentions?: EntityMentionRow[] | null;
};

// Semaphore for rate limiting concurrent embeddings
class EmbeddingSemaphore {
  private active = 0;
  private readonly maxConcurrent = 3;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    
    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }

  getStatus() {
    return { active: this.active, queued: this.queue.length, maxConcurrent: this.maxConcurrent };
  }
}

const embeddingSemaphore = new EmbeddingSemaphore();

// reuse a service client (not the anon key)
const sbService = createSbClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, {
  auth: { persistSession: false },
});

async function fetchEntitiesForQuery(projectId: string, q: string, limit = 50, offset = 0) {
  // Filter stop words to improve entity match precision
  const rawTerms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const substantiveTerms = filterStopWords(rawTerms);

  // If no substantive terms remain, skip entity search
  if (substantiveTerms.length === 0) {
    console.log('[Entity Search] No substantive terms after stop word filtering, skipping');
    return [];
  }

  const filteredQuery = substantiveTerms.join(' ');
  console.log(`[Entity Search] Original: "${q}" → Filtered: "${filteredQuery}"`);

  const { data, error } = await sbService.rpc('cb_search_entities', {
    p_project_id: projectId,
    p_query: filteredQuery,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw new Error(error.message);

  const { termMatchWeight, mentionWeight, mentionCap } = SEARCH_CONFIG.entity;

  return (data ?? []).map((e: any) => {
    const normalizedMentions = Math.min(e.mention_count || 0, mentionCap) / mentionCap;
    const score = (e.match_ratio * termMatchWeight) + (normalizedMentions * mentionWeight);

    return {
      id: e.entity_id,
      name: e.name,
      type: e.type,
      mentions: e.mention_count,
      match_ratio: e.match_ratio,
      score,   // 0–1 scale, compatible with combineAndRankResults
    };
  });
}

// Add near the top with other helper functions
function cosineSimilarity(a: string, b: any): number {
  // Parse vector strings to arrays
  const vecA = JSON.parse(a.replace(/^\[|\]$/g, '').split(',').map((v: string) => v.trim()).join(','));
  const vecB = Array.isArray(b) ? b : JSON.parse(b.replace(/^\[|\]$/g, '').split(',').map((v: string) => v.trim()).join(','));
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function recencyScore(iso?: string) {
  if (!iso) return 0.5;
  const days = (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
  return 1 / (1 + days / 30);
}

type CandKind = 'message' | 'file' | 'conversation';
type CandSource = 'semantic' | 'keyword' | 'entity';

type Cand = {
  kind: CandKind;
  id: string;
  conversation_id: string;
  created_at?: string;
  source: CandSource;
  similarity?: number;
  rank?: number;
  weight?: number;
  importance?: number;
  preview: string;
  score?: number;
};

async function rpcTryMany<T = any>(
  supabase: SupabaseClient,
  tries: Array<{ name: string; params: Record<string, any> }>
): Promise<{ name: string; data: T[] }> {
  let lastErr: any = null;
  for (const t of tries) {
    try {
      const { data, error } = await supabase.rpc(t.name, t.params);
      if (error) { lastErr = error; continue; }
      return { name: t.name, data: (data as T[]) ?? [] };
    } catch (e) {
      lastErr = e;
    }
  }
  console.warn('[Context] All RPC tries failed:', tries.map(t => t.name), 'lastErr =', lastErr?.message ?? lastErr);
  return { name: tries[tries.length - 1]?.name ?? 'unknown', data: [] };
}

export function createContextInjectionRoutes(supabase: SupabaseClient) {
      const router = Router();

      // --- helpers in scope of this factory ---

      // HEAD-select to test table existence. Treat 42P01 as "doesn't exist".
      async function tableExists(tbl: string): Promise<boolean> {
        const { error } = await supabase
          // cast to any to allow dynamic table string
          .from(tbl as any)
          .select('*', { head: true, count: 'exact' })
          .limit(1);
        if (!error) return true;
        const code = (error as any)?.code ?? '';
        if (code === '42P01' || /does not exist/i.test(error.message)) return false;
        // Other errors (RLS, etc.) – assume table exists but log
        console.warn(`[diag] tableExists(${tbl}) unexpected error:`, error.message);
        return true;
      }

      // Count rows by project_id; return 0 if table missing.
      async function tableCount(tbl: string, projectId: string): Promise<number> {
        const { count, error } = await supabase
          .from(tbl as any)
          .select('*', { head: true, count: 'exact' })
          .eq('project_id', projectId);
        if (error) {
          const code = (error as any)?.code ?? '';
          if (code === '42P01' || /does not exist/i.test(error.message)) return 0;
          console.warn(`[diag] tableCount(${tbl}) error:`, error.message);
          return 0;
        }
        return count ?? 0;
      }

      // Definitive RPC existence check via tiny SQL helper `fn_exists(p_name text)`
      async function rpcExists(fnName: string): Promise<boolean> {
        try {
          const { data, error } = await supabase.rpc('fn_exists', { p_name: fnName });
          if (error) {
            console.warn('[diag] fn_exists error:', error.message);
            return false;
          }
          return Array.isArray(data) ? Boolean((data as any)[0]?.has_fn) : false;
        } catch (e: any) {
          console.warn('[diag] fn_exists threw:', e?.message || e);
          return false;
        }
      }

      // --------- DIAG ENDPOINT ---------
      // GET /api/context/_diag?projectId=...
      router.get('/_diag', async (req: Request, res: Response) => {
        const projectId = String(req.query.projectId || '').trim();

        try {
          // 1) vector extension?
          const { data: vec, error: vecErr } = await supabase.rpc('has_vector_ext');
          if (vecErr) console.warn('[diag] has_vector_ext error:', vecErr.message);
          const hasVector = Array.isArray(vec) && vec[0]?.has_vector === true;

          // 2) embedding tables present?
          const [hasCbMsg, hasCbConv, hasCbFile] = await Promise.all([
            tableExists('cb_message_embeddings'),
            tableExists('cb_conversation_embeddings'),
            tableExists('cb_file_embeddings'),
          ]);

          // 3) counts per project (only if table exists)
          const [messageEmbeds, conversationEmbeds, fileEmbeds] = await Promise.all([
            hasCbMsg ? tableCount('cb_message_embeddings', projectId) : Promise.resolve(0),
            hasCbConv ? tableCount('cb_conversation_embeddings', projectId) : Promise.resolve(0),
            hasCbFile ? tableCount('cb_file_embeddings', projectId) : Promise.resolve(0),
          ]);

          // 4) RPCs present? (definitive via fn_exists)
          const [
            hasMatchMsgs,
            hasMatchConvs,
            hasSearchMsg,
            hasSearchFile,
            hasSearchConv,
          ] = await Promise.all([
            rpcExists('match_cb_messages'),
            rpcExists('match_cb_conversations'),
            rpcExists('search_messages_by_embedding'),
            rpcExists('search_files_by_embedding'),
            rpcExists('search_conversations_by_embedding'),
          ]);

          res.json({
            projectId,
            hasVector,
            tables: { hasCbMsg, hasCbConv, hasCbFile },
            counts: { messageEmbeds, conversationEmbeds, fileEmbeds },
            rpcs: {
              match_cb_messages: hasMatchMsgs,
              match_cb_conversations: hasMatchConvs,
              search_messages_by_embedding: hasSearchMsg,
              search_files_by_embedding: hasSearchFile,
              search_conversations_by_embedding: hasSearchConv,
            },
          });
        } catch (e: any) {
          console.error('[context/_diag] error', e);
          res.status(500).json({ error: e.message || String(e) });
        }
      });

      // Redirect heres for versioning
      router.post('/analyze', (req: Request, res: Response) => {
        res.redirect(307, '/api/context/analyze-v2');
      });

    // --- V2 enhancements below ---
    // Enhanced analyze endpoint with semantic search (NOW HYBRID)
    router.post('/analyze-v2', async (req, res) => {
      try {
        const { message, technical_identifiers, projectId, projectIds, maxTokens = 1400 } = req.body;
        const q = String(message ?? '');
        const exactIdentifiers = String(technical_identifiers || '');
        const limit = parseInt(req.body.limit) || 20000;

        // Support both single projectId and multiple projectIds
        const searchProjectIds = projectIds && Array.isArray(projectIds) && projectIds.length > 0
          ? projectIds
          : projectId
            ? [projectId]
            : [];

        if (!message || searchProjectIds.length === 0) {
          return res.status(400).json({ 
            error: 'Missing required fields: message and projectId (or projectIds array)' 
          });
        }

        console.log('[Context] Enhanced analysis for projects:', searchProjectIds);

        // Get project names for results
        const { data: projects } = await supabase
          .from('cb_projects')
          .select('id, name')
          .in('id', searchProjectIds);

        const projectMap = new Map(projects?.map(p => [p.id, p.name]) || []);
        
        // Use your existing keyword extraction (for metadata/frontend display)
        const { words, phrases } = extractKeywords(message);

        // Generate embedding for semantic search
        const embeddingService = getEmbeddingService();
        
        // --- 1. HYBRID SEARCH (Semantic + Keyword Fused) ---
        // We use the new searchBySemantic function which implements RRF internally
        let hybridResults: SearchResult[] = [];
        
        try {
          const embeddingResult = await embeddingService.generateEmbedding(message);
          
          // Run Hybrid Search across ALL selected projects in parallel
          // Extract and sanitize limit from request (default 25, max 200)
          const requestedLimit = Math.min(Math.max(parseInt(req.body.limit) || 25, 1), SEARCH_CONFIG.limits.resultMax);

          const resultsPerProject = await Promise.all(
            searchProjectIds.map(async (pid) => {
              try {
                // CALLING OUR NEW HYBRID ENGINE
                const projectResults = await searchBySemantic(
                  q, 
                  embeddingResult.embedding,  // ✅ This is number[]
                  pid, 
                  supabase,
                  requestedLimit  // Pass the limit from request
                );
                
                 // Enrich with project metadata
                 return projectResults.map(r => ({
                   ...r,
                   project_id: pid,
                   project_name: projectMap.get(pid) || 'Unknown Project'
                 }));
               } catch (err) {
                 console.warn(`[Hybrid Search] Failed for project ${pid}:`, err);
                 return [];
               }
            })
          );

          // Flatten, sort by RRF score, and cap at global limit
          hybridResults = resultsPerProject.flat()
            .sort((a, b) => b.score - a.score)
            .slice(0, SEARCH_CONFIG.limits.resultDefault);

          console.log(`[Context] Hybrid Search (RRF) found: ${hybridResults.length} items`);

        } catch (embErr: any) {
          console.error('[Context] Hybrid search failed:', embErr.message);
        }

        // --- 2. ENTITY SEARCH (RPC) ---
        let entityResultsRpc: any[] = [];
        try {
           const allEntityResults = await Promise.all(
             searchProjectIds.map(async (projId) => {
               try {
                 const results = await fetchEntitiesForQuery(projId, q, SEARCH_CONFIG.limits.entity, 0);
                 return results.map((e: any) => ({
                   ...e,
                   project_id: projId,
                   project_name: projectMap.get(projId) || 'Unknown Project'
                 }));
               } catch (err) { return []; }
             })
           );
           entityResultsRpc = allEntityResults.flat();
           // (Optional: fallback logic omitted for brevity, but can be kept if desired)
        } catch (e: any) {
           console.warn('[analyze-v2] entity RPC error:', e.message);
        }

        // --- 3. COMBINE RESULTS ---
        // We put hybridResults into 'semantic' bucket for compatibility with downstream
        // formatting, effectively bypassing the old separation.
        const semanticResults = hybridResults; 
        const keywordResults: any[] = []; // Keywords are already fused into 'semanticResults'
        const entityResults = entityResultsRpc;

       // Create Entity Cards for display in API response
        const entityCards = entityResults.map(e => ({
          kind: 'entity' as const,
          id: e.id,
          title: e.name,
          subtitle: `${e.type ?? 'entity'} • ${e.mentions} mentions`,
          content: e.name,
          score: e.score ?? 0,
          conversation_id: null,
          source: { kind: 'entity', id: e.id }
        }));

        // Resolve entity matches to their actual messages via cb_entity_mentions
        let entitySearchResults: SearchResult[] = [];
        if (entityResults.length > 0) {
          const entityIds = entityResults.map(e => e.id);
          
          const { data: mentions, error: mentionErr } = await supabase
            .from('cb_entity_mentions')
            .select('entity_id, message_id')
            .in('entity_id', entityIds)
            .not('message_id', 'is', null)
            .limit(50);
          
          if (!mentionErr && mentions && mentions.length > 0) {
            // Build entity score lookup
            const entityScoreMap = new Map(entityResults.map(e => [e.id, e.score ?? 0]));
            
            // Get unique message IDs
            const messageIds = [...new Set(mentions.map(m => m.message_id))];
            
            const { data: msgRows, error: msgErr } = await supabase
              .from('cb_messages')
              .select('id, content, conversation_id, role, created_at')
              .in('id', messageIds);
            
            if (!msgErr && msgRows) {
              // Get conversation titles
              const convIds = [...new Set(msgRows.map(m => m.conversation_id))];
              const { data: convRows } = await supabase
                .from('cb_conversations')
                .select('id, title, summary')
                .in('id', convIds);
              const convTitleMap = new Map(
                (convRows || []).map(c => [c.id, c.title || c.summary || 'Untitled'])
              );
              
              // Map mention→message, carrying the entity score
              const msgMap = new Map(msgRows.map(m => [m.id, m]));
              const seen = new Set<string>();
              
              for (const mention of mentions) {
                const msg = msgMap.get(mention.message_id);
                if (!msg || seen.has(msg.id)) continue;
                seen.add(msg.id);
                
                entitySearchResults.push({
                  type: 'message' as any,
                  id: msg.id,
                  conversation_id: msg.conversation_id,
                  content: msg.content,
                  score: entityScoreMap.get(mention.entity_id) ?? 0,
                  source: 'entity',
                  created_at: msg.created_at,
                  conversation_title: convTitleMap.get(msg.conversation_id) || 'Untitled',
                } as any);
              }
              
              console.log(`[Entity Search] Resolved ${entityResults.length} entities → ${entitySearchResults.length} messages`);
            }
          } else {
            console.log(`[Entity Search] No message mentions found for ${entityResults.length} entities`);
          }
        }
        
        // This function might re-rank, but since we passed empty keywordResults, 
        // it should largely respect our RRF order.
        const combinedResults = combineAndRankResults(
          semanticResults,
          keywordResults,
          entitySearchResults,
        );
        
        // Get existing conversation data for context
        const topConvIds = [...new Set(combinedResults.slice(0, 100).map(r => r.conversation_id))];
        const { data: conversations } = await supabase
          .from('cb_conversations')
          .select('id, title, summary, started_at, project_id')
          .in('id', topConvIds);

        const conversationsWithProjects = (conversations || []).map(conv => ({
          ...conv,
          project_name: projectMap.get(conv.project_id) || 'Unknown Project'
        }));

        const groupedResults = groupResultsByConversation(combinedResults, conversations || []);
        const preview = createEnhancedPreview(groupedResults, maxTokens);

        // --- 4. CODEX SEARCH (External Code) ---
        let codex: any[] = [];
        try {
          if (searchProjectIds.length > 0) {
            const allCodexResults = await Promise.all(
              searchProjectIds.map(async (pid) => {
                try {
                  const codexQuery = exactIdentifiers || [...phrases, ...words].join(' ').trim() || q;
                  console.log(`[analyze-v2] Codex query: "${codexQuery}"`);
                  const { data: codexData, error: codexError } = await supabase.rpc(
                    'cb_search_codex_text',
                    { p_project_id: pid, p_query: codexQuery, p_limit: 20 }
                  );
                  if (codexError) return [];
                  
                  return (codexData || []).map((row: any) => ({
                    kind: 'codex',
                    provider: 'codex',
                    chunkId: row.chunk_id,
                    sourceId: row.source_id,
                    artifactId: row.artifact_id,
                    filePath: row.file_path,
                    snippet: ((row.snippet as string) || '').replace(/\r\n/g, '\n'),
                    startLine: row.start_line,
                    endLine: row.end_line,
                    createdAt: row.created_at,
                    projectId: pid
                  }));
                } catch (err) { return []; }
              })
            );
            codex = allCodexResults.flat();
          }
        } catch (e) { console.error('[analyze-v2] Codex error:', e); }

        res.json({
          success: true,
          query: message,
          keywords: [...phrases, ...words],
          searchTerms: { words, phrases },
          searchMethods: {
            semantic: semanticResults.filter(r => r.source === 'semantic').length,
            // Our hybrid search might label some as 'keyword' or 'hybrid', count them here:
            keyword: semanticResults.filter(r => r.source === 'keyword' || r.source === 'hybrid').length, 
            entity: entityResults.length
          },
          totalResults: combinedResults.length,
          uniqueConversations: new Set(combinedResults.map(r => r.conversation_id)).size,
          results: groupedResults.slice(0, 100),
          metadata: {
            breakdown: {
              semantic: semanticResults.length,
              keyword: 0, // Legacy field
              entity: entityResults.length
            },
            uniqueConversations: new Set(combinedResults.map(r => r.conversation_id)).size
          },
          preview,
          entities: entityResults.slice(0, 10).map(e => ({
            id: e.id, name: e.name, type: e.type, mentions: e.mentions
          })),
          resultsByKind: {
            semantic: semanticResults,
            keyword: keywordResults,
            entity: entityCards
          },
          conversations: conversationsWithProjects.slice(0, 5),
          searchedProjects: Array.from(projectMap.entries()).map(([id, name]) => ({ id, name })),
          relevant_messages: combinedResults
            .filter(r => r.type === 'message')
            .slice(0, 10)
            .map(r => ({
              conversation_id: r.conversation_id,
              message_index: 0,
              sender: r.author_role || 'unknown',
              text_excerpt: r.content.substring(0, 200),
              full_text: r.content.substring(0, 1000)
            })),
          codex,
        });
        
      } catch (error: any) {
        console.error('[Context] Analysis error:', error);
        res.status(500).json({ error: error.message || 'Failed to analyze context' });
      }
    });;

    // POST /api/context/_backfill/embeddings/messages
    router.post('/_backfill/embeddings/messages', async (req, res) => {
      try {
        const projectId = String(req.body?.projectId || '').trim();
        const limitNum = Number(req.body?.limit ?? 200);
        const limit = Number.isFinite(limitNum) ? Math.max(1, Math.min(500, limitNum)) : 200;

        if (!projectId) return res.status(400).json({ error: 'projectId required' });

        const embeddingService = getEmbeddingService();

        const { data: rows, error: qErr } = await retryWithBackoff(
          async () => {
            const result = await supabase.rpc('cb_next_messages_to_embed', {
              p_project: projectId,
              p_limit: limit
            });

            if (result.error) throw result.error;
            return result;
          },
          { maxRetries: 3, baseDelay: 2000, maxDelay: 10000 }
        ).catch(error => ({ data: null, error }));
        
        if (qErr) throw qErr;

        type Row = { message_id: string; conversation_id: string; content: string | null; created_at: string; retry_count: number };
        const batch = (rows as Row[] | null) ?? [];
        if (batch.length === 0) return res.json({ projectId, fetched: 0, inserted: 0, failed: 0, done: true });

        const toUpsert = [];
        const failures = [];
        let modelUsed = '';
        let dimensionsUsed = 0;

        // Pre-filter: rows with empty/whitespace-only content can't be embedded
        // (OpenAI rejects empty input; embedBatch returns ZERO which our failure
        // detector would misclassify as an API failure → infinite retry loop)
        const ZERO_VECTOR = new Array(1536).fill(0);
        const emptyRows = batch.filter(row => !row.content || row.content.trim().length === 0);
        const nonEmptyRows = batch.filter(row => row.content && row.content.trim().length > 0);

        if (emptyRows.length > 0) {
          console.log(`[backfill messages] Marking ${emptyRows.length} empty-content rows as skipped_empty`);
          for (const row of emptyRows) {
            toUpsert.push({
              message_id: row.message_id,
              project_id: projectId,
              conversation_id: row.conversation_id,
              embedding: ZERO_VECTOR,
              embedding_model: EMBEDDING_MODEL_NAME,
              embedding_dimensions: EMBEDDING_DIMENSIONS,
              status: 'skipped_empty',
              retry_count: 0,
              last_error: null,
              last_attempted_at: new Date().toISOString()
            });
            modelUsed = EMBEDDING_MODEL_NAME;
            dimensionsUsed = EMBEDDING_DIMENSIONS;
          }
        }

        // NEW BATCHING LOGIC — only non-empty rows get sent to OpenAI
        const texts = nonEmptyRows.map(row => (row.content ?? '').slice(0, 8000));
        const vectors = texts.length > 0 ? await embedBatch(texts, { projectId }) : [];
        for (let i = 0; i < nonEmptyRows.length; i++) {
          const row = nonEmptyRows[i];
          const vector = vectors[i];
          
          // embedBatch returns an array of zeros if the batch fails
          const isFailed = vector.every(v => v === 0);
          if (isFailed) {
            const currentRetry = row.retry_count || 0;
            const newRetryCount = currentRetry + 1;
            const status = newRetryCount >= 5 ? 'max_retries_exceeded' : 'failed';
            
            console.error(`[backfill messages] Failed to embed message ${row.message_id} (attempt ${newRetryCount}/5)`);
            
            failures.push({
              message_id: row.message_id,
              project_id: projectId,
              conversation_id: row.conversation_id,
              status,
              retry_count: newRetryCount,
              last_error: 'Batch embedding API failure',
              last_attempted_at: new Date().toISOString()
            });
          } else {
            toUpsert.push({
              message_id: row.message_id,
              project_id: projectId,
              conversation_id: row.conversation_id,
              embedding: vector,
              embedding_model: EMBEDDING_MODEL_NAME,
              embedding_dimensions: EMBEDDING_DIMENSIONS,
              status: 'success',
              retry_count: 0,
              last_error: null,
              last_attempted_at: new Date().toISOString()
            });
            modelUsed = EMBEDDING_MODEL_NAME;
            dimensionsUsed = EMBEDDING_DIMENSIONS;
          }
        }

        if (toUpsert.length > 0) {
          const { error: upErr } = await supabase
            .from('cb_message_embeddings')
            .upsert(toUpsert, { onConflict: 'message_id', ignoreDuplicates: false });
          if (upErr) throw upErr;
        }

        if (failures.length > 0) {
          const { error: failErr } = await supabase
            .from('cb_message_embeddings')
            .upsert(failures, { onConflict: 'message_id', ignoreDuplicates: false });
          if (failErr) console.error('[backfill messages] Failed to track errors:', failErr.message);
        }

        res.json({
          projectId,
          fetched: batch.length,
          inserted: toUpsert.length,
          failed: failures.length,
          modelUsed,
          dimensionsUsed,
          done: batch.length < limit,
        });
      } catch (e: any) {
        console.error('[backfill messages] error:', e?.message || e);
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // POST /api/context/_backfill/embeddings/blocks
    router.post('/_backfill/embeddings/blocks', async (req, res) => {
      try {
        const projectId = String(req.body?.projectId || '').trim();
        const conversationId = req.body?.conversationId;
        const limitNum = Number(req.body?.limit ?? 100);
        const limit = Number.isFinite(limitNum) ? Math.max(1, Math.min(500, limitNum)) : 100;

        if (!projectId) return res.status(400).json({ error: 'projectId required' });

        const embeddingService = getEmbeddingService();

        const rpcParams: any = { p_project: projectId, p_limit: limit };
        if (conversationId) rpcParams.p_conversation = conversationId;

        const { data: rows, error: qErr } = await retryWithBackoff(
          async () => {
            const result = await supabase.rpc('cb_next_blocks_to_embed', rpcParams);
            if (result.error) throw result.error;
            return result;
          },
          { maxRetries: 3, baseDelay: 2000, maxDelay: 10000 }
        ).catch(error => ({ data: null, error }));

        if (qErr) throw qErr;

        type Row = { 
          block_id: string; 
          message_id: string;
          content: string | null;
          created_at: string;
          retry_count: number;
        };
        const batch = (rows as Row[] | null) ?? [];
        if (batch.length === 0) return res.json({ projectId, conversationId, fetched: 0, inserted: 0, failed: 0, done: true });

        const toUpsert = [];
        const failures = [];
        let modelUsed = '';
        let dimensionsUsed = 0;

        // Pre-filter: rows with empty/whitespace-only content can't be embedded.
        // (OpenAI rejects empty input; embedBatch returns ZERO which our failure
        // detector would misclassify as an API failure → infinite retry loop.)
        const ZERO_VECTOR = new Array(1536).fill(0);
        const emptyRows = batch.filter(row => !row.content || row.content.trim().length === 0);
        const nonEmptyRows = batch.filter(row => row.content && row.content.trim().length > 0);

        if (emptyRows.length > 0) {
          console.log(`[backfill blocks] Marking ${emptyRows.length} empty-content rows as skipped_empty`);
          for (const row of emptyRows) {
            toUpsert.push({
              block_id: row.block_id,
              project_id: projectId,
              message_id: row.message_id,
              embedding: ZERO_VECTOR,
              embedding_model: EMBEDDING_MODEL_NAME,
              embedding_dimensions: EMBEDDING_DIMENSIONS,
              status: 'skipped_empty',
              retry_count: 0,
              last_error: null,
              last_attempted_at: new Date().toISOString(),
              created_at: row.created_at
            });
            modelUsed = EMBEDDING_MODEL_NAME;
            dimensionsUsed = EMBEDDING_DIMENSIONS;
          }
        }

        const texts = nonEmptyRows.map(row => (row.content ?? '').slice(0, 8000));
        const vectors = texts.length > 0 ? await embedBatch(texts, { projectId }) : [];

        for (let i = 0; i < nonEmptyRows.length; i++) {
          const row = nonEmptyRows[i];
          const vector = vectors[i];
          const isFailed = vector.every(v => v === 0);

          if (isFailed) {
            const currentRetry = row.retry_count || 0;
            const newRetryCount = currentRetry + 1;
            const status = newRetryCount >= 5 ? 'max_retries_exceeded' : 'failed';
            
            failures.push({
              block_id: row.block_id,
              project_id: projectId,
              message_id: row.message_id,
              status,
              retry_count: newRetryCount,
              last_error: 'Batch embedding API failure',
              last_attempted_at: new Date().toISOString()
            });
          } else {
            toUpsert.push({
              block_id: row.block_id,
              project_id: projectId,
              message_id: row.message_id,
              embedding: vector,
              embedding_model: EMBEDDING_MODEL_NAME,
              embedding_dimensions: EMBEDDING_DIMENSIONS,
              status: 'success',
              retry_count: 0,
              last_error: null,
              last_attempted_at: new Date().toISOString(),
              created_at: row.created_at
            });
            modelUsed = EMBEDDING_MODEL_NAME;
            dimensionsUsed = EMBEDDING_DIMENSIONS;
          }
        }

        if (toUpsert.length > 0) {
          const { error: upErr } = await supabase
            .from('cb_block_embeddings')
            .upsert(toUpsert, { onConflict: 'block_id', ignoreDuplicates: false });
          if (upErr) throw upErr;
        }

        if (failures.length > 0) {
          const { error: failErr } = await supabase
            .from('cb_block_embeddings')
            .upsert(failures, { onConflict: 'block_id', ignoreDuplicates: false });
          if (failErr) console.error('[backfill blocks] Failed to track errors:', failErr.message);
        }

        res.json({
          projectId,
          conversationId,
          fetched: batch.length,
          inserted: toUpsert.length,
          failed: failures.length,
          modelUsed,
          dimensionsUsed,
          done: batch.length < limit,
        });
      } catch (e: any) {
        console.error('[backfill blocks] error:', e?.message || e);
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // POST /api/context/_backfill/embeddings/conversations
    router.post('/_backfill/embeddings/conversations', async (req, res) => {
      try {
        const projectId = String(req.body?.projectId || '').trim();
        const limitNum = Number(req.body?.limit ?? 100);
        const limit = Number.isFinite(limitNum) ? Math.max(1, Math.min(500, limitNum)) : 100;

        if (!projectId) return res.status(400).json({ error: 'projectId required' });

        const embeddingService = getEmbeddingService();

        const { data: rows, error: qErr } = await retryWithBackoff(
          async () => {
            const result = await supabase.rpc('cb_next_conversations_to_embed', {
              p_project: projectId,
              p_limit: limit,
            });

            if (result.error) throw result.error;
            return result;
          },
          { maxRetries: 3, baseDelay: 2000, maxDelay: 10000 }
        ).catch(error => ({ data: null, error }));

        if (qErr) throw qErr;

        type Row = { 
          conversation_id: string; 
          title: string | null; 
          summary: string | null; 
          created_at: string;
          retry_count: number;
        };
        const batch = (rows as Row[] | null) ?? [];
        if (batch.length === 0) return res.json({ projectId, fetched: 0, inserted: 0, failed: 0, done: true });

        const toUpsert = [];
        const failures = [];
        let modelUsed = '';
        let dimensionsUsed = 0;

        // Pre-filter: rows whose title + summary are both empty can't be embedded.
        // (OpenAI rejects empty input; embedBatch returns ZERO which our failure
        // detector would misclassify as an API failure → infinite retry loop.)
        const ZERO_VECTOR = new Array(1536).fill(0);
        const buildConvText = (row: Row) =>
          [(row.title || ''), (row.summary || '')].filter(Boolean).join('\n').slice(0, 8000);

        const emptyRows = batch.filter(row => buildConvText(row).trim().length === 0);
        const nonEmptyRows = batch.filter(row => buildConvText(row).trim().length > 0);

        if (emptyRows.length > 0) {
          console.log(`[backfill conversations] Marking ${emptyRows.length} empty-content rows as skipped_empty`);
          for (const row of emptyRows) {
            toUpsert.push({
              conversation_id: row.conversation_id,
              project_id: projectId,
              embedding: ZERO_VECTOR,
              embedding_model: EMBEDDING_MODEL_NAME,
              embedding_dimensions: EMBEDDING_DIMENSIONS,
              status: 'skipped_empty',
              retry_count: 0,
              last_error: null,
              last_attempted_at: new Date().toISOString(),
              created_at: row.created_at
            });
            modelUsed = EMBEDDING_MODEL_NAME;
            dimensionsUsed = EMBEDDING_DIMENSIONS;
          }
        }

        const texts = nonEmptyRows.map(buildConvText);
        const vectors = texts.length > 0 ? await embedBatch(texts, { projectId }) : [];

        for (let i = 0; i < nonEmptyRows.length; i++) {
          const row = nonEmptyRows[i];
          const vector = vectors[i];
          const isFailed = vector.every(v => v === 0);

          if (isFailed) {
            const currentRetry = row.retry_count || 0;
            const newRetryCount = currentRetry + 1;
            const status = newRetryCount >= 5 ? 'max_retries_exceeded' : 'failed';
            
            failures.push({
              conversation_id: row.conversation_id,
              project_id: projectId,
              status,
              retry_count: newRetryCount,
              last_error: 'Batch embedding API failure',
              last_attempted_at: new Date().toISOString()
            });
          } else {
            toUpsert.push({
              conversation_id: row.conversation_id,
              project_id: projectId,
              embedding: vector,
              embedding_model: EMBEDDING_MODEL_NAME,
              embedding_dimensions: EMBEDDING_DIMENSIONS,
              status: 'success',
              retry_count: 0,
              last_error: null,
              last_attempted_at: new Date().toISOString(),
              created_at: row.created_at
            });
            modelUsed = EMBEDDING_MODEL_NAME;
            dimensionsUsed = EMBEDDING_DIMENSIONS;
          }
        }

        if (toUpsert.length > 0) {
          const { error: upErr } = await supabase
            .from('cb_conversation_embeddings')
            .upsert(toUpsert, { onConflict: 'conversation_id', ignoreDuplicates: false });
          if (upErr) throw upErr;
        }

        if (failures.length > 0) {
          const { error: failErr } = await supabase
            .from('cb_conversation_embeddings')
            .upsert(failures, { onConflict: 'conversation_id', ignoreDuplicates: false });
          if (failErr) console.error('[backfill conversations] Failed to track errors:', failErr.message);
        }

        res.json({
          projectId,
          fetched: batch.length,
          inserted: toUpsert.length,
          failed: failures.length,
          modelUsed,
          dimensionsUsed,
          done: batch.length < limit,
        });
      } catch (e: any) {
        console.error('[backfill conversations] error:', e?.message || e);
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // POST /api/context/_backfill/embeddings/files
    router.post('/_backfill/embeddings/files', async (req, res) => {
      try {
        const projectId = String(req.body?.projectId || '').trim();
        const conversationId = req.body?.conversationId;
        const limitNum = Number(req.body?.limit ?? 100);
        const limit = Number.isFinite(limitNum) ? Math.max(1, Math.min(500, limitNum)) : 100;

        if (!projectId) return res.status(400).json({ error: 'projectId required' });

        const embeddingService = getEmbeddingService();

        const rpcParams: any = { p_project: projectId, p_limit: limit };
        if (conversationId) rpcParams.p_conversation = conversationId;

        const { data: rows, error: qErr } = await retryWithBackoff(
          async () => {
            const result = await supabase.rpc('cb_next_files_to_embed', rpcParams);
            if (result.error) throw result.error;
            return result;
          },
          { maxRetries: 3, baseDelay: 2000, maxDelay: 10000 }
        ).catch(error => ({ data: null, error }));

        if (qErr) throw qErr;

        console.log(`[backfill files] RPC returned ${(rows as any[])?.length ?? 0} rows for project ${projectId}`);

        type Row = { 
          file_id: string; 
          conversation_id: string;
          content: string | null;
          created_at: string;
          retry_count: number;
        };
        const batch = (rows as Row[] | null) ?? [];
        if (batch.length === 0) return res.json({ projectId, conversationId, fetched: 0, inserted: 0, failed: 0, done: true });

        const toUpsert = [];
        const failures = [];
        let modelUsed = '';
        let dimensionsUsed = 0;

        // Pre-filter: rows with empty/whitespace-only content can't be embedded.
        // (OpenAI rejects empty input; embedBatch returns ZERO which our failure
        // detector would misclassify as an API failure → infinite retry loop.)
        const ZERO_VECTOR = new Array(1536).fill(0);
        const emptyRows = batch.filter(row => !row.content || row.content.trim().length === 0);
        const nonEmptyRows = batch.filter(row => row.content && row.content.trim().length > 0);

        if (emptyRows.length > 0) {
          console.log(`[backfill files] Marking ${emptyRows.length} empty-content rows as skipped_empty`);
          for (const row of emptyRows) {
            toUpsert.push({
              cb_file_id: row.file_id,
              project_id: projectId,
              conversation_id: row.conversation_id,
              embedding: ZERO_VECTOR,
              embedding_model: EMBEDDING_MODEL_NAME,
              embedding_dimensions: EMBEDDING_DIMENSIONS,
              status: 'skipped_empty',
              retry_count: 0,
              last_error: null,
              last_attempted_at: new Date().toISOString(),
              created_at: row.created_at
            });
            modelUsed = EMBEDDING_MODEL_NAME;
            dimensionsUsed = EMBEDDING_DIMENSIONS;
          }
        }

        const texts = nonEmptyRows.map(row => (row.content ?? '').slice(0, 8000));
        const vectors = texts.length > 0 ? await embedBatch(texts, { projectId }) : [];

        for (let i = 0; i < nonEmptyRows.length; i++) {
          const row = nonEmptyRows[i];
          const vector = vectors[i];
          const isFailed = vector.every(v => v === 0);

          if (isFailed) {
            const currentRetry = row.retry_count || 0;
            const newRetryCount = currentRetry + 1;
            const status = newRetryCount >= 5 ? 'max_retries_exceeded' : 'failed';
            
            failures.push({
              cb_file_id: row.file_id,
              project_id: projectId,
              conversation_id: row.conversation_id,
              status,
              retry_count: newRetryCount,
              last_error: 'Batch embedding API failure',
              last_attempted_at: new Date().toISOString()
            });
          } else {
            toUpsert.push({
              cb_file_id: row.file_id,
              project_id: projectId,
              conversation_id: row.conversation_id,
              embedding: vector,
              embedding_model: EMBEDDING_MODEL_NAME,
              embedding_dimensions: EMBEDDING_DIMENSIONS,
              status: 'success',
              retry_count: 0,
              last_error: null,
              last_attempted_at: new Date().toISOString(),
              created_at: row.created_at
            });
            modelUsed = EMBEDDING_MODEL_NAME;
            dimensionsUsed = EMBEDDING_DIMENSIONS;
          }
        }

        if (toUpsert.length > 0) {
          const { error: upErr } = await supabase
            .from('cb_file_embeddings')
            .upsert(toUpsert, { onConflict: 'cb_file_id', ignoreDuplicates: false });
          if (upErr) throw upErr;
        }

        if (failures.length > 0) {
          const { error: failErr } = await supabase
            .from('cb_file_embeddings')
            .upsert(failures, { onConflict: 'cb_file_id', ignoreDuplicates: false });
          if (failErr) console.error('[backfill files] Failed to track errors:', failErr.message);
        }

        res.json({
          projectId,
          conversationId,
          fetched: batch.length,
          inserted: toUpsert.length,
          failed: failures.length,
          modelUsed,
          dimensionsUsed,
          done: batch.length < limit,
        });
      } catch (e: any) {
        console.error('[backfill files] error:', e?.message || e);
        res.status(500).json({ error: e?.message || String(e) });
      }
    });

    // POST /api/context/_auto-embed - Automatically embed a newly captured conversation
    router.post('/_auto-embed', async (req, res) => {
      const { projectId, conversationId } = req.body;
      console.log(`[Auto-Embed] Received request for project: ${projectId}, conversation: ${conversationId}`);
      
      if (!projectId) {
        return res.status(400).json({ error: 'projectId required' });
      }

      const authToken = req.headers.authorization;
      
      // Fire off embedding jobs asynchronously (don't wait for completion)
      (async () => {
        console.log(`[Auto-Embed] Starting async job for ${conversationId}`);
        // Acquire semaphore (wait if 3 are already running)
        await embeddingSemaphore.acquire();
        const status = embeddingSemaphore.getStatus();
        console.log(`[Auto-Embed] Starting for ${conversationId || 'project'} (active: ${status.active}/${status.maxConcurrent}, queued: ${status.queued})`);
        
        try {
          let totalEmbedded = { messages: 0, files: 0, blocks: 0, conversations: 0 };

          let consecutiveEmptyBatches = 0;
          const maxEmptyBatches = 3;
          
          // 1. Embed messages (loop until done) with retry awareness
          let messagesDone = false;
          consecutiveEmptyBatches = 0;
          while (!messagesDone) {
            const msgResponse = await fetch(`http://localhost:${process.env.PORT || 3001}/api/context/_backfill/embeddings/messages`, {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                'Authorization': authToken || ''
              },
              body: JSON.stringify({ projectId, limit: 500 })
            });
            if (!msgResponse.ok) {
              console.warn(`[Auto-Embed] Messages backfill returned ${msgResponse.status}, retrying in 15s...`);
              await new Promise(resolve => setTimeout(resolve, 15000));
              continue;
            }
  
            const msgResult = await msgResponse.json() as { inserted: number; done: boolean };
            
            if (msgResult.inserted > 0) {
              totalEmbedded.messages += msgResult.inserted;
              consecutiveEmptyBatches = 0; // Reset on success
              console.log(`[Auto-Embed] Messages: +${msgResult.inserted} (total: ${totalEmbedded.messages})`);
            } else {
              consecutiveEmptyBatches++;
              
              // Check if there are failed items waiting for retry
              const { count: failedCount } = await supabase
                .from('cb_message_embeddings')
                .select('*', { count: 'exact', head: true })
                .eq('project_id', projectId)
                .eq('status', 'failed')
                .lt('retry_count', 5);
              
              if ((failedCount || 0) > 0 && consecutiveEmptyBatches < maxEmptyBatches) {
                console.log(`[Auto-Embed] Waiting for ${failedCount} failed messages to be ready for retry...`);
                await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30s
                continue;
              }
              
              messagesDone = msgResult.done || consecutiveEmptyBatches >= maxEmptyBatches;
            }
          }
          
          // 2. Embed files (loop until done) with retry awareness
          let filesDone = false;
          consecutiveEmptyBatches = 0;

          while (!filesDone) {
            const fileResponse = await fetch(`http://localhost:${process.env.PORT || 3001}/api/context/_backfill/embeddings/files`, {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                'Authorization': authToken || ''
              },
              body: JSON.stringify({ projectId, limit: 500 })
            });

            if (!fileResponse.ok) {
              console.warn(`[Auto-Embed] Files backfill returned ${fileResponse.status}, retrying in 15s...`);
              await new Promise(resolve => setTimeout(resolve, 15000));
              continue;
            }
            
            const fileResult = await fileResponse.json() as { inserted: number; done: boolean };

            if (fileResult.inserted > 0) {
              totalEmbedded.files += fileResult.inserted || 0;
              consecutiveEmptyBatches = 0; // Reset counter on success
                console.log(`[Auto-Embed] Files: +${fileResult.inserted} (total: ${totalEmbedded.files})`);
                } else {
              consecutiveEmptyBatches++;

              // Check if there are failed items waiting for retry
              const { count: failedCount } = await supabase
                .from('cb_file_embeddings')
                .select('*', { count: 'exact', head: true })
                .eq('project_id', projectId)
                .eq('status', 'failed')
                .lt('retry_count', 5);
              
              if ((failedCount || 0) > 0 && consecutiveEmptyBatches < maxEmptyBatches) {
                console.log(`[Auto-Embed] Waiting for ${failedCount} failed files to be ready for retry...`);
                await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30s
                continue;
              }

              filesDone = fileResult.done || consecutiveEmptyBatches >= maxEmptyBatches;
            }
          }
          
          // 3. Embed blocks (loop until done) with retry awareness
          let blocksDone = false;
          consecutiveEmptyBatches = 0;

          while (!blocksDone) {
            const blockResponse = await fetch(`http://localhost:${process.env.PORT || 3001}/api/context/_backfill/embeddings/blocks`, {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                'Authorization': authToken || ''
              },
              body: JSON.stringify({ projectId, limit: 500 })
            });

            if (!blockResponse.ok) {
              console.warn(`[Auto-Embed] Blocks backfill returned ${blockResponse.status}, retrying in 15s...`);
              await new Promise(resolve => setTimeout(resolve, 15000));
              continue;
            }

            const blockResult = await blockResponse.json() as { inserted: number; done: boolean };
            
            if (blockResult.inserted > 0) {
              totalEmbedded.blocks += blockResult.inserted;
              consecutiveEmptyBatches = 0; // Reset counter on success
              console.log(`[Auto-Embed] Blocks: +${blockResult.inserted} (total: ${totalEmbedded.blocks})`);
            } else {
              consecutiveEmptyBatches++;
              
              // Check if there are failed items waiting for retry
              const { count: failedCount } = await supabase
                .from('cb_block_embeddings')
                .select('*', { count: 'exact', head: true })
                .eq('project_id', projectId)
                .eq('status', 'failed')
                .lt('retry_count', 5);
              
              if ((failedCount || 0) > 0 && consecutiveEmptyBatches < maxEmptyBatches) {
                console.log(`[Auto-Embed] Waiting for ${failedCount} failed blocks to be ready for retry...`);
                await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds
                continue;
              }
              
              blocksDone = blockResult.done || consecutiveEmptyBatches >= maxEmptyBatches;
            }
          }
          
          // 4. Embed conversations (single batch usually enough) with retry awareness
          let conversationsDone = false;
          consecutiveEmptyBatches = 0;

          while (!conversationsDone) {
          const convResponse = await fetch(`http://localhost:${process.env.PORT || 3001}/api/context/_backfill/embeddings/conversations`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': authToken || ''
            },
            body: JSON.stringify({ projectId, limit: 100 })
          });

          if (!convResponse.ok) {
            console.warn(`[Auto-Embed] Conversations backfill returned ${convResponse.status}, retrying in 15s...`);
            await new Promise(resolve => setTimeout(resolve, 15000));
            continue;
          }

          const convResult = await convResponse.json() as { inserted: number; done: boolean };
          if (convResult.inserted > 0) {
            totalEmbedded.conversations += convResult.inserted || 0;
            consecutiveEmptyBatches = 0; // Reset counter on success
            console.log(`[Auto-Embed] Conversations: +${convResult.inserted} (total: ${totalEmbedded.conversations})`);
          } else {
            consecutiveEmptyBatches++;
            
            // Check if there are failed items waiting for retry
              const { count: failedCount } = await supabase
                .from('cb_conversation_embeddings')
                .select('*', { count: 'exact', head: true })
                .eq('project_id', projectId)
                .eq('status', 'failed')
                .lt('retry_count', 5);
              
              if ((failedCount || 0) > 0 && consecutiveEmptyBatches < maxEmptyBatches) {
                console.log(`[Auto-Embed] Waiting for ${failedCount} failed conversations to be ready for retry...`);
                await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds
                continue;
              }
            conversationsDone = convResult.done || consecutiveEmptyBatches >= maxEmptyBatches;
          }
        }

            if (
              totalEmbedded.messages === 0 &&
              totalEmbedded.files === 0 &&
              totalEmbedded.blocks === 0 &&
              totalEmbedded.conversations === 0
            ) {
              console.log(
                `[Auto-Embed] ℹ️ No new content to embed for ${conversationId || 'project'}`
              );
            } else {
              console.log(
                `[Auto-Embed] ✅ Complete for ${conversationId || 'project'}:`
              );
              console.log(`  Messages: ${totalEmbedded.messages}`);
              console.log(`  Files: ${totalEmbedded.files}`);
              console.log(`  Blocks: ${totalEmbedded.blocks}`);
              console.log(`  Conversations: ${totalEmbedded.conversations}`);
            }
          } catch (error: any) {
            console.error(`[Auto-Embed] Error:`, error.message);
          } finally {
            embeddingSemaphore.release();
          }
        })();
        
        // Return immediately (don't wait for embeddings to finish)
        res.json({ success: true, message: 'Auto-embedding queued' });
      });

    // GET /api/context/_embed-status/:projectId/:conversationId - Check if embeddings are complete
    router.get('/_embed-status/:projectId/:conversationId', async (req, res) => {
      const { projectId, conversationId } = req.params;
      
      try {
        // Count messages
        const { count: totalMessages } = await supabase
          .from('cb_messages')
          .select('*', { count: 'exact', head: true })
          .eq('conversation_id', conversationId);
        
        const { data: messageIds } = await supabase
          .from('cb_messages')
          .select('id')
          .eq('conversation_id', conversationId);
        
        const msgIdArray = (messageIds || []).map(m => m.id);
        
        const { count: embeddedMessages } = msgIdArray.length > 0 
          ? await supabase
              .from('cb_message_embeddings')
              .select('*', { count: 'exact', head: true })
              .in('message_id', msgIdArray)
          : { count: 0 };
        
        // Count files
        const { count: totalFiles } = await supabase
          .from('cb_files')
          .select('*', { count: 'exact', head: true })
          .eq('conversation_id', conversationId);
        
        const { data: fileIds } = await supabase
          .from('cb_files')
          .select('id')
          .eq('conversation_id', conversationId);
        
        const fileIdArray = (fileIds || []).map(f => f.id);
        
        const { count: embeddedFiles } = fileIdArray.length > 0
          ? await supabase
              .from('cb_file_embeddings')
              .select('*', { count: 'exact', head: true })
              .in('cb_file_id', fileIdArray)
          : { count: 0 };
        
        // Count blocks (through messages)
        const { count: totalBlocks } = msgIdArray.length > 0
          ? await supabase
              .from('cb_blocks')
              .select('*', { count: 'exact', head: true })
              .in('message_id', msgIdArray)
          : { count: 0 };
        
        const { data: blockIds } = msgIdArray.length > 0
          ? await supabase
              .from('cb_blocks')
              .select('id')
              .in('message_id', msgIdArray)
          : { data: [] };
        
        const blockIdArray = (blockIds || []).map(b => b.id);
        
        const { count: embeddedBlocks } = blockIdArray.length > 0
          ? await supabase
              .from('block_embeddings')
              .select('*', { count: 'exact', head: true })
              .in('cb_block_id', blockIdArray)
          : { count: 0 };
        
        const total = (totalMessages || 0) + (totalFiles || 0) + (totalBlocks || 0);
        const embedded = (embeddedMessages || 0) + (embeddedFiles || 0) + (embeddedBlocks || 0);
        const isComplete = total > 0 && embedded >= total;
        
        res.json({
          conversationId,
          total,
          embedded,
          percentage: total > 0 ? Math.round((embedded / total) * 100) : 0,
          isComplete,
          breakdown: {
            messages: { total: totalMessages || 0, embedded: embeddedMessages || 0 },
            files: { total: totalFiles || 0, embedded: embeddedFiles || 0 },
            blocks: { total: totalBlocks || 0, embedded: embeddedBlocks || 0 }
          }
        });
        
      } catch (error: any) {
        console.error('[Embed Status] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // GET /api/context/embedding-status - Project-level embedding progress
    router.get('/embedding-status', async (req: Request, res: Response) => {
      const projectId = String(req.query.projectId || '').trim();
      
      if (!projectId) {
        return res.status(400).json({ error: 'projectId required' });
      }
      
      try {
        // Get counts for all content types
        const [messages, files, blocks, conversations, entities] = await Promise.all([
          // Messages
          (async () => {
            const [total, embedded] = await Promise.all([
              supabase.from('cb_messages').select('*', { count: 'exact', head: true }).eq('project_id', projectId).neq('content', ''),
              supabase.from('cb_message_embeddings').select('*', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'success')
            ]);
            return { total: total.count || 0, embedded: embedded.count || 0 };
          })(),
          
          // Files
          (async () => {
            const [total, embedded] = await Promise.all([
              supabase.from('cb_files').select('*', { count: 'exact', head: true }).eq('project_id', projectId),
              supabase.from('cb_file_embeddings').select('*', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'success')
            ]);
            return { total: total.count || 0, embedded: embedded.count || 0 };
          })(),
          
          // Blocks - Use RPC function (more reliable than .in() with large arrays)
          (async () => {
            const [totalResult, embedded] = await Promise.all([
              supabase.rpc('count_blocks_by_project', { p_project_id: projectId }),
              supabase.from('cb_block_embeddings')
                .select('*', { count: 'exact', head: true })
                .eq('project_id', projectId)
                .eq('status', 'success')
            ]);
            
            return { 
              total: Number(totalResult.data) || 0, 
              embedded: embedded.count || 0 
            };
          })(),
          
          // Conversations
          (async () => {
            const [total, embedded] = await Promise.all([
              supabase.from('cb_conversations').select('*', { count: 'exact', head: true }).eq('project_id', projectId),
              supabase.from('cb_conversation_embeddings').select('*', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'success')
            ]);
            return { total: total.count || 0, embedded: embedded.count || 0 };
          })(),

          // Entities
          (async () => {
            const { count } = await supabase
              .from('cb_entities')
              .select('*', { count: 'exact', head: true })
              .eq('project_id', projectId);
            return { total: count || 0 };
          })()
        ]);
        
        const totalItems = messages.total + files.total + blocks.total + conversations.total;
        const embeddedItems = messages.embedded + files.embedded + blocks.embedded + conversations.embedded;
        const isComplete = totalItems > 0 && embeddedItems >= totalItems;
        
        res.json({
          projectId,
          total: totalItems,
          embedded: embeddedItems,
          percentage: totalItems > 0 ? Math.round((embeddedItems / totalItems) * 100) : 0,
          isComplete,
          breakdown: {
            messages,
            files,
            blocks,
            conversations,
            entities
          }
        });
        
      } catch (error: any) {
        console.error('[Embedding Status] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });
  
    // Get context injection history
    router.get('/history/:projectId', async (req, res) => {
      try {
        const { projectId } = req.params;
        const limit = Number(req.query.limit) || 20;
        
        const { data, error } = await supabase
          .from('context_injections')
          .select('*')
          .eq('project_id', projectId)
          .order('created_at', { ascending: false })
          .limit(limit);
        
        if (error) {
          if (error.message.includes('does not exist')) {
            return res.json([]);
          }
          throw error;
        }
        
        res.json(data || []);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });
    
    return router;
  }

// Enhanced formatting function with message excerpts
function formatContextForClaudeWithMessages(
  userMessage: string,
  entities: Entity[],
  conversations: Conversation[],
  messages: RelevantMessage[]
): string {
  let context = "## Relevant Context from Previous Conversations\n\n";
  
  if (entities.length > 0) {
    context += "### Related Entities:\n";
    entities.forEach(e => {
      context += `- ${e.canonical_name} (${e.entity_type})\n`;
    });
    context += "\n";
  }
  
  if (messages.length > 0) {
    context += "### Relevant Message Excerpts:\n";
    const messagesByConv = messages.reduce((acc, msg) => {
      if (!acc[msg.conversation_id]) acc[msg.conversation_id] = [];
      acc[msg.conversation_id].push(msg);
      return acc;
    }, {} as Record<string, RelevantMessage[]>);
    
    Object.entries(messagesByConv).forEach(([convId, msgs]) => {
      const conv = conversations.find(c => c.id === convId);
      if (conv) {
        context += `\n**From conversation on ${new Date(conv.created_at).toLocaleDateString()}:**\n`;
        msgs.slice(0, 2).forEach(msg => {
          context += `- ${msg.sender}: "${msg.text_excerpt}"\n`;
        });
      }
    });
    context += "\n";
  }
  
  context += `### Current Query:\n${userMessage}\n`;
  context += "\n---\n*Context automatically retrieved from your knowledge graph*\n";
  
  return context;
}

// Helper function to extract keywords from user message
function extractKeywords(message: string): { words: string[], phrases: string[] } {
  // Extract quoted phrases first
  const quotedPhrases = [];
  const quotedMatches = message.match(/"([^"]+)"/g) || [];
  for (const match of quotedMatches) {
    quotedPhrases.push(match.replace(/"/g, '').toLowerCase());
  }
  
  // Remove quoted parts from message for word extraction
  let cleanMessage = message;
  for (const quoted of quotedMatches) {
    cleanMessage = cleanMessage.replace(quoted, '');
  }
  
  const stopWords = new Set([
    'the', 'is', 'at', 'which', 'on', 'and', 'a', 'an', 'as', 'are', 'was',
    'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'to',
    'of', 'in', 'for', 'with', 'about', 'what', 'how', 'when', 'where', 'why',
    'who', 'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they', 'it'
  ]);
  
  // Extract individual words/terms only if no phrases were found
  const words = quotedPhrases.length === 0 
    ? cleanMessage.toLowerCase()
        // CRITICAL: Keep dots, hyphens, underscores for file names and technical terms
        .replace(/[^\w\s.-]/g, ' ') // Keep word chars, spaces, dots, hyphens
        .split(/\s+/)
        .filter(word => 
          word.length > 0 && // Not empty
          !stopWords.has(word) && // Not a stop word
          !/^[.-]+$/.test(word) // Not just punctuation
        )
    : [];
  
  return { 
    words: [...new Set(words)], 
    phrases: quotedPhrases 
  };
}

// Helper function to format context for Claude
function formatContextForClaude(
  userMessage: string,
  entities: Entity[],
  conversations: Conversation[]
): string {
  let context = "## Relevant Context from Previous Conversations\n\n";
  
  if (entities.length > 0) {
    context += "### Related Entities:\n";
    entities.forEach(e => {
      context += `- ${e.canonical_name} (${e.entity_type})\n`;
    });
    context += "\n";
  }
  
  if (conversations.length > 0) {
    context += "### Related Past Discussions:\n";
    conversations.forEach((conv, idx) => {
      const date = new Date(conv.created_at).toLocaleDateString();
      context += `\n**Conversation ${idx + 1}** (${date}, ${conv.message_count} messages):\n`;
      context += `${conv.summary || 'No summary available'}\n`;
    });
    context += "\n";
  }
  
  context += `### Current Query:\n${userMessage}\n`;
  context += "\n---\n*Context automatically retrieved from your knowledge graph*\n";
  
  return context;
}

// Helper function to extract messages containing keywords
function extractRelevantMessages(
  conversations: any[],
  words: string[],
  phrases: string[]
): RelevantMessage[] {
  const relevantMessages: RelevantMessage[] = [];
  
  for (const conv of conversations) {
    if (!conv.raw_messages) continue;
    
    let messages = [];
    try {
      messages = typeof conv.raw_messages === 'string' 
        ? JSON.parse(conv.raw_messages) 
        : conv.raw_messages;
    } catch (e) {
      console.error('[Context] Failed to parse raw_messages:', e);
      continue;
    }
    
    messages.forEach((msg: any, index: number) => {
      // Extract message text
      let messageText = '';
      if (msg.content && Array.isArray(msg.content)) {
        messageText = msg.content
          .filter((item: any) => item.type === 'text')
          .map((item: any) => item.text || '')
          .join(' ');
      } else if (msg.text) {
        messageText = msg.text;
      } else if (typeof msg.content === 'string') {
        messageText = msg.content;
      }
      
      const lowerText = messageText.toLowerCase();
      
      // Check for phrase matches
      const hasPhrase = phrases.some(phrase => lowerText.includes(phrase.toLowerCase()));
      
      // Check for word matches (with word boundaries)
      const hasWord = words.some(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'i');
        return regex.test(messageText);
      });
      
      if (hasPhrase || hasWord) {
        // Extract a relevant excerpt around the matched term
        const excerptLength = 200;
        let excerpt = messageText;
        
        // Find the first match position
        let matchPos = -1;
        for (const phrase of phrases) {
          const pos = lowerText.indexOf(phrase.toLowerCase());
          if (pos !== -1) {
            matchPos = pos;
            break;
          }
        }
        
        if (matchPos === -1) {
          for (const word of words) {
            const regex = new RegExp(`\\b${word}\\b`, 'i');
            const match = regex.exec(messageText);
            if (match) {
              matchPos = match.index;
              break;
            }
          }
        }
        
        // Create excerpt centered on match
        if (matchPos !== -1) {
          const start = Math.max(0, matchPos - excerptLength/2);
          const end = Math.min(messageText.length, matchPos + excerptLength/2);
          excerpt = (start > 0 ? '...' : '') + 
                   messageText.substring(start, end) + 
                   (end < messageText.length ? '...' : '');
        } else {
          // Fallback: just take first part of message
          excerpt = messageText.substring(0, excerptLength) + 
                   (messageText.length > excerptLength ? '...' : '');
        }
        
        relevantMessages.push({
          conversation_id: conv.id,
          message_index: index,
          sender: msg.sender || (index % 2 === 0 ? 'human' : 'assistant'),
          text_excerpt: excerpt,
          full_text: messageText.substring(0, 1000) // Limit full text for response size
        });
      }
    });
  }
  
  return relevantMessages;
}

// Helper function to extract context windows around keywords
function extractContextWindows(
  conversations: any[],
  words: string[],
  phrases: string[],
  windowSize: number = 500 // characters before/after match
): RelevantMessage[] {
  const relevantMessages: RelevantMessage[] = [];
  
  // Sort conversations by date (most recent first)
  const sortedConvs = conversations.sort((a, b) => 
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  
  for (const conv of sortedConvs) {
    if (!conv.raw_messages) continue;
    
    let messages = [];
    try {
      messages = typeof conv.raw_messages === 'string' 
        ? JSON.parse(conv.raw_messages) 
        : conv.raw_messages;
    } catch (e) {
      continue;
    }
    
    messages.forEach((msg: any, index: number) => {
      // Extract message text
      let messageText = '';
      if (msg.content && Array.isArray(msg.content)) {
        messageText = msg.content
          .filter((item: any) => item.type === 'text')
          .map((item: any) => item.text || '')
          .join(' ');
      } else if (msg.text) {
        messageText = msg.text;
      } else if (typeof msg.content === 'string') {
        messageText = msg.content;
      }
      
      const lowerText = messageText.toLowerCase();
      
      // Find ALL matches in this message
      const allMatches: {pos: number, term: string, isPhrase: boolean}[] = [];
      
      // Find phrase matches
      for (const phrase of phrases) {
        let searchPos = 0;
        while (true) {
          const pos = lowerText.indexOf(phrase.toLowerCase(), searchPos);
          if (pos === -1) break;
          allMatches.push({pos, term: phrase, isPhrase: true});
          searchPos = pos + phrase.length;
        }
      }
      
      // Find word matches
      for (const word of words) {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        let match;
        while ((match = regex.exec(messageText)) !== null) {
          allMatches.push({pos: match.index, term: word, isPhrase: false});
        }
      }
      
      // For each match, extract a context window
      allMatches.forEach(match => {
        const start = Math.max(0, match.pos - windowSize);
        const end = Math.min(messageText.length, match.pos + match.term.length + windowSize);
        
        // Extend to nearest sentence boundaries if possible
        let contextStart = start;
        let contextEnd = end;
        
        // Look for sentence start
        const prevPeriod = messageText.lastIndexOf('. ', match.pos);
        const prevNewline = messageText.lastIndexOf('\n', match.pos);
        contextStart = Math.max(start, Math.max(prevPeriod + 2, prevNewline + 1));
        
        // Look for sentence end  
        const nextPeriod = messageText.indexOf('. ', match.pos + match.term.length);
        const nextNewline = messageText.indexOf('\n', match.pos + match.term.length);
        if (nextPeriod !== -1 && nextPeriod < end) contextEnd = nextPeriod + 1;
        else if (nextNewline !== -1 && nextNewline < end) contextEnd = nextNewline;
        
        const contextWindow = messageText.substring(contextStart, contextEnd).trim();
        
        // Add context markers if truncated
        const excerpt = 
          (contextStart > 0 ? '...' : '') + 
          contextWindow + 
          (contextEnd < messageText.length ? '...' : '');
        
        relevantMessages.push({
          conversation_id: conv.id,
          message_index: index,
          sender: msg.sender || (index % 2 === 0 ? 'human' : 'assistant'),
          text_excerpt: excerpt,
          full_text: contextWindow,
          match_term: match.term,
          match_type: match.isPhrase ? 'phrase' : 'word',
          conversation_date: conv.created_at,
          conversation_summary: conv.summary
        } as RelevantMessage & {
          match_term: string;
          match_type: string;
          conversation_date: string;
          conversation_summary: string;
        });
      });
    });
  }
  
  // Sort by relevance: phrase matches first, then by recency
  return relevantMessages.sort((a: any, b: any) => {
    if (a.match_type === 'phrase' && b.match_type !== 'phrase') return -1;
    if (b.match_type === 'phrase' && a.match_type !== 'phrase') return 1;
    return new Date(b.conversation_date).getTime() - new Date(a.conversation_date).getTime();
  });
}

// --- Hybrid Search Interfaces & Utilities ---

/**
 * Reciprocal Rank Fusion (RRF)
 * Combines two lists of results into one ranked list.
 * Formula: score = 1 / (k + rank)
 * k is a constant (usually 60) to smooth the impact of high rankings.
 */
function fuseResults(semantic: SearchResult[], keyword: SearchResult[]): SearchResult[] {
  const k = 60;
  const scores = new Map<string, { doc: SearchResult; score: number }>();

  // 1. Process Semantic Results
  semantic.forEach((item, rank) => {
    // Unique key: type + id
    const key = `${item.type}:${item.id}`;
    if (!scores.has(key)) {
      scores.set(key, { doc: item, score: 0 });
    }
    // RRF score accumulation
    scores.get(key)!.score += 1 / (k + rank + 1);
    
    // Tag source (initially semantic)
    scores.get(key)!.doc.source = 'semantic';
  });

  // 2. Process Keyword Results
  keyword.forEach((item, rank) => {
    const key = `${item.type}:${item.id}`;
    if (!scores.has(key)) {
      scores.set(key, { doc: item, score: 0 });
      // If it wasn't in semantic, it's purely keyword
      scores.get(key)!.doc.source = 'keyword';
    } else {
      // If it WAS in semantic, now it's hybrid
      scores.get(key)!.doc.source = 'hybrid';
    }
    scores.get(key)!.score += 1 / (k + rank + 1);
  });

  // 3. Sort by final score DESC
  return Array.from(scores.values())
    .map(({ doc, score }) => ({ ...doc, score }))
    .sort((a, b) => b.score - a.score);
}

// Change signature from string to number[] or any
async function searchBySemantic(
  queryText: string,           // The raw user text (e.g. "function createCodexRoutes")
  queryEmbedding: number[],    // The calculated embedding
  projectId: string, 
  supabase: SupabaseClient,
  resultLimit: number = 25     // Default to 25 for in-browser modal
): Promise<SearchResult[]> {
  
  // Scale fetch limits based on requested results (fetch more to allow RRF fusion)
  const TOP_K_SEMANTIC = Math.min(resultLimit * 2, 200);
  const TOP_K_KEYWORD = Math.min(resultLimit * 2, 200);

  // 1. Parallel Execution: Run Vector Search AND Keyword Search
  const [
    // A. Vector (Semantic) Results
    msgVector, 
    fileVector,
    // B. Keyword (Lexical) Results
    msgKeyword,
    fileKeyword
  ] = await Promise.all([
    // A1. Semantic Messages (Existing LADDER logic replaced by direct call for speed, or keep ladder if preferred. 
    // For Hybrid, a single confident semantic pass is usually better to avoid noise.)
    supabase.rpc('search_messages_by_embedding', {
      query_embedding: queryEmbedding,
      search_project_id: projectId,
      match_count: TOP_K_SEMANTIC,
      match_threshold: 0.30, // Slight threshold to filter garbage
    }),
    // A2. Semantic Files
    supabase.rpc('search_files_by_embedding', {
      query_embedding: queryEmbedding,
      search_project_id: projectId,
      match_count: TOP_K_SEMANTIC,
      match_threshold: 0.30,
    }),

    // B1. Keyword Messages (New RPC)
    supabase.rpc('search_messages_by_keyword', {
      search_project_id: projectId,
      search_query: queryText,
      match_count: TOP_K_KEYWORD
    }),
    // B2. Keyword Files (New RPC)
    supabase.rpc('search_files_by_keyword', {
      search_project_id: projectId,
      search_query: queryText,
      match_count: TOP_K_KEYWORD
    })
  ]);

  // 2. Normalize Results into SearchResult[] objects
  
  // --- Semantic Helpers ---
  const mapSemanticMsg = (m: any): SearchResult => ({
    type: 'message', id: m.message_id, conversation_id: m.conversation_id,
    content: m.content, author_role: m.author_role, created_at: m.created_at,
    score: m.similarity, original_score: m.similarity, source: 'semantic'
  });
  const mapSemanticFile = (f: any): SearchResult => ({
    type: 'file', id: f.file_id, conversation_id: f.conversation_id,
    content: (f.content ?? '').slice(0, 1000), file_name: f.file_name, created_at: f.created_at,
    score: f.similarity, original_score: f.similarity, source: 'semantic'
  });

  // --- Keyword Helpers ---
  const mapKeywordMsg = (m: any): SearchResult => ({
    type: 'message', id: m.message_id, conversation_id: m.conversation_id,
    content: m.content, author_role: m.author_role, created_at: m.created_at,
    score: m.rank, original_score: m.rank, source: 'keyword'
  });
  const mapKeywordFile = (f: any): SearchResult => ({
    type: 'file', id: f.file_id, conversation_id: f.conversation_id,
    content: (f.content ?? '').slice(0, 1000), file_name: f.file_name, created_at: f.created_at,
    score: f.rank, original_score: f.rank, source: 'keyword'
  });

  // 3. Flatten lists
  const semanticList = [
    ...(msgVector.data ?? []).map(mapSemanticMsg),
    ...(fileVector.data ?? []).map(mapSemanticFile)
  ];

  const keywordList = [
    ...(msgKeyword.data ?? []).map(mapKeywordMsg),
    ...(fileKeyword.data ?? []).map(mapKeywordFile)
  ];

  // 4. Fuse Results (RRF)
  const fusedResults = fuseResults(semanticList, keywordList);

  console.log(`[HybridSearch] Semantic: ${semanticList.length}, Keyword: ${keywordList.length} -> Fused: ${fusedResults.length}`);
  
  // Return top 25 most relevant combined results
  return fusedResults.slice(0, resultLimit);
}

async function searchByKeywordsEnhanced(
  keywords: string[], 
  phrases: string[], 
  projectId: string, 
  supabase: SupabaseClient, 
  limit: number = 500
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  
  // If no keywords or phrases, return empty
  if (keywords.length === 0 && phrases.length === 0) {
    return results;
  }
  
  // Combine all search terms
  const allTerms = [...phrases, ...keywords].filter(t => t && t.length > 0);
  
  if (allTerms.length === 0) {
    return results;
  }
  
  // Build case-insensitive ILIKE conditions for each term
  // We'll fetch messages that contain ANY of the terms, then score them
  const conditions = allTerms.map(term => 
    `content.ilike.%${term.replace(/[%_]/g, '\\$&')}%`
  ).join(',');
  
  // Fetch messages that contain at least one term
  const { data: messages, error } = await supabase
    .from('cb_messages')
    .select('*, cb_conversations!inner(project_id)')
    .eq('cb_conversations.project_id', projectId)
    .or(conditions)
    .order('created_at', { ascending: false })
    .limit(limit);
  
  if (error) {
    console.error('[Keyword Search] Error:', error);
    return results;
  }
  
  if (messages) {
    for (const msg of messages) {
      const content = msg.content?.toLowerCase() || '';
      let score = 0;
      let matchedAny = false;
      
      // Score exact phrase matches highest (must contain the EXACT phrase)
      phrases.forEach(phrase => {
        if (content.includes(phrase.toLowerCase())) {
          score += 0.9;
          matchedAny = true;
        }
      });
      
      // Score individual keyword matches
      keywords.forEach(word => {
        const wordLower = word.toLowerCase();
        // Use word boundary matching for standalone words
        const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escapedWord}\\b`, 'i').test(content)) {
          score += 0.6;
          matchedAny = true;
        }
      });
      
      // CRITICAL: Only include if it actually matched a term
      if (matchedAny && score > 0) {
        results.push({
          type: 'message',
          id: msg.id,
          conversation_id: msg.conversation_id,
          content: msg.content,
          author_role: msg.author_role,
          score: Math.min(score, 1),
          source: 'keyword',
          created_at: msg.created_at
        });
      }
    }
  }
  
  console.log(`[Keyword Search] Found ${results.length} matches for terms:`, allTerms);
  
  return results;
}

function combineAndRankResults(
  semantic: SearchResult[],
  keyword: SearchResult[],
  entity:   SearchResult[] = []
): SearchResult[] {
  const resultMap = new Map<string, SearchResult & { 
    sources: Set<string>, 
    conversation_match_count?: number,
    other_matches?: number 
  }>();
  
  // Normalize all scores to 0-100 scale BEFORE applying weights
  const { semantic: wSemantic, keyword: wKeyword, entity: wEntity } = SEARCH_CONFIG.weights;

  // Per-source max normalization: equalizes RRF scores (~0.016) vs entity scores (~0.45)
  // before applying weights, so no single source dominates due to raw scale differences.
  const maxSemantic = semantic.length ? Math.max(...semantic.map(r => r.score)) : 1;
  const maxKeyword  = keyword.length  ? Math.max(...keyword.map(r => r.score))  : 1;
  const maxEntity   = entity.length   ? Math.max(...entity.map(r => r.score))   : 1;

  const normalizedSemantic = semantic.map(r => ({
    ...r,
    normalized_score: (r.score / maxSemantic) * 100,
    final_score: (r.score / maxSemantic) * 100 * wSemantic
  }));

  const normalizedKeyword = keyword.map(r => ({
    ...r,
    normalized_score: (r.score / maxKeyword) * 100,
    final_score: (r.score / maxKeyword) * 100 * wKeyword
  }));

  const normalizedEntity = entity.map(r => ({
    ...r,
    normalized_score: (r.score / maxEntity) * 100,
    final_score: (r.score / maxEntity) * 100 * wEntity
  }));
  
  console.log('[Context] Sample normalized scores:', {
    semantic: normalizedSemantic[0]?.final_score?.toFixed(1),
    keyword: normalizedKeyword[0]?.final_score?.toFixed(1),
    entity: normalizedEntity[0]?.final_score?.toFixed(1)
  });
  
  // Merge results
  [...normalizedSemantic, ...normalizedKeyword, ...normalizedEntity].forEach(result => {
    const key = `${result.type}-${result.id}`;
    const existing = resultMap.get(key);
    
    if (!existing) {
      resultMap.set(key, {
        ...result,
        score: result.final_score,
        sources: new Set([result.source])
      });
    } else {
      // Combine scores from different sources (don't double-weight)
      // Additive: a result found by both semantic AND entity gets a compound bonus
      existing.score += result.final_score;
      existing.sources.add(result.source);
    }
  });
  
  const allResults = Array.from(resultMap.values());
  
  // Add conversation grouping metadata (Option B)
  const conversationGroups = new Map<string, typeof allResults>();
  allResults.forEach(result => {
    const convId = result.conversation_id;
    if (!conversationGroups.has(convId)) {
      conversationGroups.set(convId, []);
    }
    conversationGroups.get(convId)!.push(result);
  });
  
  // Enhance results with conversation match metadata
  const enhancedResults = allResults.map(result => {
    const convMatches = conversationGroups.get(result.conversation_id) || [];
    const sourcesArray = Array.from(result.sources || []);
    return {
      ...result,
      conversation_match_count: convMatches.length,
      other_matches: convMatches.length - 1,
      combined_conversation_score: convMatches.reduce((sum, m) => sum + m.score, 0)
    };
  });
  
  // Sort by final score
  return enhancedResults.sort((a, b) => b.score - a.score);
}

function groupResultsByConversation(results: SearchResult[], conversations: any[]) {
  const groups = new Map();
  
  // Helper to get first line of text
  const firstLine = (s: string) => String(s || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
  
  results.forEach(result => {
    if (!groups.has(result.conversation_id)) {
      const conv = conversations.find(c => c.id === result.conversation_id);
      
      // Try multiple sources for title
      const title = conv?.title 
        || conv?.summary 
        || firstLine(result.content)
        || 'Untitled';
      
      groups.set(result.conversation_id, {
        conversation_id: result.conversation_id,
        title: title,
        created_at: conv?.started_at,
        items: [],
        maxScore: 0
      });
    }
    
    const group = groups.get(result.conversation_id);
    group.items.push(result);
    group.maxScore = Math.max(group.maxScore, result.score);
  });
  
  return Array.from(groups.values()).sort((a, b) => b.maxScore - a.maxScore);
}

function createEnhancedPreview(groups: any[], maxTokens: number): string {
  let preview = "## Relevant Context from Project Knowledge Graph\n\n";
  let tokens = 50;
  
  for (const group of groups) {
    if (tokens >= maxTokens * 0.9) break;
    
    preview += `### ${group.title}\n`;
    tokens += 20;
    
    for (const item of group.items.slice(0, 3)) {
      const excerpt = item.content.substring(0, 200);
      tokens += Math.ceil(excerpt.length / 4);
      if (tokens >= maxTokens) break;
      
      preview += `- ${item.author_role || item.type}: "${excerpt}..."\n`;
    }
    preview += "\n";
  }
  
  return preview;
}