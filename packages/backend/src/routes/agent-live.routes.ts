// packages/backend/src/routes/agent-live.routes.ts
import { Router, Request, Response } from 'express';
import type { ContextPack } from '../agent/agent-dsl.types';
import { parseOperators, splitSubquestions } from '../agent/intent-parser.service';
import { getIntentParser } from '../services/intent-parser.service';
import { getPlanExecutor, SearchItem } from '../services/plan-executor.service';
import type { AgentPlan } from '../types/agent-dsl.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ContextPackExecutor } from '../agent/plan-executor.service';
import { FileContentFetcher } from '../agent/content-fetcher';
import { SupabaseRetriever, toTieredResponse } from '../agent/supabase-retriever.js';

export function createAgentLiveRoutes(supabase: SupabaseClient) {
  const router = Router();

  // Helper to search Codex directly (using vector embeddings)
  async function searchCodexForPack(projectId: string, query: string, limit = 5) {
    console.log(`[Codex] Searching project=${projectId} query="${query}" limit=${limit}`);
    try {
      // Generate embedding for the query
      const { getEmbeddingService } = await import('../services/embedding.service.js');
      const embeddingService = getEmbeddingService();
      const { embedding } = await embeddingService.generateEmbedding(query);
      const queryVecText = `[${embedding.join(',')}]`;

      // Use vector search
      const identifierTokens = query.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [];
      const strongIdentifier =
        identifierTokens.find(t =>
          /[a-z][A-Z]/.test(t) ||
          /^cb_[a-z0-9_]+$/i.test(t)
        ) || query;

      const { data, error } = await supabase.rpc('cb_search_codex_vectors', {
        p_project_id: projectId,
        p_query_vec: queryVecText,
        p_limit: limit,
        p_query_text: strongIdentifier,
      });

      if (error) {
        console.warn(`[Codex] Error searching project ${projectId}:`, error);
        return [];
      }

      console.log(`[Codex] Found ${data?.length || 0} results:`, data?.map((r: any) => r.file_path));

      return (data || []).map((row: any) => ({
        path: row.file_path,
        snippet: ((row.snippet as string) || '').replace(/\r\n/g, '\n'),
        startLine: row.start_line,
        endLine: row.end_line,
        score: row.similarity || 0.85,
        project_id: projectId
      }));
    } catch (e) {
      console.warn(`[Codex] Exception searching project ${projectId}:`, e);
      return [];
    }
  }

  /**
   * POST /api/agent/query
   * Natural language query against real ContextBridge data
   * This is the main endpoint that the Chrome extension will use
   */
  router.post('/agent/query', async (req: Request, res: Response) => {
    try {
      const {
        instruction,
        projectId,
        budgetTokens = 2000,
        limit = 20
      } = req.body;

      if (!instruction || !projectId) {
        return res.status(400).json({ error: 'instruction and projectId are required' });
      }

      console.log(`\n🔍 Agent query: "${instruction}" for project ${projectId}`);
      const startTime = Date.now();

      // Step 1: Parse instruction into AgentPlan
      console.log('📝 Step 1: Parsing instruction...');
      const parser = getIntentParser();
      
      const parseResult = await parser.parseInstruction(instruction, {
        projectId,
        budgetTokens
      });

      if (!parseResult.success || !parseResult.plan) {
        return res.status(400).json({
          success: false,
          error: parseResult.error || 'Failed to parse instruction',
          step: 'parse'
        });
      }

      const parseTime = Date.now() - startTime;
      console.log(`  ✅ Parsed in ${parseTime}ms (source: ${parseResult.source})`);
      
      // Step 2: Execute search using the parsed query
        console.log('🔎 Step 2: Searching ContextBridge...');

        const searchQuery = parseResult.plan.search?.query?.trim() || instruction;
        const cappedLimit = Math.min(Math.max(parseResult.plan.search?.limit ?? limit, 1), 50);

        // Ensure we have a non-empty query for analyze-v2
        let effectiveQuery = searchQuery;
        if (!effectiveQuery || !effectiveQuery.trim()) {
          const compact = String(instruction)
            .replace(/[^\w./-]+/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !/\b(the|and|for|with|this|that|into|from|have|need|please|help|find|show|code|files?)\b/i.test(w))
            .slice(0, 24)
            .join(' ');
          effectiveQuery = compact || 'contextbridge search';
        }

        // Build base URL (same host/port), avoid double slashes
        const base = `${req.protocol}://${req.get('host')}`;
        const searchUrl = `${base}/api/context/analyze-v2`;

        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 15000); // 15s guard

        // Call analyze-v2 which now returns { results: [], codex: [] }
        const searchResponse = await fetch(searchUrl, {
          method: 'POST',
          signal: ac.signal,
          headers: { 
            'Content-Type': 'application/json', 
            'Accept': 'application/json',
            'Authorization': req.headers['authorization'] || ''
          },
          body: JSON.stringify({
            message: effectiveQuery,
            projectId,
            limit: cappedLimit
          })
        }).catch(err => {
        throw new Error(`Analyze-v2 fetch failed: ${err?.message || err}`);
        });
        clearTimeout(t);

        if (!searchResponse.ok) {
        const errorText = await searchResponse.text().catch(() => '');
        return res.status(502).json({
            success: false,
            error: 'Search failed',
            detail: errorText,
            step: 'search'
        });
      }

      const searchData = await searchResponse.json() as { results?: any[]; codex?: any[] };
      const searchTime = Date.now() - startTime - parseTime;
      console.log(`  ✅ Search completed in ${searchTime}ms`);

      // Step 3: Convert search results to SearchItem[] and itemsMeta[],
      // extract filename hints, relax filters on zero results, and perform per-filename fallback.

      // --- Helpers ---
      const filenameRegex = /(?:(?:^|[\s"'`>]))([A-Za-z0-9_\-\/.]*?(?:[A-Za-z0-9_\-]+)\.(?:ts|tsx|js|jsx|mjs|cjs|json|html|css|md|py|go|rb|rs|java|cs|cpp|c|sql|yml|yaml))/gi;
      function extractFilenames(text: string): string[] {
        const set = new Set<string>();
        let m;
        while ((m = filenameRegex.exec(text)) !== null) {
          const v = (m[1] || '').trim();
          if (v) set.add(v.toLowerCase());
        }
        return Array.from(set);
      }
      function basename(p: string) {
        const s = p.replace(/\\/g, '/');
        const i = s.lastIndexOf('/');
        return (i >= 0 ? s.slice(i + 1) : s) || s;
      }
      function extname(p: string) {
        const b = basename(p);
        const i = b.lastIndexOf('.');
        return i >= 0 ? b.slice(i).toLowerCase() : '';
      }
      function pickLatestByBasename<T extends { title?: string; created_at?: string }>(items: T[]) {
        const groups = new Map<string, T[]>();
        for (const it of items) {
          const b = basename(it.title || '');
          if (!groups.has(b)) groups.set(b, []);
          groups.get(b)!.push(it);
        }
        const out: T[] = [];
        for (const arr of groups.values()) {
          arr.sort((a, b) => (Date.parse(b.created_at || '') || 0) - (Date.parse(a.created_at || '') || 0));
          out.push(arr[0]);
        }
        return out;
      }

      function extractFunctionNames(text: string): string[] {
        const set = new Set<string>();
        
        // Pattern 1: "the functionName function" or "functionName() function"
        const pattern1 = /(?:the\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(\))?\s+(?:function|method)/gi;
        let m1;
        while ((m1 = pattern1.exec(text)) !== null) {
          const name = m1[1]?.trim();
          if (name && name.length >= 3) set.add(name);
        }
        
        // Pattern 2: "for the functionName function"
        const pattern2 = /for\s+the\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+function/gi;
        let m2;
        while ((m2 = pattern2.exec(text)) !== null) {
          const name = m2[1]?.trim();
          if (name && name.length >= 3) set.add(name);
        }
        
        // Pattern 3: "search/find/get/show functionName"
        const pattern3 = /(?:search|find|get|show|extract)\s+(?:your\s+)?(?:the\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s+function/gi;
        let m3;
        while ((m3 = pattern3.exec(text)) !== null) {
          const name = m3[1]?.trim();
          if (name && name.length >= 3) set.add(name);
        }
        
        return Array.from(set);
      }

      function extractFunction(content: string, functionName: string): string | null {
        if (!content || !functionName) return null;
        
        // Escape function name for regex
        const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        
        // Try multiple function declaration patterns (with DOTALL flag via [\s\S])
        const patterns = [
          // async function name(...) { ... } - multi-line safe
          new RegExp(`(async\\s+)?function\\s+${escapedName}\\s*\\([\\s\\S]*?\\)\\s*[:\\s\\S]*?\\{`, 'i'),
          // const name = async (...) => { ... }
          new RegExp(`const\\s+${escapedName}\\s*=\\s*(async\\s+)?\\([\\s\\S]*?\\)\\s*=>\\s*\\{`, 'i'),
          // name(...) { ... } (method in class/object)
          new RegExp(`${escapedName}\\s*\\([\\s\\S]*?\\)\\s*\\{`, 'i'),
          // async name(...) { ... }
          new RegExp(`async\\s+${escapedName}\\s*\\([\\s\\S]*?\\)\\s*[:\\s\\S]*?\\{`, 'i')
        ];
        
        for (const pattern of patterns) {
          const match = pattern.exec(content);
          if (!match) continue;
          
          const startIndex = match.index;
          const matchedText = match[0];
          const openBraceIndex = startIndex + matchedText.lastIndexOf('{');
          
          if (openBraceIndex === -1) continue;
          
          // Find matching closing brace with proper nesting
          let braceCount = 0;
          let endIndex = openBraceIndex;
          let inString = false;
          let inComment: boolean | 'line' | 'block' = false;
          let stringChar = '';
          
          for (let i = openBraceIndex; i < content.length; i++) {
            const char = content[i];
            const nextChar = content[i + 1];
            
            // Handle strings (skip braces inside strings)
            if (!inComment && (char === '"' || char === "'" || char === '`')) {
              if (!inString) {
                inString = true;
                stringChar = char;
              } else if (char === stringChar && content[i - 1] !== '\\') {
                inString = false;
              }
            }
            
            // Handle comments
            if (!inString) {
              if (char === '/' && nextChar === '/') {
                inComment = 'line';
              } else if (char === '/' && nextChar === '*') {
                inComment = 'block';
              } else if (inComment === 'line' && char === '\n') {
                inComment = false;
              } else if (inComment === 'block' && char === '*' && nextChar === '/') {
                inComment = false;
                i++; // Skip the '/'
                continue;
              }
            }
            
            // Count braces (only if not in string or comment)
            if (!inString && !inComment) {
              if (char === '{') braceCount++;
              if (char === '}') {
                braceCount--;
                if (braceCount === 0) {
                  endIndex = i + 1;
                  break;
                }
              }
            }
          }
          
          if (braceCount === 0 && endIndex > openBraceIndex) {
            // Extract from start of function declaration to closing brace
            return content.substring(startIndex, endIndex).trim();
          }
        }
        
        return null;
      }

      async function fetchFullFileContent(
        conversationId: string, 
        filename: string
      ): Promise<string | null> {
        try {
          console.log(`    → Querying: conversation_id=${conversationId}, file_name=${filename}`);
          
          const { data, error } = await supabase
            .from('cb_files')
            .select('content')
            .eq('conversation_id', conversationId)
            .eq('file_name', filename)
            .order('created_at', { ascending: false })
            .limit(1);
          
          if (error || !data || data.length === 0) {
            console.warn(`    ⚠️  Could not fetch full file: ${error?.message || 'not found'}`);
            return null;
          }
          
          return data[0].content;
        } catch (err) {
          console.warn(`    ⚠️  Error fetching file: ${err}`);
          return null;
        }
      }

      interface SynthesisDecision {
        shouldSynthesize: boolean;
        confidence: number;
        reason: string;
        source: 'hard_rule' | 'plan' | 'llm';
      }

      function quickDetection(instruction: string, plan: AgentPlan): SynthesisDecision | null {
        const lower = instruction.toLowerCase();
        
        // DEFINITE NO: Explicit "show me the X" or "share the X" (content requests)
        if (/\b(show me the|share the|give me the|paste the|get the)\s+(complete|full|entire|whole)?\s*(file|function|code|content)/i.test(instruction)) {
          return {
            shouldSynthesize: false,
            confidence: 0.95,
            reason: 'Explicit content/code request',
            source: 'hard_rule'
          };
        }
        
        // DEFINITE NO: Explicit insertion/paste requests
        if (
          /\b(insert|paste|add|inject)\b/i.test(instruction) ||
          (plan.action?.type === 'auto_insert' && plan.confidence && plan.confidence >= 0.75)
        ) {
          return {
            shouldSynthesize: false,
            confidence: 0.95,
            reason: 'Explicit insertion/paste request',
            source: 'hard_rule'
          };
        }
        
        // DEFINITE NO: File enumeration ("find files", "get files", etc.)
        if (/\b(find|get|locate|show|list)\s+(the\s+)?(files?|documents?)\b/i.test(instruction)) {
          return {
            shouldSynthesize: false,
            confidence: 0.9,
            reason: 'File enumeration request',
            source: 'hard_rule'
          };
        }
        
        // DEFINITE NO: Listing/enumeration requests with specific items
        if (/\b(list|show me all|find all|give me|get me)\s+(the\s+)?(files?|functions?|examples?|snippets?)\b/i.test(instruction)) {
          return {
            shouldSynthesize: false,
            confidence: 0.8,
            reason: 'Enumeration/listing request',
            source: 'hard_rule'
          };
        }
        
        // DEFINITE YES: Questions ending with "?"
        if (instruction.trim().endsWith('?')) {
          return {
            shouldSynthesize: true,
            confidence: 0.95,
            reason: 'Question mark indicates inquiry',
            source: 'hard_rule'
          };
        }
        
        // DEFINITE YES: Questions starting with question words (but NOT "can you find/show")
        if (/^(what|how|why|when|where|who|which|should|would|do|does|is|are)\b/i.test(instruction)) {
          // Exception: "Can you find/show" is a polite request, not a question
          if (!/^can you (find|get|show|locate|search)/i.test(instruction)) {
            return {
              shouldSynthesize: true,
              confidence: 0.9,
              reason: 'Question word at start',
              source: 'hard_rule'
            };
          }
        }
        
        // DEFINITE YES: Inquiry verbs (but not with "show me the X")
        if (/\b(explain|describe|tell me about|clarify|determine|identify|check whether|verify|compare)\b/i.test(instruction)) {
          return {
            shouldSynthesize: true,
            confidence: 0.85,
            reason: 'Inquiry verb detected',
            source: 'hard_rule'
          };
        }
        
        // Inconclusive
        return null;
      }

      function planBasedDetection(plan: AgentPlan, instruction: string): SynthesisDecision | null {
        // If plan has high confidence and clear intent, trust it
        if (plan.confidence && plan.confidence >= 0.8) {
          // Search intent with no insertion = likely Q&A
          if (plan.intent === 'search' && plan.action?.type !== 'auto_insert') {
            return {
              shouldSynthesize: true,
              confidence: 0.7,
              reason: 'High-confidence search intent without insertion',
              source: 'plan'
            };
          }
          
          // Insert/show_preview with specific files = not Q&A
          if (
            (plan.intent === 'insert' || plan.intent === 'search_and_insert') &&
            plan.action?.type === 'auto_insert'
          ) {
            return {
              shouldSynthesize: false,
              confidence: 0.75,
              reason: 'Insert intent with auto-insert action',
              source: 'plan'
            };
          }
        }
        
        // Still unclear
        return null;
      }

      async function llmTieBreaker(instruction: string): Promise<SynthesisDecision> {
        try {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-opus-4-1-20250805',
              max_tokens: 100,
              temperature: 0,
              messages: [{
                role: 'user',
                content: `Is this a question that needs a synthesized answer, or a request to find/paste specific content?

      Instruction: "${instruction}"

      Respond ONLY with valid JSON:
      {"is_question": true/false, "confidence": 0.0-1.0, "reason": "brief explanation"}`
              }]
            })
          });
          
          const data = await response.json() as { content?: Array<{ text?: string }> };
          const text = data.content?.[0]?.text || '{}';
          const parsed = JSON.parse(text.replace(/```json|```/g, ''));
          
          return {
            shouldSynthesize: parsed.is_question,
            confidence: parsed.confidence || 0.5,
            reason: parsed.reason || 'LLM classification',
            source: 'llm'
          };
        } catch (err) {
          console.warn('  ⚠️  LLM tie-breaker failed:', err);
          // Conservative fallback: don't synthesize if unsure
          return {
            shouldSynthesize: false,
            confidence: 0.5,
            reason: 'LLM tie-breaker failed, defaulting to no synthesis',
            source: 'llm'
          };
        }
      }

      async function decideSynthesis(
        instruction: string,
        plan: AgentPlan
      ): Promise<SynthesisDecision> {
        // Step 1: Quick hard rules
        const hardRule = quickDetection(instruction, plan);
        if (hardRule && hardRule.confidence >= 0.8) {
          console.log(`  🎯 Synthesis decision: ${hardRule.shouldSynthesize} (${hardRule.source}, confidence: ${hardRule.confidence})`);
          console.log(`     Reason: ${hardRule.reason}`);
          return hardRule;
        }
        
        // Step 2: Plan-based inference
        const planBased = planBasedDetection(plan, instruction);
        if (planBased && planBased.confidence >= 0.7) {
          console.log(`  🎯 Synthesis decision: ${planBased.shouldSynthesize} (${planBased.source}, confidence: ${planBased.confidence})`);
          console.log(`     Reason: ${planBased.reason}`);
          return planBased;
        }
        
        // Step 3: LLM tie-breaker (only if still ambiguous)
        console.log(`  🤔 Ambiguous case, using LLM tie-breaker...`);
        const llmDecision = await llmTieBreaker(instruction);
        console.log(`  🎯 Synthesis decision: ${llmDecision.shouldSynthesize} (${llmDecision.source}, confidence: ${llmDecision.confidence})`);
        console.log(`     Reason: ${llmDecision.reason}`);
        return llmDecision;
      }

      async function introspectDatabase(instruction: string, supabase: SupabaseClient): Promise<string | null> {
        const lower = instruction.toLowerCase();
        
        // Detect schema questions
        const isSchemaQuestion = 
          /\b(table|column|schema|database|field|primary key|foreign key|uuid|serial|integer|type)\b/i.test(instruction) ||
          /\b(what (are|is) (our|the|my)|show me (the|our)|list (all|the))\s+(table|column|field)/i.test(instruction);
        
        if (!isSchemaQuestion) return null;
        
        console.log(`  🔍 Schema question detected, introspecting database...`);
        
        try {
          // Call the optimized RPC function
          const { data: schemaData, error } = await supabase.rpc('get_table_schemas', {
            table_pattern: 'cb_%'
          });
          
          if (error) {
            console.warn(`  ⚠️  Database introspection failed:`, error.message);
            return null;
          }
          
          if (!schemaData || schemaData.length === 0) {
            return "No tables found in database.";
          }
          
          // Format the JSONB response into readable text
          const schemaInfo = schemaData
            .map((table: any) => {
              const tableName = table.table_name;
              const columns = table.column_info || [];
              
              const columnDesc = columns.map((col: any) => {
                let desc = `${col.column_name} (${col.data_type}`;
                
                // Highlight UUID generation
                if (col.column_default?.includes('uuid_generate') || col.column_default?.includes('gen_random_uuid')) {
                  desc += ', **UUID default**';
                }
                
                // Highlight serial/sequence
                if (col.column_default?.includes('nextval')) {
                  desc += ', **serial**';
                }
                
                // Mark primary keys
                if (col.is_primary_key) {
                  desc += ', **PRIMARY KEY**';
                }
                
                desc += ')';
                return desc;
              }).join('\n  - ');
              
              return `**Table: ${tableName}**\n  - ${columnDesc}`;
            })
            .join('\n\n');
          
          console.log(`  ✓ Retrieved schema for ${schemaData.length} tables`);
          return `\n--- DATABASE SCHEMA ---\n${schemaInfo}\n--- END SCHEMA ---\n`;
          
        } catch (err: any) {
          console.warn(`  ⚠️  Database introspection error:`, err?.message || err);
          return null;
        }
      }

      function formatSourceCitations(selectedItems: any[]): string {
        if (!selectedItems || selectedItems.length === 0) return '';
        
        // Helper to build URL based on provider
        function buildProviderUrl(conversationId: string, provider: string | null): string | null {
          if (!conversationId || !provider) return null;
          
          const providerLower = provider.toLowerCase();
          switch (providerLower) {
            case 'openai':
            case 'chatgpt':
              return `https://chat.openai.com/c/${conversationId}`;
            case 'gemini':
            case 'google':
              return `https://gemini.google.com/app/${conversationId}`;
            case 'grok':
            case 'x':
              return `https://x.com/i/grok?conversation=${conversationId}`;
            case 'claude':
            case 'anthropic':
              return `https://claude.ai/chat/${conversationId}`;
            default:
              return null;
          }
        }
        
        const citations = selectedItems
          .slice(0, 5) // Limit to top 5 sources
          .map((item, idx) => {
            const num = idx + 1;
            const title = item.title || 'Untitled';
            const kind = item.kind || 'item';
            
            // Try to construct a link if we have conversation_id and provider
            let link = '';
            const convId = item.source?.conversation_id || item.conversationId;
            const provider = item.source?.provider || item.provider;
            const url = buildProviderUrl(convId, provider);
            if (url) {
              link = ` ([view conversation](${url}))`;
            }
            
            return `${num}. **${title}** [${kind}]${link}`;
          })
          .join('\n');
        
        return `\n\n---\n\n**Sources:**\n${citations}`;
      }

      function generateCacheKey(question: string, searchResults: string): string {
        // Create a hash from question + truncated search results
        // We use search results to ensure same question with different context gets different cache
        const content = question.toLowerCase().trim() + '||' + searchResults.slice(0, 5000);
        
        // Simple hash function (you could use crypto.createHash for production)
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
          const char = content.charCodeAt(i);
          hash = ((hash << 5) - hash) + char;
          hash = hash & hash; // Convert to 32bit integer
        }
        
        return `syn_${Math.abs(hash).toString(36)}`;
      }

      async function getCachedAnswer(
        cacheKey: string,
        supabase: SupabaseClient
      ): Promise<string | null> {
        try {
          const { data, error } = await supabase
            .from('cb_synthesis_cache')
            .select('synthesized_answer, access_count')
            .eq('cache_key', cacheKey)
            .single();
          
          if (error || !data) return null;
          
          // Update access count and timestamp
          await supabase
            .from('cb_synthesis_cache')
            .update({
              accessed_at: new Date().toISOString(),
              access_count: data.access_count + 1
            })
            .eq('cache_key', cacheKey);
          
          console.log(`  💾 Cache HIT: ${cacheKey} (accessed ${data.access_count + 1} times)`);
          return data.synthesized_answer;
        } catch (err) {
          console.warn(`  ⚠️  Cache lookup error:`, err);
          return null;
        }
      }

      async function setCachedAnswer(
        cacheKey: string,
        question: string,
        answer: string,
        sourceCount: number,
        supabase: SupabaseClient
      ): Promise<void> {
        try {
          await supabase
            .from('cb_synthesis_cache')
            .upsert({
              cache_key: cacheKey,
              question,
              synthesized_answer: answer,
              source_count: sourceCount,
              accessed_at: new Date().toISOString(),
              access_count: 1
            });
          
          console.log(`  💾 Cached answer: ${cacheKey}`);
        } catch (err) {
          console.warn(`  ⚠️  Cache save error:`, err);
        }
      }
      
      function toSearchItems(results: any[]): SearchItem[] {
        const out: SearchItem[] = [];
        const fallbackId = (() => {
          try { return (globalThis as any).crypto?.randomUUID?.bind((globalThis as any).crypto); } catch { return null; }
        })();
        let uidCounter = 0;
        const nextId = () => (fallbackId ? fallbackId() : `tmp_${Date.now()}_${uidCounter++}`);

        for (const conv of results) {
          const convTitle = conv.title || conv.conversation_title || conv.summary || 'Untitled';
          const convId = conv.conversation_id || conv.id || '';
          const itemsArr = Array.isArray(conv.items) ? conv.items : [];
          
          for (const item of itemsArr) {
            const id = item.id || nextId();
            const kind = (item.kind || item.type || 'message') as SearchItem['kind'];
            
            // Extract filename for files
            const title = (() => {
              // For files, try multiple ways to get the filename
              if (kind === 'file' || item.type === 'file') {
                // Try various fields where filename might be stored
                if (item.file_name) return item.file_name;
                if (item.filename) return item.filename;
                if (item.name) return item.name;
                if (item.path) return basename(item.path);
                
                // Fallback: Extract from first line of content
                // Example: "// src/background.js" or "// background.js"
                const content = item.content || '';
                const firstLine = content.split('\n')[0] || '';
                
                // Match comment-style filename declarations
                const match = firstLine.match(/(?:\/\/|#|\/\*)\s*([A-Za-z0-9_\-\/\\]+\.[a-z]{1,5})/i);
                if (match) {
                  const path = match[1];
                  return path.split(/[\/\\]/).pop() || path;
                }
                
                // Last resort: look for any filename pattern in first 200 chars
                const match2 = content.slice(0, 200).match(/([A-Za-z0-9_\-]+\.[a-z]{1,5})/i);
                if (match2) return match2[1];
              }
              
              // For non-files or if extraction failed, use title or conversation title
              return item.title || item.path || convTitle;
            })();
            
            const content = item.content || item.pasteText || item.text || '';
            const score = item.score ?? item.scores?.overall ?? 0;
            
            out.push({
              id,
              kind: ['message', 'file', 'block'].includes(kind) ? (kind as any) : 'message',
              title,
              content,
              score,
              created_at: item.created_at || conv.created_at,
              conversation_id: convId,
              source: {
                conversation_id: convId,
                message_id: item.id,
                file_id: item.file_id,
                block_id: item.block_id
              }
            });
          }
        }
        return out;
      }
      
      // 3a) Convert first pass (Conversations)
      const rawResults = Array.isArray(searchData?.results) ? searchData.results : [];
      let searchItems: SearchItem[] = toSearchItems(rawResults);

      // 3b) Convert Codex results
      if (Array.isArray(searchData.codex) && searchData.codex.length > 0) {
        console.log(`  💻 Adding ${searchData.codex.length} Codex results to Agent context`);
        const codexItems: SearchItem[] = searchData.codex.map((c: any) => ({
          id: c.chunkId || `codex-${Math.random().toString(36).substr(2, 9)}`,
          kind: 'block', // Treat code snippets as blocks for the agent
          title: `${c.filePath} (L${c.startLine}-${c.endLine})`,
          content: c.snippet,
          score: 0.85, // High default score for direct code matches
          created_at: c.createdAt,
          source: { file_id: c.sourceId, block_id: c.chunkId }
        }));
        searchItems.push(...codexItems);
      }
      // filename hints from instruction and from the plan if present
      const requestedFilenames = new Set<string>([
        ...extractFilenames(instruction),
        ...extractFilenames(parseResult.plan?.search?.query || '')
      ]);

      let searchItemsFiltered = searchItems;

      // function name hints from instruction
      const requestedFunctions = extractFunctionNames(instruction);

      // Build local filters from the plan (do NOT mutate the plan)
      let ctFilter: Array<'message' | 'file' | 'block'> | undefined =
        Array.isArray(parseResult.plan?.search?.filters?.contentTypes)
          ? (parseResult.plan!.search!.filters!.contentTypes as Array<'message'|'file'|'block'>)
          : undefined;

      let ftFilter: string[] | undefined =
        Array.isArray(parseResult.plan?.search?.filters?.fileTypes)
          ? (parseResult.plan!.search!.filters!.fileTypes as string[])
          : undefined;

      const applyFilters = (items: SearchItem[]) => {
        let out = items;
        if (ctFilter?.length) {
          const keep = new Set(ctFilter.map(s => s.toLowerCase()));
          const before = out.length;
          out = out.filter(it => keep.has(it.kind));
          console.log(`  🎯 Applied contentTypes filter: ${before} → ${out.length}`);
        }
        if (ftFilter?.length) {
          const keep = new Set(ftFilter.map(s => s.toLowerCase()));
          const before = out.length;
          out = out.filter(it => keep.has(extname(it.title)));
          console.log(`  🎯 Applied fileTypes filter: ${before} → ${out.length}`);
        }
        return out;
      };

      let filtered = applyFilters(searchItems);

      // Relaxation strategy: peel back fileTypes first, then contentTypes, without touching the plan object.
      if (filtered.length === 0 && ftFilter?.length) {
        console.log('  🔁 Relaxing fileTypes filter (none matched)…');
        ftFilter = undefined;
        filtered = applyFilters(searchItems);
      }
      if (filtered.length === 0 && ctFilter?.length) {
        console.log('  🔁 Relaxing contentTypes filter (none matched)…');
        ctFilter = undefined;
        filtered = applyFilters(searchItems);
      }

      // 3b) If filenames explicitly requested, prioritize them and pick latest versions.
      function prioritizeRequestedFilenames(items: SearchItem[], reqNames: Set<string>) {
        if (!reqNames.size) return items;
        const names = Array.from(reqNames).map(n => basename(n).toLowerCase());
        const nameSet = new Set(names);
        const hits = items.filter(it => nameSet.has(basename(it.title || '').toLowerCase()));
        return hits.length ? (pickLatestByBasename(hits) as SearchItem[]) : items;
      }
      filtered = prioritizeRequestedFilenames(filtered, requestedFilenames);

      // 3c) If we asked for multiple filenames and didn’t get them all, run targeted fallback searches.
      async function targetedFallbackForMissing(names: string[], already: SearchItem[]) {
        const have = new Set(already.map(it => basename(it.title || '').toLowerCase()));
        const missing = names.filter(n => !have.has(basename(n).toLowerCase()));
        if (!missing.length) return already;

        const base = `${req.protocol}://${req.get('host')}`;
        const url = `${base}/api/context/analyze-v2`;

        for (const fname of missing) {
          const ac2 = new AbortController();
          const t2 = setTimeout(() => ac2.abort(), 12000);
          const r = await fetch(url, {
            method: 'POST',
            signal: ac2.signal,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ message: fname, projectId, limit: Math.min(cappedLimit, 10) })
          }).catch(() => null);
          clearTimeout(t2);
          const j = await r?.json().catch(() => null);
          const add = toSearchItems(Array.isArray(j?.results) ? j.results : []);
          const narrowed = add.filter(it => basename(it.title || '').toLowerCase() === basename(fname).toLowerCase());
          if (narrowed.length) {
            const latest = pickLatestByBasename(narrowed)[0] as SearchItem;
            already.push(latest);
          }
        }
        return already;
      }

      const requestedNamesArray = Array.from(requestedFilenames);
      if (requestedNamesArray.length >= 2) {
        filtered = await targetedFallbackForMissing(requestedNamesArray, filtered);
      }

      // 3d) Deduplicate by basename - keep only the latest version of each file
      if (filtered.length > 1) {
        const beforeDedup = filtered.length;
        filtered = pickLatestByBasename(filtered) as SearchItem[];
        if (beforeDedup !== filtered.length) {
          console.log(`  🔄 Deduplicated: ${beforeDedup} → ${filtered.length} items (kept latest versions)`);
        }
      }

      // 3e) If still empty, fallback to unfiltered top-N
      if (filtered.length === 0) filtered = searchItems.slice(0, 10);

      // 3f) If a specific function was requested, extract just that function
      if (requestedFunctions.length > 0 && filtered.some(it => it.kind === 'file' || it.kind === 'block')) {
        const sortedFunctions = [...requestedFunctions].sort((a, b) => b.length - a.length);
        console.log(`  🔍 Extracting functions: ${sortedFunctions.join(', ')}`);
        
        // Process each item (files AND blocks)
        for (let i = 0; i < filtered.length; i++) {
          const item = filtered[i];
          
          // Only process files and blocks
          if (item.kind !== 'file' && item.kind !== 'block') continue;
          
          console.log(`  🐛 ${item.kind}: ${item.title}`);
          console.log(`     - Content length: ${item.content.length} chars`);
          console.log(`     - Conversation ID: ${item.conversation_id || 'MISSING'}`);
          
          let contentToSearch = item.content;
          let needsFullFile = false;
          
          // For files: always fetch full content (search results are truncated)
          if (item.kind === 'file' && item.conversation_id && item.title) {
            console.log(`  📥 Fetching full file content for ${item.title}...`);
            const fullContent = await fetchFullFileContent(item.conversation_id, item.title);
            
            if (fullContent) {
              contentToSearch = fullContent;
              console.log(`  ✓ Loaded full file: ${fullContent.length} chars`);
            }
          }
          
          // For blocks: check if function exists, if not, fetch parent file
          if (item.kind === 'block') {
            // First check if any requested function is in the block
            const functionInBlock = sortedFunctions.some(fn => contentToSearch.includes(fn));
            
            if (!functionInBlock) {
              console.log(`  ⚠️  Function not in block, attempting to fetch parent file...`);
              
              // Try to extract filename from block title or content
              const possibleFilenames = extractFilenames(item.title + ' ' + contentToSearch.slice(0, 500));
              
              for (const filename of possibleFilenames) {
                if (filename.endsWith('.ts') || filename.endsWith('.js')) {
                  console.log(`  📥 Fetching parent file: ${filename}...`);
                  const fullContent = await fetchFullFileContent(item.conversation_id || '', filename);
                  
                  if (fullContent && sortedFunctions.some(fn => fullContent.includes(fn))) {
                    contentToSearch = fullContent;
                    item.title = filename; // Update title to reflect we're using the file
                    console.log(`  ✓ Loaded parent file: ${fullContent.length} chars`);
                    break;
                  }
                }
              }
            }
          }
          
          // Try to extract the requested function
          for (const funcName of sortedFunctions) {
            if (!contentToSearch.includes(funcName)) {
              console.log(`  ✗ "${funcName}" NOT found (checked ${contentToSearch.length} chars)`);
              continue;
            }
            
            console.log(`  ✓ "${funcName}" found!`);
            const extracted = extractFunction(contentToSearch, funcName);
            
            if (extracted) {
              console.log(`  ✂️  Extracted ${funcName}() from ${item.title} (${extracted.length} chars)`);
              filtered[i] = {
                ...item,
                content: extracted,
                title: `${funcName}() function from ${item.title}`
              };
              break; // Stop after first successful extraction
            } else {
              console.log(`  ❌ Extraction failed for ${funcName}() - regex didn't match`);
            }
          }
        }
      }

      // 3g) Build itemsMeta (1-based) for optional second-pass refinement
      const itemsMeta = filtered.map((it, i) => ({
        index: i + 1,
        title: it.title,
        kind: it.kind,
        id: it.id
      }));

      console.log(`  ✅ Converted ${searchItems.length} items → ${filtered.length} after filters/priority/fallback`);

      if (filtered.length === 0) {
        return res.json({
          success: true,
          message: 'No results found for your query',
          totalTime: `${Date.now() - startTime}ms`,
          plan: parseResult.plan
        });
      }

      // 3h): refine the plan with itemsMeta
      let finalPlan = parseResult.plan;
      try {
        const refine = await getIntentParser().parseInstruction(instruction, {
          projectId,
          budgetTokens,
          itemsMeta,
          recentQueries: [effectiveQuery]
        });
        if (refine.success && refine.plan) {
          finalPlan = refine.plan;
          console.log('  🔧 Plan refined with itemsMeta (post-filter)');
        }
      } catch {
        /* no-op */
      }

      // NOW override selection if multiple filenames requested
      if (requestedNamesArray.length >= 2 && filtered.length >= 2) {
        finalPlan.selection = { strategy: 'all' };
        console.log(`  🎯 Forcing selection of all ${filtered.length} items (multiple filenames requested)`);
      }

    // Step 4: Execute the plan (now uses filteredItems instead of searchItems)
    console.log('⚙️  Step 4: Executing plan...');
    const executor = getPlanExecutor();
    const executionResult = await executor.executePlan(finalPlan, filtered);

      if (!executionResult.success) {
        return res.status(500).json({
          success: false,
          error: executionResult.error || 'Execution failed',
          step: 'execute'
        });
      }

      // Decide if we should synthesize an answer
      const synthesisDecision = await decideSynthesis(instruction, finalPlan);

      let dbSchemaContext: string | null = null;
      let synthesizedAnswer: string | null = null;

      if (synthesisDecision.shouldSynthesize) {
        // Generate cache key
        const cacheKey = generateCacheKey(instruction, executionResult.pasteBlock || '');
        
        // Try to get cached answer first
        synthesizedAnswer = await getCachedAnswer(cacheKey, supabase);
        
        if (!synthesizedAnswer) {
          // Cache miss - synthesize new answer
          dbSchemaContext = await introspectDatabase(instruction, supabase);
          
          if (dbSchemaContext) {
            console.log(`  📊 Adding database schema context to synthesis`);
          }
          
          // Synthesize answer using Claude (with citations)
          const minimalPack: ContextPack = {
            instruction,
            intent: 'context_injection',
            operators: { raw: {} },
            subquestions: [{
              id: 'sq-001',
              text: instruction,
              coverage: 'gap' as const,
              code: (executionResult.selectedItems || []).map((item: any) => ({
                path: item.path || '',
                startLine: item.startLine || 1,
                endLine: item.endLine || 1,
                snippet: item.snippet || item.content || ''
              })),
              sources: (executionResult.selectedItems || []).map((item: any) => ({
                kind: item.kind as 'message' | 'file' | 'entity',
                path: item.title || item.path,
                startLine: item.startLine,
                endLine: item.endLine,
                conversationId: item.conversation_id,
                messageId: item.source?.message_id,
                score: item.score ?? 0,
                signals: item.signals || {},
                content: item.content
              })),
              facts: [],
              messages: [],
              locations: [],
              gaps: []
            }],
            index: { files: [], messages: [], entities: [] },
            budget: { inputTokens: 12000, outputTokens: 0, compacted: false },
            version: 'cp-0.1'
          };
          synthesizedAnswer = await synthesizeAnswer(instruction, minimalPack, [projectId]);
          
          // Cache the result for future queries
          if (synthesizedAnswer) {
            await setCachedAnswer(
              cacheKey,
              instruction,
              synthesizedAnswer,
              executionResult.selectedItems?.length || 0,
              supabase
            );
          }
        }
      }

      const totalTime = Date.now() - startTime;
      const executeTime = totalTime - parseTime - searchTime;
      console.log(`\n✅ Agent query complete in ${totalTime}ms\n`);

      // Step 5: Log to telemetry (for ML improvement)
      try {
        await supabase.from('cb_agent_queries').insert({
            project_id: projectId,
            instruction,
            parsed_intent: finalPlan,             // refined plan
            search_query: effectiveQuery,
            search_results_count: filtered.length,
            selected_item_ids: executionResult.selectedItems?.map(i => i.id) || [],
            token_estimate: executionResult.tokenEstimate,
            token_budget_used: finalPlan.budget?.maxTokens ?? null,
            truncation_occurred: !!executionResult.truncated,
            agent_plan: finalPlan,
            paste_block_length: executionResult.pasteBlock?.length || 0,
            insertion_method: finalPlan.action?.type || null,
            processing_time_ms: totalTime
        });
        } catch (logError) {
        console.warn('⚠️  Failed to log telemetry:', logError);
        }

        // Step 6: Return result
        return res.json({
        success: true,
        totalTime: `${totalTime}ms`,
        pipeline: {
            parse: {
            source: parseResult.source || 'parser',
            time: `${parseTime}ms`,
            confidence: finalPlan.confidence,
            intent: finalPlan.intent
            },
            search: {
            time: `${searchTime}ms`,
            resultsFound: filtered.length,
            query: effectiveQuery
            },
            execute: {
            time: `${executeTime}ms`,  // ✅ Fixed!
            itemsSelected: executionResult.selectedItems?.length || 0,
            tokenEstimate: executionResult.tokenEstimate,
            truncated: executionResult.truncated
            }
        },
        agentPlan: finalPlan,
        result: {
            synthesizedAnswer: synthesizedAnswer,
            shouldSynthesize: synthesisDecision.shouldSynthesize,
            
            pasteBlock: executionResult.pasteBlock,
            tokenEstimate: executionResult.tokenEstimate,
            truncated: executionResult.truncated,
            selectedItems: executionResult.selectedItems?.map(item => ({
              id: item.id,
              title: item.title,
              kind: item.kind,
              score: item.score,
              contentPreview: (item.content || '').slice(0, 160) + ((item.content || '').length > 160 ? '…' : '')
            })),
            metadata: {
              ...executionResult.metadata,
              tokenBudgetTarget: finalPlan?.budget?.maxTokens ?? null,
              tokenBudgetUsed: executionResult.tokenEstimate ?? null
            }
        }
        });

    } catch (error: any) {
      console.error('❌ Agent query error:', error);
      return res.status(500).json({
        success: false,
        error: error.message || String(error)
      });
    }
  });

  // Helper: Enrich msg_ paths with conversation titles and content summaries
  async function enrichMsgPaths(pack: ContextPack) {
    // Collect all msg_ paths from code blocks AND index files
    const msgPaths: string[] = [];
    
    // From subquestion code blocks
    for (const sq of pack.subquestions || []) {
      for (const code of sq.code || []) {
        if (code.path?.startsWith('msg_')) {
          msgPaths.push(code.path);
        }
      }
    }
    
    // From index files
    for (const file of pack.index?.files || []) {
      if (file.path?.startsWith('msg_') && !msgPaths.includes(file.path)) {
        msgPaths.push(file.path);
      }
    }
    
    if (msgPaths.length === 0) return;
    
    // Batch resolve paths
    const { data, error } = await supabase.rpc('cb_resolve_msg_paths', {
      p_paths: msgPaths
    });
    
    if (error || !data) {
      console.warn('[agent] Failed to resolve msg paths:', error);
      return;
    }
    
    // Build lookup map
    const pathMap = new Map<string, { displayName: string; contentSummary: string; conversationId: string; provider: string }>();
    for (const row of data) {
      pathMap.set(row.path, {
        displayName: row.conversation_title || 'Unknown Conversation',
        contentSummary: row.content_summary || '',
        conversationId: row.conversation_id || '',
        provider: row.provider || null
      });
    }
    
    // Enrich code blocks
    for (const sq of pack.subquestions || []) {
      for (const code of sq.code || []) {
        const resolved = pathMap.get(code.path);
        if (resolved) {
          (code as any).displayName = resolved.displayName;
          (code as any).contentSummary = resolved.contentSummary;
          (code as any).conversationId = resolved.conversationId;
          (code as any).provider = resolved.provider;
        }
      }
    }
    
    // Enrich index files
    for (const file of pack.index?.files || []) {
      const resolved = pathMap.get(file.path);
      if (resolved) {
        (file as any).displayName = resolved.displayName;
        (file as any).contentSummary = resolved.contentSummary;
        (file as any).conversationId = resolved.conversationId;
        (file as any).provider = resolved.provider;
      }
    }
  }

  /**
   * POST /api/agent/context-pack
   * Returns a deterministic skeleton populated with LLM conversations AND Codex results.
   */
  router.post('/agent/context-pack', async (req, res) => {
    try {
      console.log('[agent/context-pack] Starting...');
      const { instruction, projectId, projectIds, tokenBudget = 12000, includeCodex = false } = req.body ?? {};
      
      const searchProjectIds = projectIds && Array.isArray(projectIds) && projectIds.length > 0
        ? projectIds
        : projectId ? [projectId] : [];
      
      // Allow empty project list IF includeCodex is true
      if (!instruction || (searchProjectIds.length === 0 && !includeCodex)) {
        return res.status(400).json({ error: 'instruction and projectId (or includeCodex) are required' });
      }

      // Safe metadata lookup (might be empty list)
      const { data: projects } = await supabase.from('cb_projects').select('id, name, provider').in('id', searchProjectIds);
      const projectMap = new Map((projects || []).map(p => [p.id, p]));

      const { cleaned, ops } = parseOperators(String(instruction));
      const subs = splitSubquestions(cleaned);

      const combinedPack: ContextPack = {
        instruction,
        intent: 'context_injection',
        operators: ops,
        subquestions: subs.map((text, i) => ({
          id: `sq-${String(i + 1).padStart(3, '0')}`,
          text,
          coverage: 'gap',
          facts: [], code: [], messages: [], sources: [], locations: [], gaps: []
        })),
        index: { files: [], messages: [], entities: [] },
        budget: { inputTokens: tokenBudget, outputTokens: 0, compacted: false },
        version: 'cp-0.1'
      };

      const exec = new ContextPackExecutor({ retriever: new SupabaseRetriever(supabase), perSubTopK: 6 });
      exec.setContentFetcher(new FileContentFetcher(supabase));

      // 1. Run Standard Execution (LLM/DB) for each selected project
      for (const projId of searchProjectIds) {
          console.log(`[agent/context-pack] Processing project ${projId}...`);
          const projectPack: ContextPack = {
            instruction,
            intent: 'context_injection',
            operators: ops,
            subquestions: subs.map((text, i) => ({
              id: `sq-${String(i + 1).padStart(3, '0')}`,
              text,
              coverage: 'gap',
              facts: [], code: [], messages: [], sources: [], locations: [], gaps: []
            })),
            index: { files: [], messages: [], entities: [] },
            budget: { inputTokens: tokenBudget, outputTokens: 0, compacted: false },
            version: 'cp-0.1'
          };
          
          console.log(`[agent/context-pack] Calling fillPack for ${projId}...`);
          const fillStart = Date.now();
          await exec.fillPack(projId, projectPack);
          console.log(`[agent/context-pack] fillPack completed in ${Date.now() - fillStart}ms`);
          
          // Merge results into combined pack
          combinedPack.subquestions.forEach((sq, idx) => {
             const pSq = projectPack.subquestions[idx];
             if (pSq) {
                 if(pSq.code) sq.code.push(...pSq.code);
                 if(pSq.messages) sq.messages.push(...pSq.messages);
                 if(pSq.sources) sq.sources.push(...pSq.sources);
                 if(pSq.facts) sq.facts.push(...pSq.facts);
                 
                 // TS FIX: Safely merge locations
                 if (Array.isArray(pSq.locations) && pSq.locations.length > 0) {
                     if (!sq.locations) sq.locations = [];
                     sq.locations.push(...pSq.locations);
                 }
                 
                 if(pSq.gaps) {
                     if (!sq.gaps) sq.gaps = [];
                     sq.gaps.push(...pSq.gaps);
                 }
             }
          });
          
          if(projectPack.index.files) combinedPack.index.files.push(...projectPack.index.files);
          if(projectPack.index.messages) combinedPack.index.messages.push(...projectPack.index.messages);
          
          // TS FIX: Safely merge entities
          if(projectPack.index.entities) {
              if (!combinedPack.index.entities) combinedPack.index.entities = [];
              combinedPack.index.entities.push(...projectPack.index.entities);
          }
          
          combinedPack.budget.outputTokens += projectPack.budget.outputTokens;
      }

      // 2. Run Sidecar Codex Search (Dynamic & Multi-Project)
      // Determine which projects to search for code.
      let codexProjectIds = [...searchProjectIds];

      // If no projects selected but Codex is requested, fetch the most recent active project ID from DB
      if (codexProjectIds.length === 0 && includeCodex) {
           // Find projects that actually have chunks (VS Code files)
           const { data: projectsWithChunks } = await supabase
             .from('cb_chunks')
             .select('project_id')
             .limit(500);
           
           const uniqueProjectIds = [...new Set((projectsWithChunks || []).map(c => c.project_id))];
           
           if (uniqueProjectIds.length > 0) {
              codexProjectIds = uniqueProjectIds;
              console.log(`[agent] Codex fallback: using ${codexProjectIds.length} projects with chunks: ${codexProjectIds.join(', ')}`);
           } else {
              console.log(`[agent] Codex fallback: no projects with chunks found`);
           }
        }

      console.log(`[agent] Codex check: includeCodex=${includeCodex}, codexProjectIds=${JSON.stringify(codexProjectIds)}`);
      if (includeCodex && codexProjectIds.length > 0) {
        // 1. Deduplicate queries (Fixes the "Double Call" bug)
        const codexQueries = Array.from(new Set([cleaned, ...subs].filter(b => b && b.trim().length > 0)));
        const uniqueCodexHits = new Map<string, any>();

        // 2. Parallelize: Fire all (Project x Query) searches simultaneously
        console.log(`[Codex] Parallelizing search: ${codexProjectIds.length} projects x ${codexQueries.length} queries`);
        
        const searchPromises = codexProjectIds.flatMap(pid => 
            codexQueries.map(q => searchCodexForPack(pid, q, 3))
        );
        
        // 3. Wait for all to finish (Duration = slowest single request, not sum of all)
        const allResults = await Promise.all(searchPromises);

        // 4. Flatten and deduplicate hits
        for (const hits of allResults) {
            for (const hit of hits) {
                // Key by path + startLine to avoid showing same code block twice
                const key = `${hit.path}:${hit.startLine}`;
                if (!uniqueCodexHits.has(key)) uniqueCodexHits.set(key, hit);
            }
        }

        const codexResults = Array.from(uniqueCodexHits.values());
        
        // 5. Merge into Pack (Existing logic)
        if (codexResults.length > 0) {
          if (!combinedPack.subquestions[0].code) combinedPack.subquestions[0].code = [];
          combinedPack.subquestions[0].code.push(...codexResults);

          if (!combinedPack.index.files) combinedPack.index.files = [];
          
          codexResults.forEach(c => {
             const existing = combinedPack.index.files.find(f => f.path === c.path);
             if (!existing) {
                combinedPack.index.files.push({
                  path: c.path,
                  lastModified: new Date().toISOString()
                });
             }
          });
        }
      }

      console.log(`[agent/context-pack] Starting enrichMsgPaths...`);
      const enrichStart = Date.now();
      await enrichMsgPaths(combinedPack);
      console.log(`[agent/context-pack] enrichMsgPaths completed in ${Date.now() - enrichStart}ms`);
      
      const responsePayload = {
        ok: true,
        projectIds: searchProjectIds,
        pack: combinedPack
      };
      console.log(`[agent/context-pack] Sending response (${JSON.stringify(responsePayload).length} bytes)`);
      
      return res.json({
        ok: true,
        projectIds: searchProjectIds,
        pack: combinedPack
      });
    } catch (err: any) {
      console.error('[agent] /agent/context-pack error:', err);
      return res.status(500).json({ error: err?.message ?? 'Internal error' });
    }
  });

  /**
   * POST /api/agent/context-pack-friendly
   */
  // User-friendly version of context-pack
  router.post('/agent/context-pack-friendly', async (req, res) => {
    try {
        const { instruction, projectId, projectIds, tokenBudget, includeCodex = false } = req.body;
        
        const searchProjectIds = projectIds && Array.isArray(projectIds) && projectIds.length > 0
          ? projectIds
          : projectId ? [projectId] : [];
        
        if (!instruction?.trim() || (searchProjectIds.length === 0 && !includeCodex)) {
          return res.status(400).json({ error: 'instruction and projectId (or includeCodex) are required' });
        }

        const { data: projects } = await supabase.from('cb_projects').select('id, name, provider').in('id', searchProjectIds);
        const projectMap = new Map((projects || []).map(p => [p.id, p]));

        // Reuse logic from /agent/context-pack... 
        // (Copying the logic block for brevity to ensure full functionality)
        const { cleaned, ops } = parseOperators(String(instruction));
        const subs = splitSubquestions(cleaned);

        const combinedPack: ContextPack = {
            instruction,
            intent: 'context_injection',
            operators: ops,
            subquestions: subs.map((text, i) => ({
            id: `sq-${String(i + 1).padStart(3, '0')}`,
            text,
            coverage: 'gap',
            facts: [], code: [], messages: [], sources: [], locations: [], gaps: []
            })),
            index: { files: [], messages: [], entities: [] },
            budget: { inputTokens: tokenBudget || 12000, outputTokens: 0, compacted: false },
            version: 'cp-0.1'
        };

        const exec = new ContextPackExecutor({ retriever: new SupabaseRetriever(supabase), perSubTopK: 6 });
        exec.setContentFetcher(new FileContentFetcher(supabase));

        // 1. Standard Search
        for (const projId of searchProjectIds) {
            const projectPack: ContextPack = {
                instruction,
                intent: 'context_injection',
                operators: ops,
                subquestions: subs.map((text, i) => ({
                    id: `sq-${String(i + 1).padStart(3, '0')}`,
                    text,
                    coverage: 'gap',
                    facts: [], code: [], messages: [], sources: [], locations: [], gaps: []
                })),
                index: { files: [], messages: [], entities: [] },
                budget: { inputTokens: tokenBudget || 12000, outputTokens: 0, compacted: false },
                version: 'cp-0.1'
            };
            
            await exec.fillPack(projId, projectPack);
            
            combinedPack.subquestions.forEach((sq, idx) => {
                const pSq = projectPack.subquestions[idx];
                if (pSq) {
                    if(pSq.code) sq.code.push(...pSq.code);
                    if(pSq.messages) sq.messages.push(...pSq.messages);
                    if(pSq.sources) sq.sources.push(...pSq.sources);
                    if(pSq.facts) sq.facts.push(...pSq.facts);
                    
                    // TS FIX: Safely merge locations
                    if (pSq.locations && pSq.locations.length > 0) {
                        if (!sq.locations) sq.locations = [];
                        sq.locations.push(...pSq.locations);
                    }
                    if(pSq.gaps) {
                        if (!sq.gaps) sq.gaps = [];
                        sq.gaps.push(...pSq.gaps);
                    }
                }
            });

            if(projectPack.index.files) combinedPack.index.files.push(...projectPack.index.files);
            if(projectPack.index.messages) combinedPack.index.messages.push(...projectPack.index.messages);
            
            // TS FIX: Safely merge entities
            if(projectPack.index.entities) {
                if (!combinedPack.index.entities) combinedPack.index.entities = [];
                combinedPack.index.entities.push(...projectPack.index.entities);
            }
            combinedPack.budget.outputTokens += projectPack.budget.outputTokens;
        }

        // Codex Search for Friendly Mode
        let codexProjectIds = [...searchProjectIds];
        if (codexProjectIds.length === 0 && includeCodex) {
            const { data: projectsWithChunks } = await supabase.from('cb_chunks').select('project_id').limit(500);
            const uniqueProjectIds = [...new Set((projectsWithChunks || []).map((c: any) => c.project_id))];
            if (uniqueProjectIds.length > 0) codexProjectIds = uniqueProjectIds;
        }

      console.log(`[agent] Codex check: includeCodex=${includeCodex}, codexProjectIds=${JSON.stringify(codexProjectIds)}`);
      
      if (includeCodex && codexProjectIds.length > 0) {
        // 1. Deduplicate queries (Fixes the "Double Call" bug)
        const codexQueries = Array.from(new Set([cleaned, ...subs].filter(b => b && b.trim().length > 0)));
        const uniqueCodexHits = new Map<string, any>();

        // 2. Parallelize: Fire all (Project x Query) searches simultaneously
        console.log(`[Codex] Parallelizing search: ${codexProjectIds.length} projects x ${codexQueries.length} queries`);
        
        const searchPromises = codexProjectIds.flatMap(pid => 
            codexQueries.map(q => searchCodexForPack(pid, q, 3))
        );

        // 3. Wait for all to finish (Duration = slowest single request, not sum of all)
        const allResults = await Promise.all(searchPromises);

        // 4. Flatten and deduplicate hits
        for (const hits of allResults) {
            for (const hit of hits) {
                // Key by path + startLine to avoid showing same code block twice
                const key = `${hit.path}:${hit.startLine}`;
                if (!uniqueCodexHits.has(key)) uniqueCodexHits.set(key, hit);
            }
        }

        const codexResults = Array.from(uniqueCodexHits.values());
        
        // 5. Merge into Pack (Existing logic)
        if (codexResults.length > 0) {
          if (!combinedPack.subquestions[0].code) combinedPack.subquestions[0].code = [];
          combinedPack.subquestions[0].code.push(...codexResults);

          if (!combinedPack.index.files) combinedPack.index.files = [];
          
          codexResults.forEach(c => {
             const existing = combinedPack.index.files.find(f => f.path === c.path);
             if (!existing) {
                combinedPack.index.files.push({
                  path: c.path,
                  lastModified: new Date().toISOString()
                });
             }
          });
        }
      }

        // Enrich msg_ paths with human-readable names
        await enrichMsgPaths(combinedPack);
        
        // Route through analyze-v2 for better context assembly (same as agent/query)
        const base = `${req.protocol}://${req.get('host')}`;
        const avRes = await fetch(`${base}/api/context/analyze-v2`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': req.headers['authorization'] || ''
          },
          body: JSON.stringify({ message: instruction, projectId: searchProjectIds[0], limit: 25 })
        }).catch(() => null);

        const avData = avRes?.ok ? await avRes.json() : null;

        // Build a minimal pack from analyze-v2 results for synthesizeAnswer
        if (avData?.results) {
          const avMessages = (avData.results as any[]).flatMap((g: any) =>
            (g.items || []).map((item: any) => ({
              kind: 'message' as const,
              path: item.conversation_id || '',
              content: item.content || '',
              score: item.score || 0,
              startLine: 0, endLine: 0, snippet: ''
            }))
          );
          combinedPack.subquestions[0].sources = avMessages;
        }

        const result = await formatUserFriendly(combinedPack, searchProjectIds);
        
        return res.json({
            ok: true, 
            success: true,
            result,
            pack: combinedPack
        });
        
    } catch (err: any) {
        console.error('[agent] /agent/context-pack-friendly error:', err);
        return res.status(500).json({ error: err?.message ?? 'Internal error' });
    }
  });

  /**
   * Use LLM to synthesize intelligent answer
   */
  async function synthesizeAnswer(query: string, pack: ContextPack, projectIds?: string[]): Promise<string> {
    const sq = pack.subquestions[0];
    
    // Check if we have ANY sources (Codex or otherwise)
    const hasCode = sq.code && sq.code.length > 0;
    const hasSources = sq.sources && sq.sources.length > 0;

    // DEBUG: Check what's in sources
    console.log('[synthesizeAnswer] hasSources:', hasSources, 'hasCode:', hasCode);
    if (sq.sources?.length > 0) {
      console.log('[synthesizeAnswer] First source:', JSON.stringify({
        kind: sq.sources[0].kind,
        path: sq.sources[0].path,
        hasContent: !!sq.sources[0].content,
        contentPreview: (sq.sources[0].content || '').slice(0, 50)
      }));
    }

    // DEBUG: Show ALL sources with their kinds
    console.log('[synthesizeAnswer] ALL sources:');
    sq.sources?.forEach((src, i) => {
      console.log(`  [${i}] kind=${src.kind}, path=${src.path?.slice(0,30)}, hasContent=${!!src.content}`);
    });

    if (!hasCode && !hasSources) {
      return 'No relevant information was found for your query. Try refining your search terms.';
    }
    
    // Build context from BOTH code and sources
    const contextParts: string[] = [];
    
    // 1. Add conversation messages FIRST (most likely to have direct answers)
    if (hasSources) {
      const messageSourcesOnly = sq.sources.filter(s => s.kind === 'message' && s.content);
      const topSources = messageSourcesOnly.slice(0, 10);
      
      // DEBUG: What messages passed the filter?
      console.log('[synthesizeAnswer] Messages after filter:', messageSourcesOnly.length);
      messageSourcesOnly.forEach((m, i) => {
        console.log(`  [${i}] content preview: ${m.content?.slice(0, 100)}`);
      });
      
      if (topSources.length > 0) {
        const sourceContext = topSources
          .map(s => `**Conversation Message**\n${s.content}`)
          .join('\n\n---\n\n');
        contextParts.push('=== CONVERSATION MESSAGES ===\n' + sourceContext);
      }
    }
    
    // 2. Add code/file snippets (supporting context)
    if (hasCode) {
      const filteredCode = (sq.code || []).filter(c => {
        const p = c.path || '';
        // Exclude absolute local paths (Windows drive letters, URL-encoded paths)
        if (/^\/\/\/|%3[aA]|^[a-zA-Z]:[\\\/]/i.test(p)) return false;
        // Exclude binary/compiled file extensions
        if (/\.(pyc|pyo|so|dll|exe|class|o|a|lib|pdb)$/i.test(p)) return false;
        return true;
      });
      const topCode = filteredCode.slice(0, 10);
      const codeContext = topCode
        .map(c => `**File: ${c.path}** (Lines ${c.startLine}-${c.endLine})\n\`\`\`\n${c.snippet}\n\`\`\``)
        .join('\n\n');
      if (codeContext) {
        contextParts.push('=== CODE FILES ===\n' + codeContext);
      }
    }

    // 3. Fetch relevant chunks from cb_chunks using text search (supplements sq.code snippets)
    if (projectIds && projectIds.length > 0) {
      try {
        const searchTerms = query.split(' ').filter(w => w.length > 2).join(' & ');
        const { data: chunkRows } = await supabase
          .from('cb_chunks')
          .select('text, metadata, start_line, end_line')
          .in('project_id', projectIds)
          .textSearch('text_search_vector', searchTerms, { type: 'plain' })
          .order('updated_at', { ascending: false })
          .limit(5);

        console.log('[synthesizeAnswer] cb_chunks text search returned:', chunkRows?.length, 'rows');

        if (chunkRows && chunkRows.length > 0) {
          const chunkContext = chunkRows
            .map(r => `**File: ${r.metadata?.file_path}** (Lines ${r.start_line}-${r.end_line})\n\`\`\`\n${r.text}\n\`\`\``)
            .join('\n\n');
          contextParts.push('=== CODE CHUNKS ===\n' + chunkContext);
        }
      } catch (e) {
        console.warn('[synthesizeAnswer] cb_chunks text search error:', e);
      }
    }
    
    const context = contextParts.join('\n\n');
    
    // DEBUG: Verify both sections are present
    console.log('[synthesizeAnswer] contextParts count:', contextParts.length);
    contextParts.forEach((part, i) => {
      console.log(`[synthesizeAnswer] Part ${i} header:`, part.slice(0, 60));
    });
    
    console.log('[synthesizeAnswer] Context being sent to LLM:\n', context.slice(0, 2000));
    console.log('[synthesizeAnswer] Sources count:', sq.sources?.length, 'Code count:', sq.code?.length);
    
    // Truncate context if too long (roughly 8k tokens max)
    const maxContextChars = 24000;
    const truncatedContext = context.length > maxContextChars 
      ? context.slice(0, maxContextChars) + '\n\n[... truncated for brevity ...]'
      : context;
    
    const facts = sq.facts && sq.facts.length > 0 
      ? `\n\nKnown facts:\n${sq.facts.slice(0, 10).map(f => `- ${f}`).join('\n')}`
      : '';
    
    // Detect if this is a coding query or general/domain query
    const isCodeQuery = hasCode && !hasSources;
    const systemRole = isCodeQuery 
      ? 'You are a helpful coding assistant.'
      : 'You are a helpful assistant with access to the user\'s past conversations and documents.';
    
    const prompt = `${systemRole} A user asked: "${query}"

Based on the following information from their project, and that ONLY, provide a clear, direct answer.

${truncatedContext}${facts}

Rules you MUST follow:
1. Answer ONLY using the information explicitly present in the context above.
2. Do NOT use phrases like "likely", "probably", "may be", "typically", "in general", or any speculative language.
3. First, look in CODE FILES, BLOCKS, SNIPPETS, or other sources, including other types of FILES for a precise answer via cb_chunks. If you find a direct answer there, use it first and reference the specific file and line range provided.
4. Then, if the answer is also found in CONVERSATION MESSAGES, augment your detailed answer with that — it reflects what was actually discussed. Look for the most recent relevant message(s) that directly answer the question, and use their content to enrich your answer. Reference the conversation title, message content, and any other relevant metadata to provide a comprehensive answer.
5. If the answer was NOT found in CODE FILES, BLOCKS, SNIPPETS, or other sources, including other types of FILES found, then use the CONVERSATION MESSAGES only to formulate an answer.
6. Do not introduce any information from outside the provided context.
7. Make your answer as precise and accurate as possible and limit it to 4-5 paragraphs maximum.

Answer:`;

    try {
      // Add timeout to prevent hanging
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000); // 15 second timeout
      
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 1000
        })
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) {
        // Fallback
        const topItem = sq.sources?.[0] || sq.code?.[0];
        if (topItem) return `Found relevant information in **${topItem.path || 'conversation'}**. (AI synthesis unavailable)`;
        return "Found relevant information.";
      }
      
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content?.trim() || "Found relevant information.";
      
    } catch (err: any) {
      // Handle timeout specifically
      if (err.name === 'AbortError') {
        console.warn('[synthesizeAnswer] Request timed out');
      } else {
        console.warn('[synthesizeAnswer] Error:', err.message);
      }
      
      const topItem = sq.sources?.[0] || sq.code?.[0];
      if (topItem) return `Found relevant information in **${topItem.path || 'conversation'}**. (AI synthesis unavailable)`;
      return "Found relevant information.";
    }
  }

  async function formatUserFriendly(pack: ContextPack, projectIds: string[]): Promise<{
    synthesizedAnswer: string;
    pasteBlock: string;
    tokenEstimate: number;
    selectedItems: Array<{ path?: string; startLine?: number; endLine?: number; score?: number }>;
    pack: ContextPack;
  }> {
    const sq = pack.subquestions[0];
    
    // Call with correct arguments
    const answer = await synthesizeAnswer(pack.instruction, pack, projectIds);
    
    const pasteBlock = sq.code.map(c => c.snippet).join('\n\n---\n\n');
    
    return {
      synthesizedAnswer: answer,
      pasteBlock: pasteBlock,
      tokenEstimate: Math.ceil(pasteBlock.length / 4),
      selectedItems: sq.sources.map(s => ({
        path: s.path,
        startLine: s.startLine,
        endLine: s.endLine,
        score: s.score
      })),
      pack: pack
    };
  }

  /**
   * POST /api/agent/search-tiered
   * Returns search results in tiered format (artifacts vs memory)
   * Simpler alternative to context-pack for UI rendering
   */
  router.post('/agent/search-tiered', async (req: Request, res: Response) => {
    const startTime = Date.now();
    
    try {
      const { query, projectId, projectIds = [], includeCodex = false, cacheBust = '' } = req.body ?? {};
      
      if (!query || !projectId) {
        return res.status(400).json({ 
          error: 'query and projectId are required' 
        });
      }

      console.log(`[agent/search-tiered] Query: "${query}" Project: ${projectId} includeCodex: ${includeCodex}`);

      // Only search Codex for the user's selected project(s)
      let codexProjectIds: string[] = [];
      if (includeCodex) {
        // Start with user-provided project IDs
        const allIds = projectIds.length > 0 ? projectIds : [projectId];
        codexProjectIds = [...new Set(allIds)] as string[];

        // Discover additional projects that have Codex chunks (VS Code synced)
        try {
          const { data: chunkProjects } = await supabase
            .from('cb_chunks')
            .select('project_id')
            .limit(500);
          const codexOnlyIds = [...new Set((chunkProjects || []).map((c: any) => c.project_id))]
            .filter((id: string) => !codexProjectIds.includes(id));
          if (codexOnlyIds.length > 0) {
            codexProjectIds.push(...codexOnlyIds);
            console.log(`[agent/search-tiered] Discovered ${codexOnlyIds.length} additional Codex projects:`, codexOnlyIds);
          }
        } catch (e) {
          console.warn('[agent/search-tiered] Codex discovery failed:', e);
        }

        codexProjectIds = [...new Set(codexProjectIds)] as string[];
        console.log(`[agent/search-tiered] Using Codex for projects:`, codexProjectIds);
      }

      // Import the converter
      const { toTieredResponse } = await import('../agent/supabase-retriever.js');
      
      // Create retriever and execute search
      const retriever = new SupabaseRetriever(supabase);
      const lists = await retriever.retrieve({
        projectId,
        query,
        operators: {},  // No operators for simple search
        codexProjectIds  // Pass discovered Codex projects for code file search
      });

      // Convert to tiered format
      const tiered = toTieredResponse(query, lists, startTime);

      // Enrich memory messages with conversation titles, URLs, and providers
      const convIds = [...new Set(tiered.memory.messages.map(m => m.conversationId).filter(Boolean))];
      console.log('[search-tiered] convIds check:', { count: convIds.length, ids: convIds.slice(0, 3) });
      if (convIds.length > 0) {
        const { data: convRows, error: convError } = await supabase
          .from('cb_conversations')
          .select('id, url, title, summary')
          .in('id', convIds);
        
        console.log('[search-tiered] convRows result:', { data: convRows?.length, error: convError });
        
        if (convRows) {
          const convMap = new Map(convRows.map((c: any) => [c.id, c]));
          console.log('[search-tiered] Title enrichment:', {
            requestedIds: convIds,
            foundRows: convRows.length,
            sample: convRows.slice(0, 3).map((c: any) => ({ id: c.id, title: c.title, summary: c.summary })),
          });
          for (const msg of tiered.memory.messages) {
            const conv = convMap.get(msg.conversationId);
            if (conv) {
              msg.url = conv.url || undefined;
              (msg as any).title = conv.title || conv.summary || undefined;
            }
          }
        }
      }
      console.log('[search-tiered] Message ranking after enrichment:',
            tiered.memory.messages.map((m: any) => ({
              title: (m as any).title?.substring(0, 50),
              similarity: m.similarity?.toFixed(3),
              preview: m.preview?.substring(0, 80),
              conversationId: m.conversationId?.substring(0, 12),
            }))
          );

      console.log(`[agent/search-tiered] Completed in ${tiered.meta.searchTimeMs}ms - ${tiered.meta.artifactCount} artifacts, ${tiered.meta.memoryCount} messages`);

      return res.json({
        ok: true,
        ...tiered
      });

    } catch (err: any) {
      console.error('[agent/search-tiered] Error:', err);
      return res.status(500).json({ 
        error: err?.message ?? 'Internal error' 
      });
    }
  });

  /**
  * POST /api/agent/summarize-conversation
  * Generates a structured summary + primer for a conversation using Claude Sonnet
  */
  router.post('/agent/summarize-conversation', async (req: Request, res: Response) => {
    try {
      const { conversationId, nextTitle } = req.body;

      if (!conversationId) {
        return res.status(400).json({ error: 'conversationId is required' });
      }

      // Fetch messages for the conversation
      const { data: messages, error: msgError } = await supabase
        .from('cb_messages')
        .select('role, content, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

      if (msgError) {
        return res.status(500).json({ error: 'Failed to fetch messages', detail: msgError.message });
      }

      if (!messages || messages.length === 0) {
        return res.status(404).json({ error: 'No messages found for this conversation' });
      }

      // Build transcript (cap at ~300 messages to avoid timeout)
      const cappedMessages = messages.slice(-300);
      const transcript = cappedMessages
        .map((m: any) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');

      const nextTitleClause = nextTitle
        ? `The user intends to start a new conversation titled: "${nextTitle}".`
        : 'The user is preparing to start a new conversation.';

      const prompt = `You are helping a user prepare a handoff between two AI conversations.

  ${nextTitleClause}

  Below is the full transcript of the conversation to summarize:

  <transcript>
  ${transcript}
  </transcript>

  Produce a structured output with exactly these four sections. Be precise and list relevant files, if any.

  ## Summary
  A detailed overview of what was discussed, including a list of any relevant files mentioned.

  ## Key Decisions
  A bullet list of concrete decisions, conclusions, or choices made.

  ## Open Items
  A bullet list of unresolved questions, pending tasks, or follow-up items.

  ## Primer for Next Conversation
  A ready-to-paste opening message the user can send at the start of the next conversation to provide full context. Write it in first person as if the user is speaking.`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 55000);

      const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 2500,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      clearTimeout(timeout);

      if (!claudeResponse.ok) {
        const errText = await claudeResponse.text().catch(() => '');
        return res.status(502).json({ error: 'Claude API error', detail: errText });
      }

      const claudeData = await claudeResponse.json() as { content?: Array<{ type: string; text: string }> };
      const raw = claudeData.content?.find((b: any) => b.type === 'text')?.text || '';

      // Parse the four sections out of the markdown response
      function extractSection(text: string, heading: string): string {
        const regex = new RegExp(`##\\s*${heading}\\s*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i');
        return text.match(regex)?.[1]?.trim() || '';
      }

      return res.json({
        ok: true,
        summary: extractSection(raw, 'Summary'),
        keyDecisions: extractSection(raw, 'Key Decisions'),
        openItems: extractSection(raw, 'Open Items'),
        primer: extractSection(raw, 'Primer for Next Conversation'),
      });

    } catch (err: any) {
      if (err.name === 'AbortError') {
        return res.status(504).json({ error: 'Claude API timed out' });
      }
      console.error('[summarize-conversation] Error:', err);
      return res.status(500).json({ error: err?.message ?? 'Internal error' });
    }
  });

  /**
   * DELETE /api/agent/conversation/:id
   * Deletes a conversation and all cascaded data (messages, embeddings)
   */
  router.delete('/agent/conversation/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({ error: 'Conversation ID is required' });
      }

      const { error } = await supabase
        .from('cb_conversations')
        .delete()
        .eq('id', id);

      if (error) {
        console.error('[delete-conversation] Supabase error:', error);
        return res.status(500).json({ error: 'Failed to delete conversation', detail: error.message });
      }

      console.log(`[delete-conversation] Deleted conversation ${id}`);
      return res.json({ ok: true });

    } catch (err: any) {
      console.error('[delete-conversation] Error:', err);
      return res.status(500).json({ error: err?.message ?? 'Internal error' });
    }
  });

  /**
 * GET /api/agent/conversation-by-url?url=
 * Looks up a cb_conversations row by its platform URL
 */
router.get('/agent/conversation-by-url', async (req: Request, res: Response) => {
  try {
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url query parameter is required' });
    }

    // Try exact match first
    let { data, error } = await supabase
      .from('cb_conversations')
      .select('id, title, summary, url')
      .eq('url', url)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: 'Database error', detail: error.message });
    }

    // Fallback: match on last path segment (conversation UUID)
    if (!data) {
      const segments = url.replace(/\/$/, '').split('/');
      const lastSegment = segments[segments.length - 1];
      if (lastSegment && lastSegment.length > 8) {
        const { data: fallbackData, error: fallbackError } = await supabase
          .from('cb_conversations')
          .select('id, title, summary, url')
          .ilike('url', `%${lastSegment}%`)
          .maybeSingle();
        if (!fallbackError) data = fallbackData;
      }
    }

    if (!data) {
      return res.status(404).json({ error: 'Conversation not found in ContextBridge' });
    }

    return res.json({ ok: true, conversation: data });

  } catch (err: any) {
    console.error('[conversation-by-url] Error:', err);
    return res.status(500).json({ error: err?.message ?? 'Internal error' });
  }
});

  return router;
}