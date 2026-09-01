// packages/backend/src/services/intent-parser.service.ts

import type { AgentPlan } from '../types/agent-dsl.types';
import { validateAgentPlan, EXAMPLE_PLANS } from '../types/agent-dsl.types';

// Re-export AgentPlan so other files can import it from here
export type { AgentPlan };

interface ParseResult {
  success: boolean;
  plan?: AgentPlan;
  error?: string;
  rawResponse?: string;
  source?: 'fast-path' | 'llm'; // Track which parser was used
}

// Cheap deterministic parser for common phrasing.
// Returns null when it can't confidently parse.
function fastPathPlan(instruction: string): Partial<AgentPlan> | null {
  if (!instruction) return null;
  const s = instruction.trim().toLowerCase();

  // ordinals and indices (0-BASED!)
  const ord: Record<string, number> = { 
    first: 0, second: 1, third: 2, fourth: 3, fifth: 4, 
    sixth: 5, seventh: 6, eighth: 7, ninth: 8, tenth: 9 
  };
  
  let idx: number | null = null;
  for (const [k, v] of Object.entries(ord)) {
    if (s.includes(`${k} result`)) { 
      idx = v; 
      break; 
    }
  }
  if (idx === null) {
    const m = s.match(/\bresults?\s+(\d+)\b/);
    if (m) idx = parseInt(m[1], 10) - 1; // Convert 1-based input to 0-based
  }

  // lines
  let firstN: number | null = null;
  let lineFrom: number | null = null;
  let lineTo: number | null = null;

  const mFirstN = s.match(/\bfirst\s+(\d+)\s+lines?\b/);
  if (mFirstN) firstN = parseInt(mFirstN[1], 10);

  const mRange = s.match(/\blines?\s+(\d+)\s*[-–]\s*(\d+)\b/);
  if (mRange) { 
    lineFrom = parseInt(mRange[1], 10); 
    lineTo = parseInt(mRange[2], 10); 
  }

  // intents: search_and_insert vs insert vs search
  const wantsInsert = /\binsert\b/.test(s);
  const wantsShow = /\bshow|preview|display\b/.test(s);
  const hasSearchTerms = /\bfind|get|search|locate\b/.test(s);

  // Extract potential search query (everything before "and insert/show")
  let searchQuery = '';
  const queryMatch = s.match(/(?:find|get|search|locate)\s+(.+?)(?:\s+and\s+(?:insert|show|preview)|\s*$)/);
  if (queryMatch) {
    searchQuery = queryMatch[1].trim();
  }

  // Common pattern: "insert first result", "insert entire message from the fifth result"
  if (wantsInsert && idx !== null) {
    const plan: Partial<AgentPlan> = {
      intent: hasSearchTerms ? 'search_and_insert' : 'insert',
      confidence: 0.8,
      search: {
        query: searchQuery || '',
        limit: 10
      },
      selection: { 
        strategy: 'specific_indices', 
        indices: [idx] 
      },
      transform: { mode: 'full' },
      action: { type: 'auto_insert', insertionPoint: 'cursor' }
    };
    
    if (firstN) {
      plan.transform = { mode: 'first_n_lines', lineRange: { first: firstN } };
    }
    if (lineFrom) {
      plan.transform = { mode: 'lines', lineRange: { start: lineFrom, end: lineTo ?? lineFrom } };
    }
    
    return plan;
  }

  // Pattern: "insert first N results titles/snippets"
  const mTopN = s.match(/\b(?:first|top)\s+(\d+)\s+results?\b/);
  if (wantsInsert && mTopN) {
    const n = parseInt(mTopN[2], 10);
    return {
      intent: hasSearchTerms ? 'search_and_insert' : 'insert',
      confidence: 0.7,
      search: {
        query: searchQuery || '',
        limit: Math.max(n, 20)
      },
      selection: { 
        strategy: 'top_n', 
        count: Math.max(1, Math.min(n, 10)) 
      },
      transform: { 
        mode: /title|snippet/.test(s) ? 'snippet' : 'full' 
      },
      action: { type: 'auto_insert', insertionPoint: 'cursor' }
    };
  }

    // Pattern: "show first 5 lines of the Nth result" (working with existing results)
    if (wantsShow && (firstN || idx !== null)) {
    return {
        intent: 'insert', // 'insert' intent when working with existing results (no search needed)
        confidence: 0.7,
        search: {
        query: '', // Empty query is OK for 'insert' intent
        limit: 10
        },
        selection: { 
        strategy: idx !== null ? 'specific_indices' : 'first',
        indices: idx !== null ? [idx] : undefined
        },
        transform: { 
        mode: 'first_n_lines', 
        lineRange: { first: firstN || 10 } 
        },
        action: { type: 'show_preview' }
    };
    }

  // No confident parse
  return null;
}

export class IntentParserService {
  private readonly anthropicApiKey: string;
  private readonly modelName = 'claude-opus-4-1-20250805';  // Changed to Opus 4.1

  constructor(apiKey?: string) {
    this.anthropicApiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
    if (!this.anthropicApiKey) {
      console.warn('⚠️  ANTHROPIC_API_KEY not set - intent parser will fallback to fast-path only');
    }
  }

  /**
   * Parse natural language instruction into structured AgentPlan
   */
  async parseInstruction(
    instruction: string,
    context?: {
      projectId?: string;
      userPreferences?: Record<string, any>;
      recentQueries?: string[];
      itemsMeta?: Array<{ index: number; title?: string; kind?: string; id?: string }>;
      modelName?: string;
      budgetTokens?: number;
    }
  ): Promise<ParseResult> {
    const startTime = Date.now();

    // 0) Fast-path: skip LLM for the easy 70% cases
    console.log('🔍 Attempting fast-path parse...');
    const quick = fastPathPlan(instruction);
    if (quick) {
      const planCandidate = this.fillPlanDefaults(quick, context?.budgetTokens);
      const validation = validateAgentPlan(planCandidate as AgentPlan);
      if (validation.valid) {
        console.log(`✅ Fast-path success in ${Date.now() - startTime}ms`);
        return { 
          success: true, 
          plan: planCandidate as AgentPlan, 
          rawResponse: '[fast-path]',
          source: 'fast-path'
        };
      } else {
        console.log('⚠️  Fast-path produced invalid plan, falling back to LLM');
      }
    }

    if (!this.anthropicApiKey) {
      return { 
        success: false, 
        error: 'ANTHROPIC_API_KEY not configured and fast-path failed' 
      };
    }

    const model = context?.modelName || this.modelName;
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(instruction, context);

    // 1) Call Anthropic with multi-attempt strategy
    console.log('🤖 Attempting LLM parse with multi-attempt strategy...');
    const attempts = [
      { temperature: 0.1, name: 'strict' },
      { temperature: 0.2, name: 'compact' },
      { temperature: 0.0, name: 'repair' }
    ];

    let lastError = '';
    for (const attempt of attempts) {
      try {
        console.log(`  → Attempt: ${attempt.name} (temp=${attempt.temperature})`);
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000); // 15s guard

        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.anthropicApiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model,
            max_tokens: 700,
            temperature: attempt.temperature,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }]
          })
        });

        clearTimeout(timeout);

        if (!resp.ok) {
          const errorText = await resp.text().catch(() => '');
          lastError = `Claude API ${resp.status}: ${errorText}`;
          console.warn(`  ✗ ${lastError}`);
          continue;
        }

        const data = await resp.json() as { content?: Array<{ text?: string }> };
        const rawResponse = data?.content?.[0]?.text ?? '';

        const plan = this.extractAndParseJSON(rawResponse);
        
        // Normalize and validate
        const normalized = this.fillPlanDefaults(plan, context?.budgetTokens);
        const validation = validateAgentPlan(normalized as AgentPlan);

        if (!validation.valid) {
          lastError = `Invalid plan structure: ${validation.errors.join(', ')}`;
          console.warn(`  ✗ ${lastError}`);
          continue;
        }

        console.log(`✅ LLM parse success (${attempt.name}) in ${Date.now() - startTime}ms`);
        return { 
          success: true, 
          plan: normalized as AgentPlan, 
          rawResponse,
          source: 'llm'
        };

      } catch (err: any) {
        lastError = err?.message || String(err);
        console.warn(`  ✗ Attempt failed: ${lastError}`);
        // Continue to next attempt
      }
    }

    console.error(`❌ All parsing attempts failed: ${lastError}`);
    return { 
      success: false, 
      error: lastError || 'Agent plan parsing failed after all attempts' 
    };
  }

  /**
   * Fill in missing defaults to ensure valid AgentPlan structure
   * This acts as a safety net for incomplete plans from any source
   */
  private fillPlanDefaults(plan: any, budgetHint?: number): AgentPlan {
    const p = { ...plan };

    // Intent & confidence
    if (typeof p.confidence !== 'number' || p.confidence < 0 || p.confidence > 1) {
      p.confidence = 0.6;
    }
    if (!p.intent) {
      p.intent = 'search_and_insert';
    }

    // Ensure search exists with required fields
    p.search = {
      query: p.search?.query || '',
      limit: p.search?.limit || 10,
      filters: p.search?.filters || {}
    };

    // Ensure selection exists with valid strategy
    if (!p.selection || !p.selection.strategy) {
      p.selection = { strategy: 'first' };
    }
    
    // Add defaults based on strategy
    if (p.selection.strategy === 'top_n' && !p.selection.count) {
      p.selection.count = 3;
    }
    if (p.selection.strategy === 'specific_indices' && !p.selection.indices) {
      p.selection.indices = [0];
    }

    // Ensure transform exists
    p.transform = {
      mode: p.transform?.mode || 'full',
      ...p.transform
    };

    // Output defaults
    p.output = {
      format: p.output?.format || 'markdown',
      includeMetadata: p.output?.includeMetadata ?? true,
      includeScores: p.output?.includeScores ?? false,
      separator: p.output?.separator || '\n\n---\n\n',
      ...p.output
    };

    // Budget defaults
    p.budget = {
      maxTokens: budgetHint || p.budget?.maxTokens,
      preferredTokens: p.budget?.preferredTokens,
      truncationStrategy: p.budget?.truncationStrategy || 'trim_end',
      ...p.budget
    };

    // Action defaults
    p.action = {
      type: p.action?.type || 'show_preview',
      insertionPoint: p.action?.insertionPoint || 'cursor',
      ...p.action
    };

    return p as AgentPlan;
  }

  /**
   * Build the system prompt that teaches Claude how to parse instructions
   */
  private buildSystemPrompt(): string {
    return `You are an intent parser for ContextBridge, a conversation search and context injection tool.

Your job is to convert natural language instructions into structured JSON plans following the AgentPlan schema.

# AgentPlan Schema

\`\`\`typescript
export interface AgentPlan {
  intent: 'search' | 'insert' | 'search_and_insert' | 'clarification_needed';
  confidence: number; // 0.0 - 1.0
  
  search: {
    query: string; // keywords for search
    filters?: {
      dateRange?: { from?: string; to?: string; relative?: string };
      fileTypes?: string[]; // ['.ts', '.py', '.pdf']
      conversationTitles?: string[];
      contentTypes?: ('message' | 'file' | 'block')[];
      entityTypes?: string[];
    };
    limit?: number;
  };
  
  selection: {
    strategy: 'first' | 'last' | 'all' | 'top_n' | 'specific_indices' | 'highest_scored';
    count?: number;
    indices?: number[]; // 0-based!
    scoreThreshold?: number;
  };
  
  transform: {
    mode: 'full' | 'snippet' | 'lines' | 'first_n_lines' | 'custom';
    lineRange?: { start?: number; end?: number; first?: number; last?: number };
    snippetContext?: number;
  };
  
  output: {
    format: 'plain' | 'markdown' | 'code_fence';
    includeMetadata: boolean;
    includeScores: boolean;
    separator?: string;
  };
  
  budget: {
    maxTokens?: number;
    preferredTokens?: number;
    truncationStrategy?: 'trim_end' | 'trim_start' | 'smart_summarize';
  };
  
  action: {
    type: 'auto_insert' | 'show_preview' | 'copy_to_clipboard';
    insertionPoint?: 'cursor' | 'end' | 'replace';
  };
  
  clarification?: {
    reason: string;
    suggestedQuestions: string[];
  };
}
\`\`\`

# Important Notes

- Indices are 0-BASED: "first result" = index 0, "second result" = index 1
- Only use 'auto_insert' if explicitly requested with words like "insert" or "paste"
- Default to 'show_preview' for ambiguous cases
- Extract clean keywords for search.query (remove filler words)
- Be conservative with token budgets

# Example Mappings

1. "find the last version of background.js and insert it"
   → { intent: 'search_and_insert', search: { query: 'background.js', filters: { contentTypes: ['file', 'block'] } }, selection: { strategy: 'last' }, transform: { mode: 'full' }, action: { type: 'auto_insert' } }

2. "get first 3 results for semantic search, show first 5 lines only"
   → { intent: 'search', search: { query: 'semantic search' }, selection: { strategy: 'top_n', count: 3 }, transform: { mode: 'first_n_lines', lineRange: { first: 5 } }, action: { type: 'show_preview' } }

3. "insert the second result"
   → { intent: 'insert', search: { query: '' }, selection: { strategy: 'specific_indices', indices: [1] }, transform: { mode: 'full' }, action: { type: 'auto_insert' } }

4. "find the most recent versions of background.js and content.js"
   → intent: 'search_and_insert'
   → search.query: 'background.js content.js'
   → search.filters.fileTypes: ['.js']
   → selection.strategy: 'top_n', count: 2  // ← Key: count=2 for two files
   → transform.mode: 'full'

  5. When the user mentions file names or extensions, populate search.filters.fileTypes and include a filenames hint array in the plan’s search (non-standard but allowed), e.g., search.filenames: ["background.js","content.js"].

# Response Format

Return ONLY a valid JSON object matching the AgentPlan schema. No markdown, no explanations, no code blocks.`;
  }

  /**
   * Build the user prompt with the instruction and context
   */
  private buildUserPrompt(
    instruction: string,
    context?: {
      projectId?: string;
      userPreferences?: Record<string, any>;
      recentQueries?: string[];
      itemsMeta?: Array<{ index: number; title?: string; kind?: string; id?: string }>;
      budgetTokens?: number;
    }
  ): string {
    const lines: string[] = [];
    lines.push(`Instruction: "${instruction}"`);

    if (context?.itemsMeta?.length) {
      // Give the model the visible list to map "second result" etc.
      const compact = context.itemsMeta.map(it => ({
        index: it.index,
        title: it.title || 'Untitled',
        kind: it.kind || 'message'
      }));
      lines.push(`\nAvailable results (0-indexed):\n${JSON.stringify(compact, null, 2)}`);
    }

    if (context?.budgetTokens) {
      lines.push(`\nToken budget: ${context.budgetTokens}`);
    }

    if (context?.userPreferences && Object.keys(context.userPreferences).length > 0) {
      lines.push(`\nUser preferences: ${JSON.stringify(context.userPreferences)}`);
    }

    if (context?.recentQueries?.length) {
      lines.push(`\nRecent queries: ${context.recentQueries.slice(0, 3).join(', ')}`);
    }

    lines.push(`\nRespond with ONLY a single JSON object. No markdown, no explanations.`);
    return lines.join('\n');
  }

  /**
   * Extract and parse JSON from Claude's response (handles markdown blocks)
   */
  private extractAndParseJSON(text: string): any {
    // Remove markdown code blocks if present
    let cleaned = text
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch (error) {
      // If parsing fails, try to find JSON object in the text
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error('Could not extract valid JSON from response');
    }
  }
}

// Singleton instance
let parserInstance: IntentParserService | null = null;

export function getIntentParser(): IntentParserService {
  if (!parserInstance) {
    parserInstance = new IntentParserService();
  }
  return parserInstance;
}