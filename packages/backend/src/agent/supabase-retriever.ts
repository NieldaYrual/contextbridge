// packages/backend/src/agent/supabase-retriever.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { 
  HybridRetriever, 
  RetrieveRequest, 
  QueryIntent,
  TieredSearchResponse, 
  ArtifactHit, 
  MemoryHit, 
  RetrieveLists 
} from './retriever.types';
import type { RankItem } from './rank-combiner';
import { getEmbeddingService } from '../services/embedding.service';
import { supabase } from '..';
import { SEARCH_CONFIG } from '../config/search-config';

// ============================================================================
// RETRIEVE CACHE - Deduplicates concurrent & recent identical searches
// ============================================================================
const retrieveCache = new Map<string, { promise: Promise<any>; timestamp: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds

function getOrCreateRetrieve(key: string, factory: () => Promise<any>): Promise<any> {
  const entry = retrieveCache.get(key);
  console.log('[retriever] Cache check:', { 
    keyLen: key.length, 
    keyHash: key.substring(0, 40) + '...' + key.substring(key.length - 20),
    hasEntry: !!entry, 
    entryAge: entry ? Date.now() - entry.timestamp : -1,
    ttl: CACHE_TTL_MS,
    allKeys: [...retrieveCache.keys()].map(k => k.length + ':' + k.substring(0, 50))
  });
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
    console.log('[retriever] Cache hit (dedup) for key:', key.substring(0, 60));
    return entry.promise;
  }

  const promise = factory();
  retrieveCache.set(key, { promise, timestamp: Date.now() });

  // Clean up on completion (keep result cached for TTL, but evict old entries)
  promise.finally(() => {
    if (retrieveCache.size > 50) {
      const now = Date.now();
      for (const [k, v] of retrieveCache) {
        if (now - v.timestamp > CACHE_TTL_MS) retrieveCache.delete(k);
      }
    }
  });

  return promise;
}

// ============================================================================
// AUTHORITY WEIGHTS - Code artifacts outrank chat messages
// ============================================================================
// Authority weights are now centralized in SEARCH_CONFIG.authority
const AUTHORITY = SEARCH_CONFIG.authority;

// ============================================================================
// RECENCY TIE-BREAKER - When scores are similar, prefer newer content
// ============================================================================
const RECENCY_THRESHOLD = SEARCH_CONFIG.recency.threshold;

/**
 * Compare two items for sorting: by score first, then by recency if scores are similar (LIFO)
 */
function compareWithRecency(
  a: { score: number; updated_at: string | null },
  b: { score: number; updated_at: string | null }
): number {
  const scoreDiff = b.score - a.score; // Higher score first
  
  // If scores differ significantly, sort by score
  if (Math.abs(scoreDiff) > RECENCY_THRESHOLD) {
    return scoreDiff;
  }
  
  // Scores are similar - use recency as tie-breaker (newer first)
  const aTime = a.updated_at ? new Date(a.updated_at).getTime() : 0;
  const bTime = b.updated_at ? new Date(b.updated_at).getTime() : 0;
  
  return bTime - aTime; // Newer first
}

// ============================================================================
// TYPES
// ============================================================================

type FileRow = {
  path: string;
  filename: string | null;
  dir: string | null;
  score: number | null;
  updated_at: string | null;
};

type SpanRow = {
  path: string;
  start_line: number;
  end_line: number;
  snippet: string;
  score: number | null;
  updated_at: string | null;
};

type FileHit = {
  kind: 'file';
  id: string;
  path: string;
  filename: string | null;
  updated_at: string | null;
  similarity: number;
  preview?: string;
  meta?: Record<string, any>;
};

type SpanHit = {
  kind: 'span';
  path: string;
  start_line: number;
  end_line: number;
  similarity: number;
  preview: string;
  meta?: Record<string, any>;
};

const RETRIEVER_TAG = '[retriever]';

// ============================================================================
// INTENT DETECTION — Phase 1: Structural Pattern Detection
// ============================================================================

/**
 * Detects the user's intent from their query using structural patterns.
 * 
 * Philosophy: Use domain-agnostic *shapes* (camelCase, file extensions, 
 * domain names, addresses) rather than vocabulary lists. This generalizes
 * across project types (code, real estate, finance, legal) without
 * per-domain keyword maintenance.
 * 
 * Phase 2 (future): Late-bind refinedIntent from retrieval evidence in
 * toTieredResponse, using file/message score margins and type ratios.
 * 
 * - code_seeking: Query contains code-shaped tokens (symbols, paths, extensions)
 * - memory_seeking: Query contains entity patterns (domains, addresses, proper nouns)
 * - general: No strong structural signal — safe default, soft message penalty only
 * 
 * Guardrails:
 * - Memory phrases (remember, you said) are suppressed when code structural 
 *   signals are present, preventing "you said where is fetchEntities" → memory
 * - Minimum evidence gate: winner must score >= MIN_WINNER_SCORE (absolute)
 * - Dominance threshold: winner must outscore loser by DOMINANCE_THRESHOLD ratio
 */
function detectQueryIntent(query: string): QueryIntent {
  const q = query.toLowerCase();

  // ── Structural code signals (domain-agnostic patterns) ──────────────
  let codeStructural = 0;  // Tracks structural-only code score (for memory suppression)

  const hasCamelCase    = /[a-z][A-Z]/.test(query);                              // fetchEntities
  const hasSnakeCase    = /[a-z]_[a-z]/.test(query);                             // cb_search_entities
  const hasPascalCase   = /\b[A-Z][a-z]+[A-Z]/.test(query);                     // FileContentFetcher
  const hasDotNotation  = /[a-z]\.[a-z]+\(/i.test(query);                       // supabase.rpc(
  const hasFileExt      = /\b[\w-]+\.(ts|js|tsx|jsx|py|go|rs|sql|java|cs|php|rb)\b/i.test(query);
  const hasRepoPath     = /\b(src|packages|backend|frontend|routes|components|services|lib)\//i.test(query);
  const hasCbPrefix     = /\bcb_/.test(q);                                       // cb_entities

  if (hasCamelCase)    codeStructural += 3;
  if (hasSnakeCase)    codeStructural += 3;
  if (hasPascalCase)   codeStructural += 2;
  if (hasDotNotation)  codeStructural += 3;
  if (hasFileExt)      codeStructural += 3;
  if (hasRepoPath)     codeStructural += 2;
  if (hasCbPrefix)     codeStructural += 3;

  let codeScore = codeStructural;

  // Minimal universal code keywords (weight 1 — weak nudge, not hard flip)
  const codeKeywords: [string, number][] = [
    ['function ', 1], ['class ', 1], ['implementation', 1],
    ['stack trace', 1], ['error message', 1], ['debug', 1],
    ['import ', 1], ['export ', 1], ['source code', 1], ['codebase', 1],
  ];

  for (const [kw, weight] of codeKeywords) {
    if (q.includes(kw)) codeScore += weight;
  }

  // ── Structural memory signals (domain-agnostic patterns) ────────────
  let memoryScore = 0;

  // Domain names (ctxbridge.io, google.com) — strong memory signal
  const hasDomain = /\b[\w-]+\.(com|io|org|net|dev|app|co|edu|gov)\b/i.test(query);
  if (hasDomain) memoryScore += 3;

  // Street addresses (3620 Clay Street, 1970 Jackson Ave) — strong memory signal
  const hasAddress = /\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Dr(?:ive)?|Rd|Way|Ln|Ct|Pl(?:ace)?|Cir(?:cle)?)\b/.test(query);
  if (hasAddress) memoryScore += 3;

  // Proper noun phrases: 2+ capitalized words NOT at the very start of the query
  // Skip common question starters (What, Where, How, When, Who, Which, Is, Are, Do, Does, Can, Could, Should, Will)
  const properNounPattern = /(?:^.+?\s)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/;
  const properNounMatch = properNounPattern.exec(query);
  if (properNounMatch) {
    const matched = properNounMatch[1];
    // Exclude common false positives that start sentences
    const falsePositives = ['Source Files', 'Search Results', 'How Does', 'What Is', 'Where Is'];
    if (!falsePositives.some(fp => matched.startsWith(fp))) {
      memoryScore += 2;
    }
  }

  // Quoted strings (3+ chars) — user is searching for specific content
  const hasQuotedString = /["']([^"']{3,})["']/.test(query);
  if (hasQuotedString) memoryScore += 2;

  // Temporal phrases — strong memory signal
  const hasTemporalPhrase = /\b(yesterday|last\s+(?:week|month|year)|earlier|previously|recently)\b/i.test(q);
  if (hasTemporalPhrase) memoryScore += 2;

  // Memory phrases — only counted when NO code structural evidence present
  // This prevents "you said where is fetchEntities" from flipping to memory
  if (codeStructural === 0) {
    const memoryPhrases: [string, number][] = [
      ['discussed', 2], ['conversation', 2], ['remember', 2],
      ['summarize', 2], ['summary', 2], ['you said', 2],
      ['told me', 2], ['we agreed', 2], ['we decided', 2],
      ['talked about', 2], ['mentioned', 2], ['recall', 2],
    ];

    for (const [phrase, weight] of memoryPhrases) {
      if (q.includes(phrase)) memoryScore += weight;
    }
  }

  // ── Decision with guardrails ────────────────────────────────────────
  const DOMINANCE_THRESHOLD = 1.5;
  const MIN_WINNER_SCORE = 3;  // Prevents low-confidence flips from noise

  const codeRatio = codeScore / Math.max(memoryScore, 1);
  const memoryRatio = memoryScore / Math.max(codeScore, 1);

  if (codeRatio >= DOMINANCE_THRESHOLD && codeScore >= MIN_WINNER_SCORE) {
    return 'code_seeking';
  } else if (memoryRatio >= DOMINANCE_THRESHOLD && memoryScore >= MIN_WINNER_SCORE) {
    return 'memory_seeking';
  } else {
    return 'general';
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function cleanPath(p: string | undefined): string {
  return (p || '').replace(/^['"`]+|['"`]+$/g, '');
}

/**
 * Detects if a path is a msg_* conversation snippet file
 */
function isMessageSnippet(path: string): boolean {
  const p = path.toLowerCase();
  return /^msg_[a-f0-9-]+_\d+\./i.test(p) || 
         p.startsWith('msg_') || 
         p.includes('/msg_') ||
         p.includes('conversation:');
}

function extractIdentifierLikeTokens(q: string): string[] {
  const s = String(q || '');
  const tokens = s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [];
  // Prefer camelCase / snake_case / TitleCase / dotted identifiers (cb_search_exact-like)
  const strong = tokens.filter(t =>
    /[a-z][A-Z]/.test(t) ||               // camelCase
    /_/.test(t) ||                        // snake_case
    /^[A-Z][a-z]+[A-Za-z0-9]+$/.test(t) ||// TitleCase-ish
    /^cb_[a-z0-9_]+$/i.test(t)
  );
  return Array.from(new Set(strong));
}

/**
 * Extract "path-worthy" tokens from a natural language query.
 * These are tokens likely to appear in file paths/names.
 */
function extractPathTokens(query: string): string[] {
  const PATH_STOPWORDS = new Set([
    // question words / helpers
    'what','where','when','which','how','does','have','this','that','with',
    // common verbs / filler
    'currently','structured','making','handled','being','using','find','show',
    'done','used','work','works','working','make','made','called','looking',
    // articles/prepositions
    'from','into','about','between','through','after','before',
    // filler nouns (too generic)
    'file','files','code','function','method','class','component',
    'please','would','could','should','there','their','these','those',
    'some','also','just','like','very','most','more','than',
  ]);

  const raw = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);

  const norm = raw
    .map(t => {
      let stem = t;
      // light plural normalization: scripts -> script, routes -> route
      if (stem.length >= 5 && stem.endsWith('s')) stem = stem.slice(0, -1);
      // -ing normalization: ranking -> rank, seeking -> seek, embedding -> embedd
      // Only when stem ≥ 4 chars and ends in consonant (avoids "thing→th", "string→str")
      if (stem.length >= 7 && stem.endsWith('ing')) {
        const candidate = stem.slice(0, -3);
        if (candidate.length >= 4 && !/[aeiou]/.test(candidate[candidate.length - 1])) {
          stem = candidate;
        }
      }
      return stem;
    })
    .filter(t => t.length >= 4)
    .filter(t => !PATH_STOPWORDS.has(t))
    .filter(t => !/^\d+$/.test(t)); // drop pure numbers here (addresses handled separately)

  // Deduplicate while preserving order
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of norm) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 6) break; // cap tokens to keep RPC fast
  }

  return out;
}

function isIdentifierQuery(q: string): boolean {
  return extractIdentifierLikeTokens(q).length > 0;
}

function isAuthQuery(q: string): boolean {
  const s = (q || '').toLowerCase();
  return /auth|authentication|jwt|bearer|token|session|login|logout/.test(s);
}

function isDbQuery(q: string): boolean {
  const s = (q || '').toLowerCase();
  return /database|db\b|postgres|pg\b|supabase|createclient|connection|pool|dsn/.test(s);
}

function applyDomainPriors(path: string, query: string, score: number): number {
  const p = String(path || '').toLowerCase();
  const q = String(query || '').toLowerCase();

  const isAuth = /auth|authentication|jwt|bearer|token|session|login|logout/.test(q);
  const isDb = /database|db\b|postgres|pg\b|supabase|createclient|connection|pool|dsn/.test(q);

  if (isAuth) {
    // Positive priors
    if (
      p.includes('/auth.') ||
      p.includes('auth.routes') ||
      p.includes('auth.service') ||
      p.includes('auth.middleware')
    ) {
      score *= 1.55;
    }

    // Negative priors (common distractors)
    if (p.includes('container-deploy') || p.includes('deploy') || p.includes('docker') || p.includes('lightsail')) {
      score *= 0.75;
    }
  }

  if (isDb) {
    if (
      p.endsWith('/supabase.ts') ||
      p.includes('supabase.ts') ||
      p.includes('/db/') ||
      p.includes('database') ||
      p.includes('postgres')
    ) {
      score *= 1.45;
    }
  }

  return score;
}

/**
 * Detects garbage file paths/names that leaked through ingestion.
 * Returns { garbage: true, reason } if the hit should be dropped.
 * When debug=true, caller should log provenance for later ingestion fixes.
 */
function isGarbageFileHit(path: string, name: string | null): { garbage: boolean; reason?: string } {
  // A. Template literal fragment
  if (path.includes('${')) {
    return { garbage: true, reason: `garbage_path_template: "${path}"` };
  }

  // B. Optional chaining / JS expression
  if (path.includes('?.')) {
    return { garbage: true, reason: `garbage_path_expression: "${path}"` };
  }
  if (/\w+\[[^\]]*\]/.test(path)) {
    return { garbage: true, reason: `garbage_path_js_access: "${path}"` };
  }

  // C. Double-slash prefix (not a real relative or absolute path)
  if (path.startsWith('//') || path.startsWith('\\\\')) {
    return { garbage: true, reason: `garbage_path_double_slash: "${path}"` };
  }

  // D. Whitespace or newlines in path
  if (/[\n\r\t]/.test(path) || path !== path.trim()) {
    return { garbage: true, reason: `garbage_path_whitespace: "${path}"` };
  }

  // E. Name contains code fragments
  if (name && (name.includes('${') || name.includes('?.'))) {
    return { garbage: true, reason: `garbage_name_template: "${name}"` };
  }

  return { garbage: false };
}

/**
 * Detects garbage/artifact paths from broken indexing
 * These are code variables or parsing artifacts, not real files
 */
function isGarbagePath(p: string): boolean {
  if (!p || p === 'unknown' || p.trim() === '') return true;

  // Catches ${item.title, ${chunk.filePath, etc.
  if (p.includes('${')) return true;
  
  // Regex fragments indexed as paths (e.g., "|code|logic|implement)\\b/i.test")
  if (p.includes('|') || p.includes('\\b') || p.includes('\\s')) return true;
  
  // Parentheses/brackets — not real file paths
  if (/[()[\]{}]/.test(p)) return true;
  
  // Code variable artifacts (e.g., 'item.source', 'r.source', 'file.path')
  if (/^[a-z_$][a-z0-9_$]*\.[a-z_$][a-z0-9_$]*$/i.test(p)) return true;
  
  // Specific known garbage patterns
  if (p.includes('item.source') || p.includes('r.source') || p.includes('file.path')) return true;
  
  // Source maps, node_modules, and conversation captures
  if (p.endsWith('.map') || p.includes('node_modules') || p.includes('/captures/')) return true;
  
  // Paths that are too short to be real files (e.g., 'a', 'b.c')
  if (p.length < 5 && !p.includes('/')) return true;
  
  // Paths starting with non-alphanumeric (except ./ ../ / ~)
  if (/^[^a-zA-Z0-9.~/\\]/.test(p)) return true;
  
  return false;
}

/**
 * Detects if a snippet is purely boilerplate (imports/exports)
 */
function isBoilerplate(text: string): boolean {
  if (!text) return false;
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  if (lines.length === 0) return false;

  // If >80% of lines start with import/export, it's boilerplate
  const boilerLines = lines.filter(l =>
    l.startsWith('import ') ||
    l.startsWith('export ') ||
    l.startsWith('package ') ||
    l.startsWith('include ') ||
    l.startsWith('require(') ||
    l.startsWith('from ') ||
    l.startsWith('using ')
  ).length;

  return (boilerLines / lines.length) > 0.8;
}

function looksRoutey(q: string): boolean {
  return /\b(endpoint|route|path|api)\b/i.test(q) || /\/[a-z0-9/_:-]+/i.test(q);
}

function opFilters(path: string, ops: RetrieveRequest['operators']) {
  const p = path.toLowerCase();

  // HARD FILTERS: file & path
  if (ops?.file?.length) {
    const files = ops.file.map(s => s.toLowerCase());
    if (!files.some(f => p.endsWith(f))) return { pass: false, boosts: {} };
  }
  if (ops?.path?.length) {
    const prefixes = ops.path.map(s => s.toLowerCase());
    if (!prefixes.some(pref => p.includes(pref))) return { pass: false, boosts: {} };
  }

  // Type-based gating (project-agnostic)
  const want = new Set((ops?.type ?? []).map(t => t.toLowerCase()));
  if (want.size) {
    const codeExts = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'cs', 'php', 'rb', 'kt', 'c', 'cc', 'cpp', 'h', 'hpp', 'html', 'css', 'json', 'sql', 'yaml', 'yml']);
    const docExts = new Set(['md', 'markdown', 'txt', 'pdf', 'docx', 'csv', 'xlsx', 'xls', 'json', 'yaml', 'yml', 'unknown']);
    const ext = p.split('.').pop() || '';

    const wantsDocOnly = [...want].every(t => t === 'document' || t === 'data' || t === 'text');
    const wantsCodeOnly = [...want].every(t => t === 'code');

    if (wantsDocOnly && !docExts.has(ext)) return { pass: false, boosts: {} };
    if (wantsCodeOnly && !codeExts.has(ext)) return { pass: false, boosts: {} };
  }

  // SOFT BOOSTS
  const boosts: Record<string, number> = {};
  if (ops?.file?.length && ops.file.some(f => p.endsWith(f.toLowerCase()))) boosts.filenameMatch = 1;
  if (ops?.path?.length && ops.path.some(pref => p.includes(pref.toLowerCase()))) boosts.pathMatch = 0.8;

  // Context shoves
  if (/\b(extension|chrome)\b/i.test((ops as any)?.__q || '')) {
    if (p.includes('chrome-extension') || p.includes('content-simple.js')) {
      boosts.pathMatch = Math.max(boosts.pathMatch ?? 0, 1.0);
    }
  }
  if ((ops?.type ?? []).some(t => ['document', 'data', 'text'].includes(t.toLowerCase()))) {
    boosts.docHit = Math.max(boosts.docHit ?? 0, 0.6);
  }

  return { pass: true, boosts };
}

function normalize0to1<T extends { score: number | null }>(rows: T[]): T[] {
  const vals = rows.map(r => r.score ?? 0);
  const max = Math.max(1e-6, ...vals);
  if (max <= 0) return rows.map(r => ({ ...r, score: 0 })) as T[];
  return rows.map(r => ({ ...r, score: (r.score ?? 0) / max })) as T[];
}

function extractLiterals(q: string): string[] {
  const add: string[] = [];
  // renderer/pack UI tokens
  if (/\b(render|renderer|pack|context pack)\b/i.test(q)) {
    add.push('showPack(');
    add.push('renderSubquestionHTML');
    add.push('#cb-result');
    add.push('#cb-paste');
    add.push('#cb-answer');
    add.push('content-simple.js');
  }
  // quoted phrases
  for (const m of q.matchAll(/"([^"]+)"/g)) add.push(m[1]);
  return Array.from(new Set(add)).slice(0, 10);
}

/**
 * Apply intent-based similarity adjustment to a file.
 * 
 * All multiplier values live in SEARCH_CONFIG.intentPenalties — this function
 * only contains pattern matching logic.
 * 
 * Design contract (Phase 2):
 * - code_seeking: aggressive suppression of non-code files
 * - memory_seeking: boost conversations, suppress code files
 * - general: soft message penalty ONLY — never hard exclusion, so that
 *   code/file candidates survive for late-bind refinedIntent to re-rank
 */
function applyIntentPenalty(
  baseSimilarity: number,
  path: string,
  intent: QueryIntent,
  query: string
): number {
  let sim = baseSimilarity;
  const p = path.toLowerCase();
  const isMsg = isMessageSnippet(path);
  const qLower = query.toLowerCase();

  const { codeSeeking, memorySeeking, general } = SEARCH_CONFIG.intentPenalties;

  if (intent === 'code_seeking') {
    // === MODE: CODE (Strict) ===

    // 1. Ghost Files: heavily suppress msg_* files
    if (isMsg) {
      sim *= codeSeeking.messageSnippet;
    }

    // 2. Test files: suppress unless explicitly searching for tests
    if (!qLower.includes('test') && !qLower.includes('spec')) {
      if (p.includes('.test.') || p.includes('.spec.') || p.includes('/tests/') || 
          p.includes('__tests__') || p.includes('test-') || p.includes('-test.') || 
          p.startsWith('test_') || p.includes('_test.')) {
        sim *= codeSeeking.testFile;
      }
    }

    // 3. Type definition files: usually not what users want for "how does X work"
    if (p.endsWith('.types.ts') || p.endsWith('.d.ts') || p.includes('/types/')) {
      sim *= codeSeeking.typeDefinition;
    }

    // 4. Debug files: suppress unless explicitly searching for debug
    if (!qLower.includes('debug')) {
      if (p.includes('debug-') || p.includes('debug.') || p.startsWith('debug')) {
        sim *= codeSeeking.debugFile;
      }
    }

    // 5. Archive/old directories: strong penalty (likely outdated)
    if (p.includes('/archive/') || p.includes('/old/') || p.includes('/deprecated/') || 
        p.includes('/backup/')) {
      sim *= codeSeeking.archivedFile;
    }

    // 6. Vendor/library files: strong penalty (not user's code)
    if (p.includes('/vendor/') || p.includes('node_modules') || p.includes('.min.')) {
      sim *= codeSeeking.vendorFile;
    }

  } else if (intent === 'memory_seeking') {
    // === MODE: MEMORY (Boost conversations) ===

    // 1. Ghost Files: boost — user wants conversation history
    if (isMsg) {
      sim *= memorySeeking.messageSnippet;
    }

    // 2. Source code files: suppress (user wants discussions, not code)
    const codeExts = ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'cs', 'php', 'rb'];
    const ext = p.split('.').pop() || '';
    if (codeExts.includes(ext)) {
      sim *= memorySeeking.codeFile;
    }

  } else {
    // === MODE: GENERAL (Balanced) ===
    // Phase 2 contract: general must stay soft (never hard exclusion) so that
    // code/file candidates survive for late-bind refinedIntent to re-rank.

    // 1. Ghost Files: moderate penalty to prefer real files when available
    if (isMsg) {
      sim *= general.messageSnippet;
    }

    // 2. No other penalties — let semantic similarity decide
  }

  return sim;
}


function isLikelyThirdPartyBundle(path: string): boolean {
  const p = String(path || '').toLowerCase();

  // Minified / bundled assets + common vendor output directories
  if (p.endsWith('.min.js')) return true;

  // Avoid hardcoding libraries; instead use structural signals
  if (p.includes('/node_modules/')) return true;
  if (p.includes('/vendor/')) return true;
  if (p.includes('/dist/')) return true;
  if (p.includes('/build/')) return true;
  if (p.includes('/lib/')) return true;

  // If it's in public and looks like a bundled asset, treat as likely vendor
  if (p.includes('/public/') && (p.endsWith('.js') || p.endsWith('.css'))) return true;

  return false;
}

function tokenizeForOverlap(s: string): Set<string> {
  return new Set(
    String(s || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter(t => t.length >= 4) // ignore tiny tokens (js, ts, etc.)
  );
}

function fileHasQueryOverlap(path: string, query: string): boolean {
  const qTok = tokenizeForOverlap(query);
  const base = String(path || '').split('/').pop() || String(path || '');
  const fTok = tokenizeForOverlap(base);

  for (const t of fTok) {
    if (qTok.has(t)) return true;
  }
  return false;
}

/**
 * Penalize vendor/minified bundles unless the user actually mentions the library/file.
 * This avoids hardcoding "cytoscape" and generalizes to any vendor bundle.
 */
function applyBundlePenalty(path: string, query: string, score: number): number {
  if (!isLikelyThirdPartyBundle(path)) return score;

  // If the query explicitly references the bundle/library/file, don't penalize.
  if (fileHasQueryOverlap(path, query)) return score;

  return score * 0.15;
}

function applyIdentifierDominance(
  path: string,
  query: string,
  score: number,
  ctx: { source: string; boosts: Record<string, any> }
): number {
  const hasIdentifier =
    /[a-z][A-Z]/.test(query) || /[a-z]_[a-z]/.test(query) || /\bcb_[a-z0-9_]+\b/i.test(query);
  if (!hasIdentifier) return score;

  const src = (ctx.source || '');
  const b = ctx.boosts || {};
  const { identifierDominance } = SEARCH_CONFIG;

  const hasSymbol = !!b.symbolHit || src.includes('cb_match_symbols');
  const symbolScore = Number(b.symbolScore ?? 0);
  const hasBm25 = !!b.bm25Hit || src.includes('cb_search_chunks_keyword');
  const filenameOnly = !!b.filenameMention && !hasSymbol && !hasBm25;

  if (hasSymbol) {
    // Strong symbol match (exact function name) vs weak (different symbol in same file)
    const multiplier = symbolScore >= identifierDominance.symbolThreshold
      ? identifierDominance.symbolHit
      : identifierDominance.symbolWeak;
    return score * multiplier;
  }
  if (hasBm25) return score * identifierDominance.bm25Hit;
  if (filenameOnly) return score * identifierDominance.filenameOnly;
  return score * identifierDominance.noEvidence;
}

// ============================================================================
// MAIN RETRIEVER CLASS
// ============================================================================

export class SupabaseRetriever implements HybridRetriever {
  constructor(private sb: SupabaseClient) {}

  private async rpcFileSearch(
    supabase: any,
    projectId: string,
    query: string,
    queryVec: number[],
    topK: number,
    intent: 'code_seeking' | 'memory_seeking' | 'general'
  ): Promise<FileHit[]> {
    const qvecText = `[${queryVec.join(',')}]`;

    console.log(`[retriever] rpcFileSearch: intent=${intent}, project=${projectId}, topK=${topK}`);

    // ── 1. CALL BOTH RPCs IN PARALLEL ──────────────────────────────
    // Intent is a weighting signal, not a routing gate.
    // Chunks give precision (function-level); file embeddings give breadth (whole-file context).

    const chunkPromise = supabase.rpc('cb_search_codex_vectors', {
      p_project_id: projectId,
      p_query_vec: qvecText,
      p_limit: topK,
      p_query_text: query
    })
    .then((res: any) => {
      if (res.error) {
        console.warn('[retriever] cb_search_codex_vectors error:', res.error.message);
        return [];
      }
      console.log(`[retriever] cb_search_codex_vectors: ${res.data?.length ?? 0} results`);
      return res.data ?? [];
    }).catch((e: any) => {
      console.warn('[retriever] cb_search_codex_vectors threw:', e);
      return [];
    });

    const filePromise = supabase.rpc('search_knowledge_artifacts', {
      p_project_id: projectId,
      p_query_vec_text: qvecText,
      p_top_k: topK,
    }).then((res: any) => {
      if (res.error) {
        console.warn('[retriever] search_knowledge_artifacts error:', res.error.message);
        return [];
      }
      console.log(`[retriever] search_knowledge_artifacts: ${res.data?.length ?? 0} results`);
      return res.data ?? [];
    }).catch((e: any) => {
      console.warn('[retriever] search_knowledge_artifacts threw:', e);
      return [];
    });

    let [chunkRows, fileRows] = await Promise.all([chunkPromise, filePromise]);

    // ── 2. FALLBACK: If both empty, try legacy ─────────────────────
    if (chunkRows.length === 0 && fileRows.length === 0) {
      console.warn('[retriever] Both RPCs empty, trying legacy search_file_embeddings_v2...');
      try {
        const { data, error } = await supabase.rpc('search_file_embeddings_v2', {
          p_project_id: projectId,
          p_query_vec_text: qvecText,
          p_top_k: topK,
        });
        if (!error && data?.length) {
          const hits = this.mapRpcResults(data);
          hits.forEach(h => { h.meta = { ...h.meta, source: 'rpc:search_file_embeddings_v2' }; });
          return hits;
        }
      } catch (e) {
        console.error('[retriever] All file search RPCs failed:', e);
      }
      return [];
    }

    // ── 3. COLLAPSE CHUNKS TO FILE-LEVEL (max similarity per path) ─
    const chunkFileMap = new Map<string, { similarity: number; row: any }>();
    for (const r of chunkRows) {
      const path = r.file_path || '(unknown)';
      const sim = r.similarity ?? 0;
      const existing = chunkFileMap.get(path);
      if (!existing || sim > existing.similarity) {
        chunkFileMap.set(path, { similarity: sim, row: r });
      }
    }

    console.log(`[retriever] Chunks collapsed: ${chunkRows.length} chunks → ${chunkFileMap.size} files`);

    // ── 4. MERGE: file embeddings + collapsed chunks ───────────────
    // For files in both sets, take the higher similarity.
    const mergedMap = new Map<string, FileHit>();

    // Add file embedding results first
    for (const r of fileRows) {
      const path = r.path || r.file_path || '(unknown)';
      const filename = r.filename || (path.includes('/') ? path.split('/').pop() : path);
      const hit: FileHit = {
        kind: 'file',
        id: r.file_id || r.chunk_id || path,
        path,
        filename: filename ?? null,
        similarity: r.similarity ?? 0,
        preview: r.chunk_text || r.snippet ? `...${(r.chunk_text || r.snippet).substring(0, 300)}...` : undefined,
        updated_at: r.updated_at || new Date().toISOString(),
        meta: { source: 'rpc:search_knowledge_artifacts' }
      };
      mergedMap.set(path, hit);
    }

    // Merge chunk results — keep higher similarity
    for (const [path, { similarity, row }] of chunkFileMap) {
      const filename = path.includes('/') ? path.split('/').pop() : path;
      const existing = mergedMap.get(path);

      if (!existing || similarity > existing.similarity) {
        mergedMap.set(path, {
          kind: 'file',
          id: row.chunk_id || path,
          path,
          filename: filename ?? null,
          similarity,
          preview: row.snippet ? `...${row.snippet.substring(0, 300)}...` : undefined,
          updated_at: row.updated_at || existing?.updated_at || new Date().toISOString(),
          meta: { source: 'rpc:cb_search_codex_vectors' }
        });
      } else if (existing && !existing.meta?.chunkSimilarity) {
        // File embedding won, but note the chunk score for debugging
        existing.meta = { ...existing.meta, chunkSimilarity: similarity };
      }
    }

    const merged = Array.from(mergedMap.values())
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

    console.log('[retriever] rpcFileSearch merged:', {
      chunkFiles: chunkFileMap.size,
      fileEmbeddings: fileRows.length,
      merged: merged.length,
      top3: merged.slice(0, 3).map(h => ({
        path: h.path,
        sim: h.similarity?.toFixed(4),
        src: h.meta?.source
      }))
    });

    return merged;
  }

  // Helper to normalize different RPC return shapes
  private mapRpcResults(data: any[]): FileHit[] {
      return (data || []).map((r: any) => ({
        kind: 'file',
        id: r.file_id || r.chunk_id,
        path: r.path || r.file_path || '(unknown)',
        filename: r.filename || (r.file_path ? r.file_path.split('/').pop() : null),
        similarity: r.similarity,
        startLine: r.start_line,
        endLine: r.end_line,
        preview: r.chunk_text || r.snippet ? `...${(r.chunk_text || r.snippet).substring(0, 300)}...` : undefined,
        updated_at: r.updated_at || new Date().toISOString()
      }));
  }

  async retrieve(req: RetrieveRequest) {
    const { projectId, query, codexProjectIds } = req;
    // Normalize cache key: use effective code project (falls back to projectId if no codex)
    const effectiveCodeProject = (codexProjectIds && codexProjectIds.length > 0) 
      ? codexProjectIds[0] 
      : projectId;
    const cacheKey = `${projectId}:${query}:${(codexProjectIds || []).sort().join(',')}`;
    
    console.log('[retriever] retrieve() called — cacheKey:', cacheKey, 'cacheSize:', retrieveCache.size);
    
    return getOrCreateRetrieve(cacheKey, () => this._doRetrieve(req));
  }

  private async _doRetrieve(req: RetrieveRequest) {
    const t0 = Date.now();
    const { projectId, query, codexProjectIds } = req;
    
    console.log('[retriever] Starting retrieve for project:', projectId);

    // Determine which project to use for code searches
    // Use first Codex project as primary, but track all for multi-project search
    const codeProjectId = (codexProjectIds && codexProjectIds.length > 0) 
      ? codexProjectIds[0] 
      : projectId;
    const allCodeProjectIds = (codexProjectIds && codexProjectIds.length > 1)
      ? [...new Set(codexProjectIds)]
      : [codeProjectId];
    
    const usingDifferentCodeProject = codeProjectId !== projectId;
    if (usingDifferentCodeProject) {
      console.log(`[retriever] Using separate Codex project for code: ${codeProjectId}`);
    }

    // === INTENT DETECTION ===
    const intent = detectQueryIntent(query);
    console.log(`[retriever] Detected intent: ${intent} for query: "${query.substring(0, 50)}..."`);

    // ---------- EXACT STRING SEARCH (for camelCase, snake_case, quoted strings) ----------
    const isExactCandidate = /[a-z][A-Z]/.test(query) || /[a-z]_[a-z]/.test(query) || query.includes('"');
    let exactResults: Array<{ source_type: string; source_id: string; conversation_id: string | null; content_snippet: string; created_at: string; score: number }> = [];

    if (isExactCandidate) {
      const cleanQuery = query.replace(/"/g, '');  // Remove quotes for ILIKE
      try {
        const exactRes = await this.sb.rpc('cb_search_exact', {
          p_project_id: projectId,
          p_query: cleanQuery,
          p_limit: 10,
        });
        if (exactRes?.data) {
          exactResults = exactRes.data;
          console.log('[retriever] cb_search_exact completed:', exactResults.length, 'hits');
        }
        // Also search Codex project if different
        if (codeProjectId !== projectId) {
          const exactCodeRes = await this.sb.rpc('cb_search_exact', {
            p_project_id: codeProjectId,
            p_query: cleanQuery,
            p_limit: 10,
          });
          if (exactCodeRes?.data) {
            exactResults = [...exactResults, ...exactCodeRes.data];
            console.log('[retriever] cb_search_exact (codex):', exactCodeRes.data.length, 'hits');
          }
        }
      } catch (e) {
        console.warn('[retriever] cb_search_exact failed:', e);
      }
    }

    // For the panel
    let topFilesForUi: { path: string; filename: string | null; similarity: number }[] = [];
    let bestMsgLite: { id: string | null; title: string; preview: string; conversation_id: string | null } | null = null;

    // ---------- FILES (path/filename keyword search) ----------
    let fileRows: FileRow[] = [];
    try {
      const fileArrays = await Promise.all(
        allCodeProjectIds.map(pid =>
          Promise.resolve(this.sb.rpc('cb_find_files', { p_project_id: pid, p_q: query, p_max_results: 30 }))
            .then(res => (res?.data as FileRow[]) || [])
            .catch(() => [] as FileRow[]) as Promise<FileRow[]>
        )
      );
      // Merge and dedup by path (keep highest score)
      const fileMap = new Map<string, FileRow>();
      for (const rows of fileArrays) {
        for (const r of rows) {
          const existing = fileMap.get(r.path);
          if (!existing || (r.score ?? 0) > (existing.score ?? 0)) {
            fileMap.set(r.path, r);
          }
        }
      }
      fileRows = Array.from(fileMap.values());
    } catch (e) {
      console.warn('[retriever] cb_find_files threw:', e);
    }
    fileRows = normalize0to1<FileRow>(fileRows);

    console.log('[retriever] cb_find_files completed:', Date.now() - t0, 'ms, rows:', fileRows.length);

    // ---------- KEYWORD FILES mapping ----------
    const keywordFiles: RankItem[] = [];
    fileRows.forEach((r, i) => {
      const p = cleanPath(r.path);
      const { pass, boosts } = opFilters(p, { ...req.operators, __q: query } as any);
      if (!pass) return;
      keywordFiles.push({
        id: `file:${p}`,
        rank: i + 1,
        meta: { row: { ...r, path: p }, kind: 'file', boosts, source: 'rpc:cb_find_files' }
      });
    });

    // ---------- CODE SPANS (path + window) ----------
    let spanRows: SpanRow[] = [];
    try {
      const spanArrays = await Promise.all(
        allCodeProjectIds.map(pid =>
          Promise.resolve(this.sb.rpc('cb_find_code_spans', { p_project_id: pid, p_q: query, p_window_lines: 6, p_max_results: 30 }))
            .then(res => (res?.data as SpanRow[]) || [])
            .catch(() => ([] as SpanRow[])) as Promise<SpanRow[]>
        )
      );
      // Merge and dedup by path+lines (keep highest score)
      const spanMap = new Map<string, SpanRow>();
      for (const rows of spanArrays) {
        for (const r of rows) {
          const key = `${r.path}#${r.start_line}-${r.end_line}`;
          const existing = spanMap.get(key);
          if (!existing || (r.score ?? 0) > (existing.score ?? 0)) {
            spanMap.set(key, r);
          }
        }
      }
      spanRows = Array.from(spanMap.values());
    } catch (e) {
      console.warn('[retriever] cb_find_code_spans threw:', e);
    }
    spanRows = normalize0to1<SpanRow>(spanRows);

    console.log('[retriever] cb_find_code_spans completed:', Date.now() - t0, 'ms, rows:', spanRows.length);

    // ---------- KEYWORD SPANS mapping ----------
    const keywordSpans: RankItem[] = [];
    spanRows.forEach((r, i) => {
      const p = cleanPath(r.path);
      const { pass, boosts } = opFilters(p, { ...req.operators, __q: query } as any);
      if (!pass) return;

      // Apply intent-based boilerplate penalty
      let qualityMultiplier = 1.0;
      if (intent === 'code_seeking' && isBoilerplate(r.snippet)) {
        qualityMultiplier = 0.5;
      }

      const tunedBoosts = { ...boosts };
      if (qualityMultiplier < 1) {
        tunedBoosts.symbolSim = (tunedBoosts.symbolSim || 0) - 0.5;
      }

      keywordSpans.push({
        id: `span:${p}#${r.start_line}-${r.end_line}`,
        rank: i + 1,
        meta: { row: { ...r, path: p }, kind: 'span', boosts: tunedBoosts, source: 'rpc:cb_find_code_spans' }
      });
    });

    // ---------- SYMBOL DEFINITIONS (cb_match_symbols) ----------
    // Symbol search finds function/class/etc definitions but NOT string literals like 'cb_search_exact'.
    // We map these to normal SPANS so fillPack can handle them.
    type SymbolHit = { file_path: string; name: string; line: number; score: number };
    let symbolHits: SymbolHit[] = [];

    try {
      const symArrays = await Promise.all(
        allCodeProjectIds.map(pid =>
          Promise.resolve(this.sb.rpc('cb_match_symbols', { p_project_id: pid, p_q: query, p_max_results: 20 }))
            .then(res => (res?.data ?? []) as any[])
            .catch(() => [] as any[])
        )
      );

      const symMap = new Map<string, SymbolHit>();
      for (const arr of symArrays) {
        for (const s of arr) {
          const filePath = cleanPath(String(s.file_path ?? s.out_file_path ?? ''));
          const name = String(s.name ?? '');
          const line = Number(s.line ?? 0);
          const score = Number(s.score ?? 0);
          if (!filePath || !name || !Number.isFinite(line)) continue;

          const key = `${filePath}:${name}:${line}`;
          if (!symMap.has(key)) symMap.set(key, { file_path: filePath, name, line, score });
        }
      }

      symbolHits = Array.from(symMap.values())
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      console.log('[retriever] cb_match_symbols completed:', Date.now() - t0, 'ms, hits:', symbolHits.length);
    } catch (e) {
      console.warn('[retriever] cb_match_symbols threw:', e);
    }

    // Map symbol hits → keywordSpans (as SPANS, not "chunk")
    symbolHits.slice(0, 30).forEach((s, i) => {
      const p = cleanPath(s.file_path);
      if (!p || isGarbagePath(p)) return;

      const { searchExclusions } = SEARCH_CONFIG;
      if (searchExclusions.fullExclude.some(ex => p.endsWith(ex) || p.includes(ex))) return;

      const { pass, boosts } = opFilters(p, { ...req.operators, __q: query } as any);
      if (!pass) return;

      const start = Math.max(1, s.line - 3);
      const end = s.line + 10;

      keywordSpans.push({
        id: `span:${p}#${start}-${end}`,
        rank: i + 1,
        meta: {
          row: {
            path: p,
            snippet: s.name,
            start_line: start,
            end_line: end,
            score: (s.score ?? 0) * AUTHORITY.CODE_SPAN,
            updated_at: null
          },
          kind: 'span',
          boosts: { ...boosts, symbolHit: true, authority: AUTHORITY.CODE_SPAN },
          authorityWeight: AUTHORITY.CODE_SPAN,
          source: 'rpc:cb_match_symbols'
        }
      });
    });

    console.log('[retriever] Symbol results added to keywordSpans:', symbolHits.length);

// ---------- BM25 CHUNK KEYWORD SEARCH (cb_search_chunks_keyword) ----------
// BM25 catches string literals + comments that symbol search misses.
// We inject:
//  (1) spans → keywordSpans (for previews)
//  (2) collapsed files → bm25FileEntries (for file-level competition in fusion)
type Bm25Chunk = { file_path: string; snippet: string; start_line: number; end_line: number; score: number; match_type: string };
let bm25Chunks: Bm25Chunk[] = [];
let bm25FileEntries: RankItem[] = [];

try {
  const bm25Arrays = await Promise.all(
    allCodeProjectIds.map(pid =>
      Promise.resolve(this.sb.rpc('cb_search_chunks_keyword', { p_project_id: pid, p_query: query, p_limit: 60 }))
        .then(res => (res?.data ?? []) as any[])
        .catch(() => [] as any[])
    )
  );

  const chunkMap = new Map<string, Bm25Chunk>();
  for (const arr of bm25Arrays) {
    for (const r of arr) {
      const filePath = cleanPath(String(r.out_file_path ?? r.file_path ?? ''));
      if (!filePath) continue;

      const c: Bm25Chunk = {
        file_path: filePath,
        snippet: String(r.out_text_snippet ?? r.text_snippet ?? ''),
        start_line: Number(r.out_start_line ?? r.start_line ?? 0),
        end_line: Number(r.out_end_line ?? r.end_line ?? 0),
        score: Number(r.out_score ?? r.score ?? 0),
        match_type: String(r.out_match_type ?? r.match_type ?? 'fulltext'),
      };

      const key = `${c.file_path}#${c.start_line}-${c.end_line}`;
      const existing = chunkMap.get(key);
      if (!existing || c.score > existing.score) chunkMap.set(key, c);
    }
  }

  bm25Chunks = Array.from(chunkMap.values()).sort((a, b) => b.score - a.score);
  console.log('[retriever] cb_search_chunks_keyword completed:', Date.now() - t0, 'ms, chunks:', bm25Chunks.length);

  const { searchExclusions } = SEARCH_CONFIG;

  // 1) BM25 chunks → keywordSpans (cap spans)
  bm25Chunks.slice(0, 40).forEach((c, i) => {
    const p = cleanPath(c.file_path);
    if (!p || isGarbagePath(p)) return;
    if (searchExclusions.fullExclude.some(ex => p.endsWith(ex) || p.includes(ex))) return;

    const { pass, boosts } = opFilters(p, { ...req.operators, __q: query } as any);
    if (!pass) return;

    keywordSpans.push({
      id: `span:${p}#${c.start_line}-${c.end_line}`,
      rank: i + 1,
      meta: {
        row: {
          path: p,
          snippet: c.snippet,
          start_line: c.start_line,
          end_line: c.end_line,
          score: c.score,
          updated_at: null
        },
        kind: 'span',
        boosts: { ...boosts, bm25Hit: true },
        source: 'rpc:cb_search_chunks_keyword'
      }
    });
  });

  // 2) Collapse BM25 per-file (max chunk score) → bm25FileEntries (cap files)
  const fileScoreMap = new Map<string, { maxScore: number; bestSnippet: string; startLine: number; endLine: number }>();

  for (const c of bm25Chunks) {
    const p = cleanPath(c.file_path);
    if (!p || isGarbagePath(p)) continue;
    if (searchExclusions.fullExclude.some(ex => p.endsWith(ex) || p.includes(ex))) continue;

    const existing = fileScoreMap.get(p);
    if (!existing || c.score > existing.maxScore) {
      fileScoreMap.set(p, { maxScore: c.score, bestSnippet: c.snippet, startLine: c.start_line, endLine: c.end_line });
    }
  }

  // Apply penalty patterns BEFORE selecting top N (so meta files don’t steal the cap)
  let fileEntries = Array.from(fileScoreMap.entries())
    .map(([p, info]) => {
      let s = info.maxScore;

      // 1) Existing penalty patterns
      for (const pp of searchExclusions.penaltyPatterns) {
        if (pp.pattern.test(p)) { s *= pp.multiplier; break; }
      }

      // 2) Elegant vendor/minified-bundle penalty
      s = applyBundlePenalty(p, query, s);

      return { p, info, s };
    })

    .sort((a, b) => b.s - a.s);

  fileEntries = fileEntries.filter(x => {
    const { pass } = opFilters(x.p, { ...req.operators, __q: query } as any);
    return pass;
  }).slice(0, 15);

  const maxS = fileEntries[0]?.s ?? 1;
  const minS = fileEntries[fileEntries.length - 1]?.s ?? 0;
  const range = (maxS - minS) || 1;

  bm25FileEntries = fileEntries.map((x, i) => {
    const { pass, boosts } = opFilters(x.p, { ...req.operators, __q: query } as any);
    if (!pass) return null;

    const bm25Norm = (x.s - minS) / range; // query-local 0–1

    return {
      id: `file:${x.p}`,
      rank: i + 1,
      meta: {
        row: { path: x.p, updated_at: null, score: bm25Norm * AUTHORITY.CODE_FILE },
        kind: 'file',
        boosts: { ...boosts, bm25Norm, bm25Hit: true, authority: AUTHORITY.CODE_FILE },
        similarity: bm25Norm, // only used for logging; don’t assume comparable to cosine
        authorityWeight: AUTHORITY.CODE_FILE,
        source: 'rpc:cb_search_chunks_keyword[file]'
      }
    } as RankItem;
  }).filter(Boolean) as RankItem[];

  console.log('[retriever] BM25: spansAdded=', Math.min(40, bm25Chunks.length), 'filesPromoted=', bm25FileEntries.length);
} catch (e) {
  console.warn('[retriever] cb_search_chunks_keyword threw:', e);
}

    // ---------- BM25 CHUNK SEARCH → FILE-LEVEL PROMOTION ----------
    // cb_search_chunks_keyword finds string literals, comments, and content
    // that cb_match_symbols misses (which only finds symbol definitions).
    // We inject results as BOTH spans (for previews) and file-level entries
    // (to compete with embedding results in RRF fusion).
    try {
      const bm25Arrays = await Promise.all(
        allCodeProjectIds.map(pid =>
          Promise.resolve(this.sb.rpc('cb_search_chunks_keyword', { p_project_id: pid, p_query: query, p_limit: 30 }))
            .then(res => (res?.data ?? []))
            .catch(() => [])
        )
      );

      // Normalize out_ prefixed fields
      const bm25Chunks: { file_path: string; snippet: string; start_line: number; end_line: number; score: number; match_type: string }[] = [];
      for (const arr of bm25Arrays) {
        for (const r of arr) {
          bm25Chunks.push({
            file_path: r.out_file_path ?? r.file_path ?? '',
            snippet: r.out_text_snippet ?? r.text_snippet ?? '',
            start_line: r.out_start_line ?? r.start_line ?? 0,
            end_line: r.out_end_line ?? r.end_line ?? 0,
            score: r.out_score ?? r.score ?? 0,
            match_type: r.out_match_type ?? r.match_type ?? 'fulltext',
          });
        }
      }
      console.log('[retriever] cb_search_chunks_keyword (first pipeline):', bm25Chunks.length, 'chunks');

      // 1. Add as SPANS into keywordSpans (for previews/context injection)
      const { searchExclusions } = SEARCH_CONFIG;
      const topSpans = bm25Chunks.slice(0, 40);
      topSpans.forEach((c, i) => {
        const p = cleanPath(c.file_path);
        if (isGarbagePath(p)) return;
        if (searchExclusions.fullExclude.some(ex => p.endsWith(ex) || p.includes(ex))) return;
        const { pass, boosts } = opFilters(p, { ...req.operators, __q: query } as any);
        if (!pass) return;

        keywordSpans.push({
          id: `span:${p}#${c.start_line}-${c.end_line}`,
          rank: i + 1,
          meta: {
            row: { path: p, snippet: c.snippet, start_line: c.start_line, end_line: c.end_line, score: c.score, updated_at: null },
            kind: 'span',
            boosts: { ...boosts, bm25Hit: true },
            source: 'rpc:cb_search_chunks_keyword',
          }
        });
      });

      // 2. Collapse per-file → max(chunk score), cap at 15 files
      const fileScoreMap = new Map<string, { maxScore: number; matchType: string; bestSnippet: string; startLine: number; endLine: number }>();
      for (const c of bm25Chunks) {
        const p = cleanPath(c.file_path);
        if (isGarbagePath(p)) continue;
        if (searchExclusions.fullExclude.some(ex => p.endsWith(ex) || p.includes(ex))) continue;
        const existing = fileScoreMap.get(p);
        if (!existing || c.score > existing.maxScore) {
          fileScoreMap.set(p, { maxScore: c.score, matchType: c.match_type, bestSnippet: c.snippet, startLine: c.start_line, endLine: c.end_line });
        }
      }

      // Query-local normalization: map BM25 scores to 0–1 range
      const fileEntries = Array.from(fileScoreMap.entries())
        .sort((a, b) => b[1].maxScore - a[1].maxScore)
        .slice(0, 15);

      const bm25Max = fileEntries[0]?.[1].maxScore ?? 1;
      const bm25Min = fileEntries[fileEntries.length - 1]?.[1].maxScore ?? 0;
      const bm25Range = bm25Max - bm25Min || 1;

      fileEntries.forEach(([p, info], i) => {
        const { pass, boosts } = opFilters(p, { ...req.operators, __q: query } as any);
        if (!pass) return;

        // Normalize to 0–1 within this query's BM25 results
        const bm25Norm = (info.maxScore - bm25Min) / bm25Range;

        // Apply penalty patterns
          let penalizedScore = bm25Norm;
          for (const pp of searchExclusions.penaltyPatterns) {
            if (pp.pattern.test(p)) { penalizedScore *= pp.multiplier; break; }
          }

          bm25FileEntries.push({
            id: `file:${p}`,
            rank: i + 1,
            meta: {
              row: { path: p, score: penalizedScore, updated_at: null },
              kind: 'file',
              boosts: { ...boosts, bm25Norm, authority: AUTHORITY.CODE_FILE, source: 'bm25' },
              similarity: penalizedScore,
              authorityWeight: AUTHORITY.CODE_FILE,
            }
          });
         });

      console.log('[retriever] BM25 file-level entries:', bm25FileEntries.length, 'files, top:', bm25FileEntries[0]?.id ?? 'none');
    } catch (e) {
      console.warn('[retriever] BM25 chunk search threw:', e);
    }

    // ---------- ROUTE MATCHING EXPANSION (PARALLEL) ----------
    if (looksRoutey(query)) {
      try {
        const routeArrays = await Promise.all(
          allCodeProjectIds.map(pid =>
            Promise.resolve(this.sb.rpc('cb_match_routes', { p_project_id: pid, p_q: query, p_max_results: 20 }))
              .then(res => (res?.data ?? []) as { file_path: string; method: string; route: string }[])
              .catch(() => [] as { file_path: string; method: string; route: string }[])
          )
        );
        // Merge and dedup by route
        const routeMap = new Map<string, { file_path: string; method: string; route: string }>();
        for (const arr of routeArrays) {
          for (const r of arr) {
            routeMap.set(`${r.method}:${r.route}`, r);
          }
        }
        const routes = Array.from(routeMap.values());

        const routeSpanPromises = routes.map(async (rinfo) => {
          try {
            const sRes = await this.sb.rpc('cb_find_code_spans', {
              p_project_id: codeProjectId,
              p_q: rinfo.route,
              p_window_lines: 6,
              p_max_results: 6
            });
            return { rinfo, rows: normalize0to1<SpanRow>(sRes?.data ?? []) };
          } catch {
            return { rinfo, rows: [] as SpanRow[] };
          }
        });

        const routeResults = await Promise.all(routeSpanPromises);

        for (const { rows } of routeResults) {
          rows.forEach((row, i) => {
            const p = cleanPath(row.path);
            const { pass, boosts } = opFilters(p, { ...req.operators, __q: query } as any);
            if (!pass) return;
            const routeBoosts = {
              ...boosts,
              routeHit: 1.2,
              symbolSim: Math.max(0.85, (boosts as any).symbolSim || 0)
            };
            keywordSpans.push({
              id: `span:${p}#${row.start_line}-${row.end_line}`,
              rank: i + 1,
              meta: { row: { ...row, path: p }, kind: 'span', boosts: routeBoosts, source: 'rpc:cb_match_routes' }
            });
          });
        }
      } catch (e) {
        console.warn('[retriever] cb_match_routes failed:', e);
      }
    }

    console.log('[retriever] Route matching completed:', Date.now() - t0, 'ms');
    console.log('[retriever] Starting embedding generation:', Date.now() - t0, 'ms');

    // ---------- SEMANTIC (files via embeddings) ----------
    const semantic: RankItem[] = [];

    // ---------- LEXICAL KEY FALLBACK (filename/path tokens) ----------
    let lexicalFileHits: RankItem[] = [];
    try {
      if (looksLikeFilenameQuery(query)) {
        const tokens = extractFilenameTokens(query);
        const { searchExclusions } = SEARCH_CONFIG;

        const rowsArrays = await Promise.all(
          allCodeProjectIds.map(pid =>
            Promise.all(tokens.map(tok =>
              Promise.resolve(this.sb.rpc('cb_search_files_keyword', { p_project_id: pid, p_query: tok, p_limit: 10 }))
                .then(res => (res?.data ?? []) as any[])
                .catch(() => [] as any[])
            ))
          )
        );

        const flatRows = rowsArrays.flat(2);

        // Dedup by path
        const m = new Map<string, any>();
        for (const r of flatRows) {
          const p = cleanPath(String(r.path ?? r.file_path ?? r.key ?? r.filename ?? ''));
          if (!p || isGarbagePath(p)) continue;
          if (searchExclusions.fullExclude.some(ex => p.endsWith(ex) || p.includes(ex))) continue;
          if (!m.has(p)) m.set(p, r);
        }

        const deduped = Array.from(m.entries()).slice(0, 15);

        lexicalFileHits = deduped.map(([p], i) => {
          const { pass, boosts } = opFilters(p, { ...req.operators, __q: query } as any);
          if (!pass) return null;

          return {
            id: `file:${p}`,
            rank: i + 1,
            meta: {
              row: { path: p, updated_at: null, score: 0.95 * AUTHORITY.CODE_FILE },
              kind: 'file',
              boosts: { ...boosts, filenameMention: true, lexicalKeyHit: true, authority: AUTHORITY.CODE_FILE },
              similarity: 0.95,
              authorityWeight: AUTHORITY.CODE_FILE,
              source: 'lexical:key-fallback'
            }
          } as RankItem;
        }).filter(Boolean) as RankItem[];

        if (lexicalFileHits.length) {
          console.log('[retriever] Lexical key fallback added files:', lexicalFileHits.length, 'tokens=', tokens);
          // Make them compete at file level
          semantic.push(...lexicalFileHits);
        }
      }
    } catch (e) {
      console.warn('[retriever] Lexical key fallback threw:', e);
    }

    // ---------- ARTIFACT-KEY TOKEN SEARCH (file path/name matching) ----------
    // Bridges vocabulary gap: natural language query terms → file paths.
    // e.g., "content scripts" → content-universal.js, "hybrid ranking" → rank-combiner.ts
    let artifactKeyHits: RankItem[] = [];
    try {
      const pathTokens = extractPathTokens(query);
      if (pathTokens.length > 0) {
        const akArrays = await Promise.all(
          allCodeProjectIds.map(pid =>
            Promise.resolve(this.sb.rpc('cb_search_artifact_keys', {
              p_project_id: pid,
              p_tokens: pathTokens,
              p_limit: 15,
            }))
              .then(res => (res?.data ?? []) as any[])
              .catch(() => [] as any[])
          )
        );

        // Merge and dedup by key (keep highest score)
        const akMap = new Map<string, { key: string; artifactId: string; tokensMatched: number; basenameHits: number; score: number }>();
        for (const arr of akArrays) {
          for (const r of arr) {
            const key = String(r.out_key ?? '');
            if (!key || isGarbagePath(key)) continue;

            const { searchExclusions } = SEARCH_CONFIG;
            if (searchExclusions.fullExclude.some(ex => key.endsWith(ex) || key.includes(ex))) continue;

            // Precision gate: avoid flooding on single generic token matches
            if (Number(r.out_tokens_matched ?? 0) < 2 && Number(r.out_basename_hits ?? 0) < 1) continue;

            const existing = akMap.get(key);
            const score = Number(r.out_score ?? 0);
            if (!existing || score > existing.score) {
              akMap.set(key, {
                key,
                artifactId: String(r.out_artifact_id ?? ''),
                tokensMatched: Number(r.out_tokens_matched ?? 0),
                basenameHits: Number(r.out_basename_hits ?? 0),
                score,
              });
            }
          }
        }

        // Apply existing penalties and convert to RankItems
        // Apply penalties here (not double-applied: these items bypass the
        // First Pass rerank loop since they're injected into semantic[] after it)
        const { searchExclusions } = SEARCH_CONFIG;
        let akEntries = Array.from(akMap.values())
          .map(e => {
            let s = e.score;
            for (const pp of searchExclusions.penaltyPatterns) {
              if (pp.pattern.test(e.key)) { s *= pp.multiplier; break; }
            }
            s = applyBundlePenalty(e.key, query, s);
            return { ...e, score: s };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, 15);

        artifactKeyHits = akEntries.map((e, i) => {
          const { pass, boosts } = opFilters(e.key, { ...req.operators, __q: query } as any);
          if (!pass) return null;

          // Apply path boost for artifact-key hits with strong signals only
          let akScore = e.score;
          let pathBoostValue = 0;
          if (e.basenameHits >= 1 || e.tokensMatched >= 2) {
            // Approximate nameBoost using data we already have from the RPC
            pathBoostValue = Math.min(
              e.basenameHits * 0.10 + (e.tokensMatched > 1 ? 0.05 : 0),
              0.15  // cap boost contribution
            );
            akScore += pathBoostValue;
          }

          return {
            id: `file:${e.key}`,
            rank: i + 1,
            meta: {
              row: { path: e.key, updated_at: null, score: akScore * AUTHORITY.CODE_FILE },
              kind: 'file',
              boosts: {
                ...boosts,
                artifactKeyHit: true,
                artifactKeyScore: e.score,
                pathBoost: pathBoostValue,
                tokensMatched: e.tokensMatched,
                basenameHits: e.basenameHits,
                authority: AUTHORITY.CODE_FILE,
              },
              similarity: akScore, // lexical key score + path boost (0-0.85), not cosine
              authorityWeight: AUTHORITY.CODE_FILE,
              source: 'rpc:cb_search_artifact_keys',
            },
          } as RankItem;
        }).filter(Boolean) as RankItem[];

        if (artifactKeyHits.length > 0) {
          semantic.push(...artifactKeyHits);
          console.log('[retriever] Artifact-key token search:', {
            tokens: pathTokens,
            found: artifactKeyHits.length,
            top: artifactKeyHits[0]?.id ?? 'none',
          });
        } else {
          console.log('[retriever] Artifact-key token search: no results for tokens:', pathTokens);
        }
      }
    } catch (e) {
      console.warn('[retriever] Artifact-key token search threw:', e);
    }

    try {
      const embeddingService = getEmbeddingService();
      const qvecRaw = await embeddingService.generateEmbeddingVector(query);

      let qvec: number[];
      if (Array.isArray(qvecRaw)) {
        qvec = qvecRaw;
      } else if (typeof qvecRaw === 'string') {
        qvec = JSON.parse(qvecRaw);
      } else if ((qvecRaw as any)?.vector) {
        const vec = (qvecRaw as any).vector;
        qvec = Array.isArray(vec) ? vec : JSON.parse(vec);
      } else {
        throw new Error('Unexpected vector format from embeddingService.generateEmbeddingVector');
      }

      console.log(RETRIEVER_TAG, 'Vector type check:', {
        isArray: Array.isArray(qvec),
        length: qvec?.length,
        firstValue: qvec?.[0],
      });

      // Extract meaningful tokens from query
      const stopWords = new Set(['the', 'is', 'are', 'where', 'what', 'how', 'in', 'at', 'to', 'for', 'of', 'a', 'an']);
      const queryTokens = query.toLowerCase()
        .replace(/[^\w\s-]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2 && !stopWords.has(t))
        .map(t => {
          let stem = t;
          if (stem.length >= 5 && stem.endsWith('s')) stem = stem.slice(0, -1);
          if (stem.length >= 7 && stem.endsWith('ing')) {
            const candidate = stem.slice(0, -3);
            if (candidate.length >= 4 && !/[aeiou]$/.test(candidate)) stem = candidate;
          }
          return stem;
        });

      console.log(RETRIEVER_TAG, 'Query tokens:', queryTokens);

      const fileTopK = 150; // Widened net to find real files buried under garbage
      // Search code across all Codex projects in parallel
      const fileHitArrays = await Promise.all(
        allCodeProjectIds.map(pid => this.rpcFileSearch(supabase, pid, query, qvec, fileTopK, intent))
      );
      // Merge and deduplicate by path (keep highest similarity)
      const fileHitMap = new Map<string, typeof fileHitArrays[0][0]>();
      for (const hits of fileHitArrays) {
        for (const h of hits) {
          const existing = fileHitMap.get(h.path);
          if (!existing || (h.similarity ?? 0) > (existing.similarity ?? 0)) {
            fileHitMap.set(h.path, h);
          }
        }
      }
      const fileHits = Array.from(fileHitMap.values());
      console.log('[retriever] Multi-project file search:', { 
        projects: allCodeProjectIds.length, 
        totalHits: fileHits.length,
        topHits: fileHits.slice(0, 5).map(h => ({ path: h.path, sim: h.similarity }))
      });

      // Query-driven boost
      function nameBoost(path?: string | null, filename?: string | null, queryTokens?: string[]): number {
        if (!queryTokens || queryTokens.length === 0) return 0;

        const { tokenMatchBoost, extensionBoost, directoryMatchBoost, maxTotalBoost } = SEARCH_CONFIG.pathBoost;
        const lowerPath = (path ?? '').toLowerCase();
        const lowerFilename = (filename ?? '').toLowerCase();
        const hay = `${lowerPath} ${lowerFilename}`;

        // Split path into directory segments for directory-level matching
        const dirSegments = lowerPath.split('/').slice(0, -1); // exclude filename

        let boost = 0;

        for (const token of queryTokens) {
          // Token matches anywhere in path or filename
          if (hay.includes(token)) {
            boost += tokenMatchBoost;
          }
          // Token matches a directory name (separate, additive signal)
          if (dirSegments.some(dir => dir.includes(token))) {
            boost += directoryMatchBoost;
          }
        }

        const hasValidExtension = /\.(html?|css|s[ac]ss|less|[jt]sx?|py|java|cpp?|go|rs|swift|kt|rb|php|md|txt|json|ya?ml|xml|toml|ini|env|pdf|docx?|csv|xlsx?|sh|bash|ps1|bat)$/i.test(hay);
        if (hasValidExtension) {
          boost += extensionBoost;
        }

        return Math.min(boost, maxTotalBoost);
      }

      const MIN_SIM = 0.20;
      const UNKNOWN_PENALTY = 0.05;

      // First pass: calculate base scores
      const scored = fileHits.map(h => {
        const base = h.similarity ?? 0;
        const boosts = nameBoost(h.path ?? null, h.filename ?? null, queryTokens);
        const penalty = (h.path === 'unknown' || h.filename === 'unknown') ? UNKNOWN_PENALTY : 0;
        const score = Math.max(0, base + boosts - penalty);
        return { ...h, _score: score, _timestamp: h.updated_at ? new Date(h.updated_at).getTime() : 0 };
      });

      // Recency boost
      const timestamps = scored.map(h => h._timestamp).filter(t => t > 0);
      const newestTime = Math.max(...timestamps);
      const oldestTime = Math.min(...timestamps);
      const timeRange = newestTime - oldestTime || 1;

      const reranked = scored
        .map(h => {
          let recencyBoost = 0;
          if (h._timestamp > 0 && timeRange > 0) {
            const relativeAge = (h._timestamp - oldestTime) / timeRange;
            recencyBoost = relativeAge * 0.05;  // Reduced from 0.10 to 0.05
          }
          const finalScore = h._score + recencyBoost;
          return { ...h, _score: finalScore };
        })
        .filter(h => h._score >= MIN_SIM)
        .sort((a, b) => compareWithRecency(
          { score: a._score, updated_at: a.updated_at ?? null },
          { score: b._score, updated_at: b.updated_at ?? null }
        ));

      console.log(RETRIEVER_TAG, 'Rerank summary:', {
        before: fileHits.length,
        after: reranked.length,
        topPath: reranked[0]?.path ?? null,
        topFile: reranked[0]?.filename ?? null,
        topBaseSim: reranked[0]?.similarity ?? null,
        topScore: reranked[0]?._score ?? null,
      });

      console.log(RETRIEVER_TAG, 'Pre-filter counts:', { files_semantic: fileHits.length });

      topFilesForUi = reranked.slice(0, 10).map(f => ({
        path: f.path ?? f.filename ?? '(unknown)',
        filename: f.filename ?? null,
        similarity: f.similarity ?? 0,
      }));

      console.log(RETRIEVER_TAG, 'UI index (files):', {
        count: topFilesForUi.length,
        first: topFilesForUi[0] ?? null,
      });

      // Map file hits to semantic array with INTENT-BASED PENALTIES
      // Uses three-pass approach: calculate penalties → re-sort → assign ranks
      const rows: Array<{
        file_id?: string;
        path?: string;
        file_name?: string | null;
        created_at?: string | null;
        similarity?: number;
        preview?: string | null;
        _source?: string;
      }> = fileHits.map(h => ({
        file_id: h.id,
        path: h.path,
        file_name: h.filename ?? undefined,
        created_at: h.updated_at ?? null,
        similarity: h.similarity,
        preview: h.preview ?? null,
        _source: h.meta?.source ?? 'unknown',
      }));

      // ---------- FILE EVIDENCE MAP (propagate span hits to file candidates) ----------
      // Spans contain the strongest "explainable" signals (symbol hits, BM25 hits).
      // File scoring should see those signals too.
      const fileEvidence = new Map<string, { symbolHit?: boolean; symbolScore?: number; bm25Hit?: boolean }>();

      function markEvidence(path: string, patch: { symbolHit?: boolean; symbolScore?: number; bm25Hit?: boolean }) {
        if (!path) return;
        const p = cleanPath(path);
        const cur = fileEvidence.get(p) || {};
        fileEvidence.set(p, {
          symbolHit: cur.symbolHit || patch.symbolHit || false,
          symbolScore: Math.max(cur.symbolScore ?? 0, patch.symbolScore ?? 0),
          bm25Hit: cur.bm25Hit || patch.bm25Hit || false
        });
      }

      for (const s of keywordSpans) {
        const row = (s.meta as any)?.row;
        const p = cleanPath(row?.path || '');

        const boosts = (s.meta as any)?.boosts || {};
        const src = (s.meta as any)?.source || '';

        // Evidence from spans
        if (boosts.symbolHit || String(src).includes('cb_match_symbols')) {
          const isCodeFile = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|php|rb|kt|c|cc|cpp|h|hpp)$/i.test(p);
          if (isCodeFile) {
            const symScore = Number(row?.score ?? boosts?.symbolScore ?? 0);
            markEvidence(p, { symbolHit: true, symbolScore: symScore });
          }
        }

        if (boosts.bm25Hit || String(src).includes('cb_search_chunks_keyword')) {
          markEvidence(p, { bm25Hit: true });
        }
      }

      console.log('[retriever] fileEvidence map:', {
        files: fileEvidence.size,
        sample: Array.from(fileEvidence.entries()).slice(0, 3)
      });
      console.log('[retriever] fileEvidence for content-fetcher:', fileEvidence.get('agent/content-fetcher.ts') || fileEvidence.get('packages/backend/src/agent/content-fetcher.ts') || 'NOT FOUND');
      console.log('[retriever] fileEvidence for context-injection:', fileEvidence.get('routes/context-injection.routes.ts') || fileEvidence.get('packages/backend/src/routes/context-injection.routes.ts') || 'NOT FOUND');

      // 1. First Pass: Apply filters and calculate Penalized Scores
      const penalizedRows = rows
        .map((r, i) => {
          const raw = r.path || r.file_name || `file_id:${r.file_id || i}`;
          const p = cleanPath(raw);
          
          // Filter out garbage paths from broken indexing
          if (isGarbagePath(p)) return null;
          
          // Search exclusions: hard exclude test harness artifacts
          const { searchExclusions } = SEARCH_CONFIG;
          if (searchExclusions.fullExclude.some(ex => p.endsWith(ex) || p.includes(ex))) return null;

          const { pass, boosts } = opFilters(p, { ...req.operators, __q: query } as any);
          if (!pass) return null;

          // Apply the INTENT-BASED PENALTY here
          const intentAdjusted = applyIntentPenalty(r.similarity ?? 0, p, intent, query);
          
          // Apply filename/path boost
          const pathBoostValue = nameBoost(p, p.split('/').pop() ?? null, queryTokens);
          let adjustedSimilarity = intentAdjusted + pathBoostValue;

          // Apply penalty patterns (test, spec, mock, fixture files)
          for (const pp of searchExclusions.penaltyPatterns) {
            if (pp.pattern.test(p)) { adjustedSimilarity *= pp.multiplier; break; }
          }

          // Elegant vendor/minified-bundle penalty (no hardcoded library names)
          adjustedSimilarity = applyBundlePenalty(p, query, adjustedSimilarity);

          // Merge file-level boosts with propagated evidence from spans
          const ev = fileEvidence.get(p) || {};
          const mergedBoosts = { ...boosts, ...ev };

          // Identifier dominance can now “see” symbolHit/bm25Hit at file level
          adjustedSimilarity = applyIdentifierDominance(p, query, adjustedSimilarity, {
            source: r._source ?? '',
            boosts: mergedBoosts
          });

          // Domain priors: boost likely “auth” or “database connection” files when query suggests that domain
          adjustedSimilarity = applyDomainPriors(p, query, adjustedSimilarity);

          return { ...r, cleanPath: p, adjustedSimilarity, boosts: { ...boosts, pathBoost: pathBoostValue } };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      // 2. RE-RANKING: Sort by the new Adjusted Similarity
      // This ensures that a penalized Ghost File drops from Rank #1 to Rank #50
      penalizedRows.sort((a, b) => b.adjustedSimilarity - a.adjustedSimilarity);

      console.log(RETRIEVER_TAG, 'Post-penalty rerank:', {
        inputRows: rows.length,
        afterGarbageFilter: penalizedRows.length,
        filtered: rows.length - penalizedRows.length,
        topPath: penalizedRows[0]?.cleanPath ?? null,
        topAdjustedSim: penalizedRows[0]?.adjustedSimilarity ?? null,
      });

      // 3. Final Pass: Assign Ranks based on new order
      penalizedRows.forEach((r, i) => {
        const p = r.cleanPath;
        
       // Determine authority based on file type / artifact type
      let authority = AUTHORITY.CODE_FILE;

      // Only treat as "message snippet" if it is clearly a message-like pseudo-path.
      // (Avoid misclassifying real file paths.)
      const pLower = p.toLowerCase();
      const looksLikeMessage =
        pLower.startsWith('message:') ||
        pLower.startsWith('conv-file:') ||
        pLower.startsWith('msg_') ||
        pLower.startsWith('conversation:');

      if (looksLikeMessage) {
        authority = AUTHORITY.MESSAGE_SNIPPET;
      } else if (/\.(pdf|docx|xlsx|xls|csv)$/i.test(p)) {
        authority = AUTHORITY.ATTACHED_DOC;  // Source of truth documents
      } else if (/\.(md|markdown|txt|doc)$/i.test(p)) {
        authority = AUTHORITY.DOCUMENT;
      }
   
        // Apply authority to the score
        const authorityAdjustedScore = r.adjustedSimilarity * authority;
        
        semantic.push({
          id: `file:${p}`,
          rank: i + 1,
          meta: {
            row: { path: p, updated_at: r.created_at ?? null, score: r.adjustedSimilarity },
            kind: 'file',
            boosts: { ...r.boosts, authority },
            similarity: r.adjustedSimilarity,
            authorityWeight: authority,
            source: r._source ?? 'rpc:unknown'
          }
        });
      });

      // Inject BM25-promoted files into semantic pool (so they compete in fusion)
      if (bm25FileEntries && bm25FileEntries.length > 0) {
        // Keep BM25 ranks as-is; they represent an independent channel.
        semantic.push(...bm25FileEntries);
        console.log('[retriever] Added BM25 file promotions to semantic:', bm25FileEntries.length);
      }

      // Message search
      const msgRes = await this.sb.rpc('search_message_embeddings', {
        p_project_id: projectId,
        p_query_vec: `[${qvec.join(',')}]`,
        p_top_k: 100
      }) as any;

      console.log('[retriever] Message RPC response:', {
        error: msgRes.error,
        dataLength: msgRes.data?.length,
        sampleRow: msgRes.data?.[0]
      });

      console.log('[retriever] Sample row provider:', msgRes.data?.[0]?.provider);

      const msgRows: any[] = msgRes?.data ?? [];

      // Pick best message
      function messageTokenScore(text: string, queryTokens: string[]): number {
        const hay = text.toLowerCase();
        let score = 0;

        for (const token of queryTokens) {
          if (hay.includes(token)) {
            score += 0.08;
          }
        }

        if (topFilesForUi.length > 0 && topFilesForUi[0].path) {
          const topFile = topFilesForUi[0].path.toLowerCase();
          if (hay.includes(topFile)) {
            score += 0.10;
          }
        }

        return score;
      }

      let bestRow: any = null;
      let bestScore = -Infinity;
      for (const r of msgRows) {
        const base = Number(r.similarity ?? 0);
        const boost = messageTokenScore(String(r.preview ?? ''), queryTokens) + messageTokenScore(String(r.title ?? ''), queryTokens);
        const score = base + boost;
        if (score > bestScore) { bestScore = score; bestRow = r; }
      }

      const MSG_MIN_SCORE = 0.30;
      if (bestRow && bestScore >= MSG_MIN_SCORE) {
        bestMsgLite = {
          id: String(bestRow.message_id ?? ''),
          title: bestRow.title ?? `Message ${String(bestRow.message_id ?? '').slice(0, 8)}`,
          preview: String(bestRow.preview ?? ''),
          conversation_id: String(bestRow.conversation_id ?? ''),
        };
      } else {
        bestMsgLite = null;
      }

      console.log(RETRIEVER_TAG, 'Best message (lite):', {
        has: !!bestMsgLite, boosted: bestScore, id: bestMsgLite?.id ?? null,
      });

      msgRows.forEach((r, i) => {
        // Apply authority penalty to messages
        const authorityAdjustedScore = (r.similarity ?? 0) * AUTHORITY.MESSAGE;
        
        semantic.push({
          id: `message:${r.message_id || i}`,
          rank: i + 1,
          meta: {
            row: {
              path: `conversation:${r.conversation_id}`,
              content: r.preview,
              updated_at: r.created_at ?? null,
              score: authorityAdjustedScore,
              provider: r.provider
            },
            kind: 'message',
            boosts: { authority: AUTHORITY.MESSAGE },
            similarity: r.similarity ?? 0,
            authorityWeight: AUTHORITY.MESSAGE,
            source: 'rpc:search_message_embeddings'
          }
        });
      });

      console.log('[retriever] Message search results:', {
        found: msgRows.length,
        topScore: msgRows[0]?.similarity
      });

      // Deduplication
      const fileMap = new Map<string, typeof semantic[number]>();
      semantic.forEach(item => {
        if (item.meta?.kind === 'file') {
          const existing = fileMap.get(item.id);
          if (!existing) {
            fileMap.set(item.id, item);
          } else if (item.meta.row?.updated_at && existing.meta?.row?.updated_at) {
            const itemDate = new Date(item.meta.row.updated_at);
            const existingDate = new Date(existing.meta.row.updated_at);
            if (itemDate > existingDate) {
              fileMap.set(item.id, item);
            }
          }
        }
      });

      const deduplicatedFiles = Array.from(fileMap.values());
      const rawMessages = semantic.filter(item => item.meta?.kind === 'message');
      
      // Per-conversation diversity: max 3 messages per conversation
      // Prevents meta-conversations (search tuning, harness results) from
      // flooding the semantic pool and crowding out target conversations.
      const MAX_MSGS_PER_CONV = 3;
      const msgByConv = new Map<string, typeof rawMessages>();
      for (const m of rawMessages) {
        const convId = (m.meta as any)?.row?.path?.replace('conversation:', '') ?? '';
        const arr = msgByConv.get(convId) || [];
        arr.push(m);
        msgByConv.set(convId, arr);
      }
      const messages = Array.from(msgByConv.values())
        .flatMap(arr => arr
          .sort((a, b) => ((b.meta as any)?.similarity ?? (b.meta as any)?.row?.score ?? 0) 
                        - ((a.meta as any)?.similarity ?? (a.meta as any)?.row?.score ?? 0))
          .slice(0, MAX_MSGS_PER_CONV)
        );

      semantic.length = 0;
      semantic.push(...deduplicatedFiles, ...messages);

      console.log('[retriever] After deduplication:', {
        files: deduplicatedFiles.length,
        messages: messages.length,
        rawMessages: rawMessages.length,
        conversationsRepresented: msgByConv.size,
        total: semantic.length
      });

    } catch (e) {
      console.warn('[retriever] semantic search failed:', e);
    }

    // ---------- INJECT EXACT MATCH RESULTS ----------
    if (exactResults.length > 0) {
      const exactBoost = SEARCH_CONFIG.scoring.exactMatchBoost;
      for (const er of exactResults) {
        if (er.source_type === 'message') {
          const id = `message:${er.source_id}`;
          if (!semantic.some(s => s.id === id)) {
            semantic.push({
              id,
              rank: 0,
              meta: {
                row: {
                  path: `conversation:${er.conversation_id}`,
                  content: er.content_snippet,
                  updated_at: er.created_at,
                  score: exactBoost,
                  provider: undefined,
                },
                kind: 'message',
                boosts: { exactMatch: true, authority: AUTHORITY.MESSAGE },
                similarity: exactBoost,
                authorityWeight: AUTHORITY.MESSAGE,
                // Pass through URL and title from RPC
                conversationUrl: (er as any).conversation_url,
                conversationTitle: (er as any).conversation_title,
              },
            });
          }
        } else if (er.source_type === 'chunk') {
          // Only chunks (from cb_chunks/cb_artifacts) are real Codex source code
          const filePath = (er as any).file_path || '';
          if (isMessageSnippet(filePath)) continue;
          if (!filePath || filePath.startsWith('exact:')) continue;

          const id = `file:${filePath}`;
          if (!semantic.some(s => s.id === id)) {
            semantic.push({
              id,
              rank: 0,
              meta: {
                row: {
                  path: filePath,
                  content: er.content_snippet,
                  updated_at: er.created_at,
                  score: exactBoost,
                },
                kind: 'file',
                boosts: { exactMatch: true, authority: AUTHORITY.CODE_FILE },
                similarity: exactBoost,
                authorityWeight: AUTHORITY.CODE_FILE,
              },
            });
          }
        } else if (er.source_type === 'file') {
          // cb_files are conversation attachments — route to Conversations, not Code Files
          const id = `conv-file:${er.source_id}`;
          if (!semantic.some(s => s.id === id)) {
            semantic.push({
              id,
              rank: 0,
              meta: {
                row: {
                  path: `conversation:${er.conversation_id}`,
                  content: er.content_snippet,
                  updated_at: er.created_at,
                  score: exactBoost,
                  provider: undefined,
                },
                kind: 'message',
                boosts: { exactMatch: true, authority: AUTHORITY.MESSAGE },
                similarity: exactBoost,
                authorityWeight: AUTHORITY.MESSAGE,
                conversationUrl: (er as any).conversation_url,
                conversationTitle: (er as any).conversation_title,
              },
            });
          }
        }
      }
      console.log('[retriever] Injected exact match results:', exactResults.length);
    }

    // ---------- MESSAGE KEYWORD SEARCH (BM25 for conversations) ----------
    let messageKeywordRows: Array<{
      message_id: string;
      conversation_id: string;
      role: string;
      content_snippet: string;
      created_at: string;
      score: number;
      match_type: string;
      provider: string;
    }> = [];
    
    try {
      const messageKeywordRes = await this.sb.rpc('cb_search_messages_keyword', {
        p_project_id: projectId,  // Use conversation project, not code project
        p_query: query,
        p_limit: 30,
      });
      
      if (messageKeywordRes?.data) {
        messageKeywordRows = messageKeywordRes.data.map((r: any) => ({
          message_id: r.message_id,
          conversation_id: r.conversation_id,
          role: r.role,
          content_snippet: r.content_snippet,
          created_at: r.created_at,
          score: r.score,
          match_type: r.match_type,
          provider: r.provider,
        }));
        console.log('[retriever] cb_search_messages_keyword completed:', Date.now() - t0, 'ms, rows:', messageKeywordRows.length);
      } else if (messageKeywordRes?.error) {
        console.warn('[retriever] cb_search_messages_keyword error:', messageKeywordRes.error);
      }
    } catch (e) {
      console.warn('[retriever] cb_search_messages_keyword threw:', e);
    }

    // Map message keyword results to semantic array with MESSAGE authority
    messageKeywordRows.forEach((r, i) => {
      // Apply MESSAGE authority weight
      const authorityAdjustedScore = r.score * AUTHORITY.MESSAGE;
      
      // Boost exact matches higher than fulltext
      const matchBoost = r.match_type === 'exact' ? 1.3 : 1.0;
      const finalScore = authorityAdjustedScore * matchBoost;
      
      semantic.push({
        id: `message:${r.message_id}`,
        rank: i + 1,
        meta: {
          row: {
            path: `conversation:${r.conversation_id}`,
            content: r.content_snippet,
            updated_at: r.created_at,
            score: finalScore,
            provider: r.provider
          },
          kind: 'message',
          boosts: { keywordMessageHit: matchBoost, authority: AUTHORITY.MESSAGE },
          similarity: r.score,
          matchType: r.match_type,
          authorityWeight: AUTHORITY.MESSAGE
        }
      });
    });
    
    console.log('[retriever] Message keyword results added to semantic:', messageKeywordRows.length);

    // ---------- FILE KEYWORD SEARCH (BM25 for attached documents) ----------
    let fileKeywordRows: Array<{
      file_id: string;
      conversation_id: string;
      file_name: string;
      file_type: string;
      content_snippet: string;
      created_at: string;
      score: number;
      match_type: string;
    }> = [];
    
    try {
      const fileKeywordRes = await this.sb.rpc('cb_search_files_keyword', {
        p_project_id: projectId,  // Use conversation project, not code project
        p_query: query,
        p_limit: 20,
      });
      
      if (fileKeywordRes?.data) {
        fileKeywordRows = fileKeywordRes.data.map((r: any) => ({
          file_id: r.out_file_id,
          conversation_id: r.out_conversation_id,
          file_name: r.out_file_name,
          file_type: r.out_file_type,
          content_snippet: r.out_content_snippet,
          created_at: r.out_created_at,
          score: r.out_score,
          match_type: r.out_match_type,
        }));
        console.log('[retriever] cb_search_files_keyword completed:', Date.now() - t0, 'ms, rows:', fileKeywordRows.length);
      } else if (fileKeywordRes?.error) {
        console.warn('[retriever] cb_search_files_keyword error:', fileKeywordRes.error);
      }
    } catch (e) {
      console.warn('[retriever] cb_search_files_keyword threw:', e);
    }

    // Map file keyword results to semantic array — these are conversation-attached files, NOT Codex source code
    fileKeywordRows.forEach((r, i) => {
      const filePath = r.file_name || `file:${r.file_id}`;

      // Skip msg_ snippets entirely
      if (isMessageSnippet(filePath)) return;

      // Determine authority based on file type
      let authority = AUTHORITY.ATTACHED_DOC;
      if (/\.(md|markdown|txt)$/i.test(filePath)) {
        authority = AUTHORITY.DOCUMENT;
      }
      
      // Apply authority weight
      const authorityAdjustedScore = r.score * authority;
      
      // Boost exact and filename matches
      const matchBoost = r.match_type === 'exact' ? 1.3 : 
                         r.match_type === 'filename' ? 1.4 : 1.0;
      const finalScore = authorityAdjustedScore * matchBoost;
      
      semantic.push({
        id: `conv-file:${filePath}:${r.conversation_id || i}`,
        rank: i + 1,
        meta: {
          row: {
            path: `conversation:${r.conversation_id}`,
            content: r.content_snippet,
            updated_at: r.created_at,
            score: finalScore,
            provider: undefined,
          },
          kind: 'message',
          boosts: { keywordFileHit: matchBoost, authority },
          similarity: r.score,
          matchType: r.match_type,
          authorityWeight: authority,
          fileType: r.file_type
        }
      });
    });
    
    console.log('[retriever] File keyword results added to semantic:', fileKeywordRows.length);

    // Code spans (from code files)
    try {
      const codeRes = await this.sb.rpc('cb_find_code_spans', {
        p_project_id: projectId,
        p_q: query,
        p_window_lines: 6,
        p_max_results: 20
      });

      const codeRows: Array<{
        path?: string;
        start_line?: number;
        end_line?: number;
        snippet?: string;
        score?: number;
        updated_at?: string;
      }> = codeRes?.data ?? [];

      console.log('[retriever] Code spans found:', codeRows.length);

      codeRows.forEach((r, i) => {
        const p = cleanPath(r.path || '');
        const { pass, boosts } = opFilters(p, { ...req.operators, __q: query } as any);
        if (!pass) return;

        const codeBoosts = { ...boosts, codeHit: 1.0, authority: AUTHORITY.CODE_SPAN };

        // Apply boilerplate penalty in code-seeking mode
        if (intent === 'code_seeking' && isBoilerplate(r.snippet || '')) {
          codeBoosts.codeHit = 0.2;
        }

        // Apply authority to score
        const authorityAdjustedScore = (r.score ?? 0) * AUTHORITY.CODE_SPAN;

        keywordSpans.push({
          id: `span:${p}#${r.start_line}-${r.end_line}`,
          rank: i + 1,
          meta: { 
            row: { ...r, path: p, score: authorityAdjustedScore }, 
            kind: 'span', 
            boosts: codeBoosts,
            authorityWeight: AUTHORITY.CODE_SPAN,
            source: 'rpc:cb_find_code_spans[tiered]'
          }
        });
      });
    } catch (e) {
      console.warn('[retriever] cb_find_code_spans failed:', e);
    }

    // Document/text spans
    try {
      const docRes = await this.sb.rpc('cb_find_text_spans', {
        p_project_id: projectId,
        p_q: query,
        p_window_lines: 8,
        p_max_results: 20
      });

      const rows = normalize0to1<SpanRow>(docRes?.data ?? []);
      rows.forEach((r, i) => {
        const p = cleanPath(r.path);
        const { pass, boosts } = opFilters(p, { ...req.operators, __q: query } as any);
        if (!pass) return;
        const docBoosts = { ...boosts, docHit: 0.8 };
        keywordSpans.push({
          id: `span:${p}#${r.start_line}-${r.end_line}`,
          rank: i + 1,
          meta: { row: { ...r, path: p }, kind: 'span', boosts: docBoosts, source: 'rpc:cb_find_text_spans' }
        });
      });
    } catch (e) {
      console.warn('[retriever] cb_find_text_spans failed:', e);
    }

    // ---------- LITERAL TOKEN EXPANSION (PARALLEL) ----------
    const literalTokens = extractLiterals(query);

    const litSpanPromises = literalTokens.map(async (lit) => {
      try {
        const sRes = await this.sb.rpc('cb_find_code_spans', {
          p_project_id: projectId,
          p_q: lit,
          p_window_lines: 6,
          p_max_results: 12
        });
        return { lit, rows: normalize0to1<SpanRow>(sRes?.data ?? []) };
      } catch {
        return { lit, rows: [] as SpanRow[] };
      }
    });

    const litResults = await Promise.all(litSpanPromises);

    for (const { rows } of litResults) {
      rows.forEach((r, i) => {
        const p = cleanPath(r.path);
        const { pass, boosts } = opFilters(p, { ...req.operators, __q: query } as any);
        if (!pass) return;
        const litBoosts = {
          ...boosts,
          symbolSim: Math.max(0.95, (boosts as any).symbolSim || 0),
          filenameMatch: Math.max((boosts as any).filenameMatch || 0, p.endsWith('content-simple.js') ? 1 : 0)
        };
        keywordSpans.push({
          id: `span:${p}#${r.start_line}-${r.end_line}`,
          rank: i + 1,
          meta: { row: { ...r, path: p }, kind: 'span', boosts: litBoosts, source: 'rpc:cb_find_code_spans[literal]' }
        });
      });
    }

    // ---------- KG / ENTITY EXPANSION ----------
    const kg: RankItem[] = [];
    try {
      const entsRes = await this.sb.rpc('cb_find_entities', {
        p_project_id: projectId, p_q: query, p_max_results: 5
      });
      const ents: { entity_id: string; name: string }[] = entsRes?.data ?? [];
      let rankCounter = 1;

      for (const ent of ents) {
        let entSpans: SpanRow[] = [];
        try {
          const sRes = await this.sb.rpc('cb_find_code_spans', {
            p_project_id: projectId, p_q: ent.name, p_window_lines: 6, p_max_results: 10
          });
          entSpans = normalize0to1<SpanRow>(sRes?.data ?? []);
        } catch (e) {
          console.warn('[retriever] entity span search threw:', e);
        }

        for (const r of entSpans) {
          const p = cleanPath(r.path);
          const { pass, boosts } = opFilters(p, { ...req.operators, __q: query } as any);
          if (!pass) continue;
          kg.push({
            id: `span:${p}#${r.start_line}-${r.end_line}`,
            rank: rankCounter++,
            meta: { row: { ...r, path: p }, kind: 'span', boosts, entity: ent.name, source: 'rpc:cb_find_entities' }
          });
        }
      }
    } catch (e) {
      console.warn('[retriever] KG/entity expansion failed:', e);
    }

    console.log('[retriever] Final counts:', {
      keyword_files: keywordFiles.length,
      keyword_spans: keywordSpans.length,
      semantic: semantic.length,
      total: keywordFiles.length + keywordSpans.length + semantic.length
    });

    // DEBUG: Log candidate pool summary
    console.log('[retriever:DEBUG] === Candidate Pool Summary ===');
    console.log('[retriever:DEBUG] Query:', query);
    console.log('[retriever:DEBUG] Intent:', intent);
    console.log('[retriever:DEBUG] Keyword files:', keywordFiles.slice(0, 5).map(f => ({ id: f.id, src: f.meta?.source })));
    console.log('[retriever:DEBUG] Keyword spans:', keywordSpans.slice(0, 5).map(s => ({ id: s.id, src: s.meta?.source })));
    console.log('[retriever:DEBUG] Semantic:', semantic.slice(0, 5).map(s => ({ id: s.id, src: s.meta?.source, sim: s.meta?.similarity?.toFixed(3) })));
    console.log('[retriever:DEBUG] KG:', kg.slice(0, 5).map(k => ({ id: k.id, src: k.meta?.source })));

    // Check for key files
    const allIds = [...keywordFiles, ...keywordSpans, ...semantic, ...kg].map(x => x.id);
    const hasRetriever = allIds.some(id => id.includes('retriever'));
    const hasRankCombiner = allIds.some(id => id.includes('rank-combiner'));
    console.log('[retriever:DEBUG] Contains supabase-retriever?', hasRetriever);
    console.log('[retriever:DEBUG] Contains rank-combiner?', hasRankCombiner);

    // Inject BM25 file-level entries into semantic pool for RRF fusion
    keywordSpans.push(...bm25FileEntries);

    // ---------- Return lists for fusion ----------
    return {
      keyword: [...keywordFiles, ...keywordSpans],
      semantic,
      kg,
      uiIndex: { files: topFilesForUi },
      bestMessage: bestMsgLite,
      intent,
    };
  }

  async getSignals(id: string) {
    const isSpan = id.startsWith('span:');
    const path = id.replace(/^span:|^file:/, '').split('#')[0];
    const ext = (path.split('.').pop() || '').toLowerCase();

    // Check if it's a msg_ file - should have very low code density
    if (isMessageSnippet(path)) {
      return {
        codeDensity: 0.05,
        filenameMatch: 0,
        pathMatch: 0,
        symbolSim: 0,
        recency: 0,
        entityOverlap: 0,
        semanticScore: 0,
        kgScore: 0,
        docHit: 0,
      };
    }

    const codeish = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'cs', 'php', 'rb', 'kt', 'c', 'cc', 'cpp', 'h', 'hpp'].includes(ext);

    return {
      codeDensity: isSpan ? 1 : (codeish ? 0.4 : 0.1),
      filenameMatch: 0,
      pathMatch: 0,
      symbolSim: 0,
      recency: 0,
      entityOverlap: 0,
      semanticScore: 0,
      kgScore: 0,
      docHit: 0,
    };
  }
}

function extractFilenameTokens(q: string): string[] {
  const s = String(q || '');
  // direct filenames like supabase.ts, content-universal.js, index.html
  const files = s.match(/[A-Za-z0-9._-]+\.(ts|tsx|js|jsx|html|css|py|md|json|sql|pdf|docx|xlsx)/gi) || [];
  // also allow bare basename tokens often used: rank-combiner, supabase-retriever
  const bare = s.match(/[A-Za-z0-9_-]{6,}/g) || [];
  const interestingBare = bare.filter(t => /-/.test(t) && t.length <= 40);
  return Array.from(new Set([...files, ...interestingBare])).slice(0, 5);
}

function looksLikeFilenameQuery(q: string): boolean {
  return extractFilenameTokens(q).length > 0;
}


// ============================================================================
// TIERED RESPONSE CONVERTER
// ============================================================================

/**
 * Converts the legacy RetrieveLists format to the new TieredSearchResponse format.
 * Used by endpoints that want to return structured tiered results.
 */
export function toTieredResponse(
  query: string,
  lists: RetrieveLists,
  startTime: number
): TieredSearchResponse {
  const intent: QueryIntent = lists.intent ?? 'general';

  // DEBUG: Log what we received
  console.log('[toTieredResponse] DEBUG - Input lists:', {
    keywordCount: lists.keyword?.length ?? 0,
    semanticCount: lists.semantic?.length ?? 0,
    kgCount: lists.kg?.length ?? 0,
    sampleKeyword: lists.keyword?.[0],
    sampleSemantic: lists.semantic?.[0],
  });

  // --- Extract Artifacts (files/spans from semantic + keyword) ---
  const artifactMap = new Map<string, ArtifactHit>();
  const channelSources = new Map<string, Set<string>>();

  // Track which artifacts came from non-embedding channels (for channel quotas)
  function trackChannel(path: string, source: string) {
    const src = normalizeSource(source);
    if (!channelSources.has(path)) channelSources.set(path, new Set());
    channelSources.get(path)!.add(src);
  }

  function normalizeSource(src: string): string {
    const s = String(src || '').trim();
    if (s.startsWith('rpc:cb_search_artifact_keys')) return 'rpc:cb_search_artifact_keys';
    if (s.startsWith('rpc:cb_search_chunks_keyword')) return 'rpc:cb_search_chunks_keyword[file]';
    if (s.startsWith('rpc:cb_match_symbols')) return 'rpc:cb_match_symbols';
    return s || 'unknown';
  }

  // ── Identifier Evidence Gate: collect per-file evidence ──
  const evidenceMap = new Map<string, {
    symbolHit: boolean; symbolScore: number;
    bm25Hit: boolean; bm25Norm: number;
    filenameMention: boolean;
    codexHit: boolean;
    artifactKeyHit: boolean; tokensMatched: number; basenameHits: number;
  }>();

  function trackEvidence(filePath: string, patch: Partial<typeof evidenceMap extends Map<string, infer V> ? V : never>) {
    const cur = evidenceMap.get(filePath) || {
      symbolHit: false, symbolScore: 0, bm25Hit: false, bm25Norm: 0,
      filenameMention: false, codexHit: false, artifactKeyHit: false, tokensMatched: 0, basenameHits: 0,
    };
    evidenceMap.set(filePath, {
      symbolHit: cur.symbolHit || patch.symbolHit || false,
      symbolScore: Math.max(cur.symbolScore, patch.symbolScore ?? 0),
      bm25Hit: cur.bm25Hit || patch.bm25Hit || false,
      bm25Norm: Math.max(cur.bm25Norm, patch.bm25Norm ?? 0),
      filenameMention: cur.filenameMention || patch.filenameMention || false,
      codexHit: cur.codexHit || patch.codexHit || false,
      artifactKeyHit: cur.artifactKeyHit || patch.artifactKeyHit || false,
      tokensMatched: Math.max(cur.tokensMatched, patch.tokensMatched ?? 0),
      basenameHits: Math.max(cur.basenameHits, patch.basenameHits ?? 0),
    });
  }

  // Determine if query wants implementation vs. specific named resources
  const queryLower = query.toLowerCase();
  const wantsImplementation = /\b(logic|implementation|how|works?|endpoint|handler|where is the .* (code|function|method))\b/i.test(query);
  const wantsSpecificResource = /\b(types?|interface|ui|dashboard|html|css|config|schema)\b/i.test(queryLower);

  // Only boost semantic when looking for implementation AND not asking for specific resource types
  let semanticBoost = 1.0;
  let keywordPenalty = 1.0;
  
  if (intent === 'code_seeking' && wantsImplementation && !wantsSpecificResource) {
    semanticBoost = SEARCH_CONFIG.intentBoosts.codeSeekingSemantic;
    keywordPenalty = SEARCH_CONFIG.intentBoosts.codeSeekingKeywordPenalty;
  }

  // Process semantic results (files) - apply boost for code_seeking
  for (const item of lists.semantic) {
    const meta = item.meta as any;
    if (meta?.kind === 'file') {
      const path = meta?.row?.path ?? item.id.replace(/^file:/, '');
      if (!path || path.startsWith('conversation:')) continue;
      if (isMessageSnippet(path)) continue;
      
      // Exclude meta-files from artifact results (but allow in conversations)
      const { searchExclusions } = SEARCH_CONFIG;
      if (searchExclusions.fullExclude.some(ex => path.endsWith(ex) || path.includes(ex))) continue;
      if (searchExclusions.filesOnlyExclude.some(ex => {
        const pattern = ex.includes('*') ? new RegExp(ex.replace(/\*/g, '.*'), 'i') : null;
        return pattern ? pattern.test(path) : path.includes(ex);
      })) continue;
      
      // Filter garbage paths leaked from ingestion
      const filename = path.includes('/') ? path.split('/').pop() ?? null : path;
      const garbageCheck = isGarbageFileHit(path, filename);
      if (garbageCheck.garbage) {
        if (process.env.CB_DEBUG) {
          console.log(`[toTieredResponse] Dropped garbage (semantic): ${garbageCheck.reason}`, {
            id: item.id, rawPath: meta?.row?.path, score: meta?.similarity,
            source: meta?.kind ?? 'unknown',
            chunkId: meta?.row?.id ?? null,
            projectId: meta?.row?.project_id ?? null,
          });
        }
        continue;
      }
      
      const existing = artifactMap.get(path);
      const rawScore = meta?.similarity ?? meta?.row?.score ?? 0;
      // Normalize BM25 scores (>1.0) to 0-1 range; cosine similarity (<1.0) passes through
      const rawSimilarity = rawScore > 1.0 
        ? 1.0 / (1.0 + Math.exp(-0.5 * (rawScore - 2))) 
        : rawScore;
      const similarity = rawSimilarity * semanticBoost;  // Apply boost
      
      if (!existing || similarity > existing.similarity) {
        artifactMap.set(path, {
          path,
          filename: path.split('/').pop() ?? null,
          similarity,
          preview: meta?.row?.preview ?? undefined,
          updatedAt: meta?.row?.updated_at ?? undefined,
        });
      }
      trackChannel(path, meta?.source ?? 'unknown');

      // Collect evidence for identifier gate
      const sBoosts = meta?.boosts || {};
      const isCodexVectorHit = String(meta?.source ?? '').includes('cb_search_codex_vectors');
      trackEvidence(path, {
        symbolHit: !!sBoosts.symbolHit || isCodexVectorHit,
        symbolScore: Number(
          sBoosts.symbolScore ??
          (isCodexVectorHit ? rawSimilarity :
          ((sBoosts.symbolHit && String(meta?.source ?? '').includes('cb_match_symbols'))
            ? (meta?.row?.score ?? 0) : 0))
        ),
        bm25Hit: !!sBoosts.bm25Hit,
        bm25Norm: Number(sBoosts.bm25Norm ?? 0),
        filenameMention: !!sBoosts.filenameMention,
        artifactKeyHit: !!sBoosts.artifactKeyHit,
        tokensMatched: Number(sBoosts.tokensMatched ?? 0),
        basenameHits: Number(sBoosts.basenameHits ?? 0),
        codexHit: isCodexVectorHit,
      });
    }
  }

  // Process keyword results (files + spans) - apply penalty for code_seeking
  for (const item of lists.keyword) {
    const meta = item.meta as any;
    const row = meta?.row;
    if (!row?.path) continue;
    
    const path = row.path;
    if (!path || typeof path !== 'string') continue;
    if (path.startsWith('conversation:')) continue;
    if (isMessageSnippet(path)) continue;
      
      // Exclude meta-files from artifact results (but allow in conversations)
      const { searchExclusions } = SEARCH_CONFIG;
      if (searchExclusions.fullExclude.some(ex => path.endsWith(ex) || path.includes(ex))) continue;
      if (searchExclusions.filesOnlyExclude.some(ex => {
        const pattern = ex.includes('*') ? new RegExp(ex.replace(/\*/g, '.*'), 'i') : null;
        return pattern ? pattern.test(path) : path.includes(ex);
      })) continue;

    // Filter garbage paths leaked from ingestion
    const filename = row.filename ?? (path.includes('/') ? path.split('/').pop() ?? null : path);
    const garbageCheck = isGarbageFileHit(path, filename);
    if (garbageCheck.garbage) {
      if (process.env.CB_DEBUG) {
        console.log(`[toTieredResponse] Dropped garbage (keyword): ${garbageCheck.reason}`, {
          path, filename: row.filename, score: row.score,
          source: meta?.kind ?? 'unknown',
          chunkId: item.id ?? null,
          projectId: row.project_id ?? null,
        });
      }
      continue;
    }

    const isSpan = meta?.kind === 'span';
    const rawScore = row.score ?? 0;
    // Normalize keyword/BM25 scores to 0-1 range using sigmoid-like compression
    const rawSimilarity = rawScore > 1.0 ? 1.0 / (1.0 + Math.exp(-0.5 * (rawScore - 2))) : rawScore;
    const similarity = rawSimilarity * keywordPenalty;

    // Normalize: check if a longer-path version already exists (e.g. "agent/x.ts" vs "packages/.../agent/x.ts")
    let normalizedPath = path;
    if (!artifactMap.has(path)) {
      for (const [existingPath] of artifactMap) {
        if (existingPath.endsWith('/' + path) || path.endsWith('/' + existingPath)) {
          normalizedPath = existingPath.endsWith('/' + path) ? existingPath : path;
          // If the shorter path was stored, re-key to the longer one
          if (normalizedPath !== existingPath) {
            const old = artifactMap.get(existingPath)!;
            artifactMap.delete(existingPath);
            artifactMap.set(normalizedPath, { ...old, path: normalizedPath });
          }
          break;
        }
      }
    }
    
    const existing = artifactMap.get(normalizedPath);
    
    // If this file was already found by semantic search, combine scores
    if (existing) {
      // === SAFE ROLLOUT: Conditional Fusion Logic ===
      // For Code Search: Use MAX. We trust exact symbol matches over general semantic "vibes".
      // For Memory/General: Use AVERAGE. We need a blend of keyword and meaning.
      const useMaxFusion = intent === 'code_seeking';
      
      let combined;
      if (useMaxFusion) {
          // Aggressive: Take the highest signal.
          // If keyword match is 1.0 and semantic is 0.4, result is 1.0.
          combined = Math.min(
            Math.max(existing.similarity, similarity),
            SEARCH_CONFIG.scoring.maxDisplayScore
          );
      } else {
          // Conservative: Weighted blend (Legacy behavior).
          // Prevents keyword spam from overriding semantic meaning in conversation searches.
          combined = Math.min(
            existing.similarity * 0.6 + similarity * 0.4,
            SEARCH_CONFIG.scoring.maxDisplayScore
          );
      }

      // Only update if combined score is better, keep span info if available
      if (combined > existing.similarity || (isSpan && !existing.startLine)) {
        artifactMap.set(path, {
          ...existing,
          similarity: Math.max(combined, existing.similarity),
          preview: isSpan ? row.snippet?.substring(0, 200) : existing.preview,
          startLine: isSpan ? row.start_line : existing.startLine,
          endLine: isSpan ? row.end_line : existing.endLine,
        });
      }
      trackChannel(path, meta?.source ?? 'unknown');

      // Collect evidence for identifier gate
      const kBoosts = meta?.boosts || {};
      trackEvidence(normalizedPath, {
        symbolHit: !!kBoosts.symbolHit,
        symbolScore: Number(
          kBoosts.symbolScore ??
          ((kBoosts.symbolHit && String(meta?.source ?? '').includes('cb_match_symbols'))
            ? (meta?.row?.score ?? 0) : 0)
        ),
        bm25Hit: !!kBoosts.bm25Hit,
        bm25Norm: Number(kBoosts.bm25Norm ?? 0),
        filenameMention: !!kBoosts.filenameMention,
        artifactKeyHit: !!kBoosts.artifactKeyHit,
        tokensMatched: Number(kBoosts.tokensMatched ?? 0),
        basenameHits: Number(kBoosts.basenameHits ?? 0),
        codexHit: false,
      });
    } else {
      artifactMap.set(normalizedPath, {
        path: normalizedPath,
        filename: row.filename ?? normalizedPath.split('/').pop() ?? null,
        similarity,
        preview: isSpan ? row.snippet?.substring(0, 200) : undefined,
        startLine: isSpan ? row.start_line : undefined,
        endLine: isSpan ? row.end_line : undefined,
        updatedAt: row.updated_at ?? undefined,
      });
      trackChannel(normalizedPath, meta?.source ?? 'unknown');
    }
  }

  // Extract filenames mentioned in the query
  const mentionedFiles = (query.match(/[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|php|rb|kt|c|cc|cpp|h|hpp|html|css|json|yaml|yml|xml|toml|sql|sh|bash|md|txt|pdf|docx?|csv|xlsx?|xls|pptx?|ppt)\b/gi) || [])
    .map(f => f.toLowerCase());

  // Clamp, apply filename-mention boost, sort, then apply threshold
  const sortedArtifacts: ArtifactHit[] = Array.from(artifactMap.values())
    .map(a => {
      let sim = Math.min(a.similarity, SEARCH_CONFIG.scoring.maxDisplayScore);
      // Boost if this file was explicitly named in the query
      if (mentionedFiles.length > 0) {
        const fname = (a.filename || a.path.split('/').pop() || '').toLowerCase();
        if (mentionedFiles.some(mf => fname.includes(mf) || mf.includes(fname))) {
          sim = Math.min(sim * SEARCH_CONFIG.scoring.filenameMentionBoost, SEARCH_CONFIG.scoring.maxDisplayScore);
        }
      }
      return { ...a, similarity: sim };
    })
    .sort((a, b) => b.similarity - a.similarity);

  const artifactCutoff = Math.max(
    SEARCH_CONFIG.scoring.minDisplayScore,
    (sortedArtifacts[0]?.similarity ?? 0) * SEARCH_CONFIG.scoring.relativeThreshold
  );

  // Channel quotas: guarantee top N results per non-embedding channel survive the cutoff.
  // This prevents high-scoring embedding results from suppressing all lexical/BM25/symbol hits.
  const CHANNEL_QUOTAS: Record<string, number> = {
    'rpc:cb_search_artifact_keys': 3,
    'rpc:cb_match_symbols': 2,
  };
  const RESCUE_MIN_SCORE = 0.25; // don't rescue truly weak results
  const rescuedPaths = new Set<string>();

  for (const [channel, quota] of Object.entries(CHANNEL_QUOTAS)) {
    let rescued = 0;
    for (const a of sortedArtifacts) {
      if (rescued >= quota) break;
      const sources = channelSources.get(a.path);
      if (sources?.has(channel) && a.similarity < artifactCutoff && a.similarity >= RESCUE_MIN_SCORE) {
        rescuedPaths.add(a.path);
        rescued++;
      }
    }
  }

  if (rescuedPaths.size > 0) {
    console.log('[toTieredResponse] Channel quotas rescued:', Array.from(rescuedPaths));
  }

  const allArtifacts = sortedArtifacts.filter(
    a => a.similarity >= artifactCutoff || rescuedPaths.has(a.path)
  );

  // Deduplicate by filename
  const seenFilenames = new Map<string, ArtifactHit>();
  const artifacts: ArtifactHit[] = [];
  for (const a of allArtifacts) {
    const fname = (a.filename || a.path.split('/').pop() || '').toLowerCase();
    if (!fname) continue;
    const existing = seenFilenames.get(fname);
    if (!existing) {
      seenFilenames.set(fname, a);
      artifacts.push(a);
    }
    // else: skip duplicate filename (we already have the higher-scored one since array is sorted)
    if (artifacts.length >= SEARCH_CONFIG.resultCaps.maxArtifacts + rescuedPaths.size) break;
  }

  // ── Post-Fusion Self-Evidence Multiplier ──
  // For identifier queries, adjust fused scores based on whether the file
  // DEFINES the queried symbol (self-evidence) vs merely being DISCUSSED alongside it.
  // This runs AFTER fusion so keyword scores can't override the penalty.
  // Analogous to Google prioritizing a page containing a VIN over a forum discussing it.
  {
    const isIdentifierQuery =
      /[a-z][A-Z]/.test(query) || /[a-z]_[a-z]/.test(query) || /\bcb_[a-z0-9_]+\b/i.test(query);

    if (isIdentifierQuery) {
      const { identifierDominance } = SEARCH_CONFIG;
      for (const a of artifacts) {
        const ev = evidenceMap.get(a.path);
        let multiplier = 1.0;

        if (ev?.symbolHit) {
          if (ev.symbolScore >= identifierDominance.symbolThreshold) {
            // Graduated: interpolate between symbolWeak and symbolHit based on symbolScore
            const t = (ev.symbolScore - identifierDominance.symbolThreshold) / (1.0 - identifierDominance.symbolThreshold);
            multiplier = identifierDominance.symbolWeak + (identifierDominance.symbolHit - identifierDominance.symbolWeak) * t;
          } else {
            multiplier = identifierDominance.symbolWeak;
          }
        } else if (ev?.bm25Hit) {
          multiplier = identifierDominance.bm25Hit;
        } else if (ev?.filenameMention) {
          multiplier = identifierDominance.filenameOnly;
        } else {
          multiplier = identifierDominance.noEvidence;
        }

        const before = a.similarity;
        a.similarity = a.similarity * multiplier;  // No cap here — sorting needs uncapped values
        if (multiplier !== 1.0) {
          console.log('[post-fusion-evidence]', a.filename || a.path, {
            before: before.toFixed(3),
            multiplier,
            after: a.similarity.toFixed(3),
            reason: ev?.symbolHit
              ? `symbol(${ev.symbolScore.toFixed(2)})`
              : ev?.bm25Hit ? 'bm25' : ev?.filenameMention ? 'filename' : 'no-evidence'
          });
        }
      }

      // Re-sort after applying multipliers
      artifacts.sort((a, b) => b.similarity - a.similarity);
    }
  }

  // ── Identifier Evidence Gate ──
  // For identifier queries, remove files that lack strong retrieval evidence.
  // This prevents conversation-bleed files (inflated embedding scores from mentions) from appearing.
  const { identifierEvidenceGate } = SEARCH_CONFIG;
  if (identifierEvidenceGate.enabled) {
    const hasIdentifier = !identifierEvidenceGate.applyToIdentifierQueriesOnly ||
      /[a-z][A-Z]/.test(query) || /[a-z]_[a-z]/.test(query) || /\bcb_[a-z0-9_]+\b/i.test(query);

    if (hasIdentifier) {
      const gated: ArtifactHit[] = [];
      const ungated: ArtifactHit[] = [];

      for (const a of artifacts) {
        const ev = evidenceMap.get(a.path);
        let passes = false;
        if (ev) {
          if (ev.symbolHit && ev.symbolScore >= identifierEvidenceGate.symbolThreshold) passes = true;
          if (ev.bm25Hit && ev.bm25Norm >= identifierEvidenceGate.bm25Threshold) passes = true;
          if (ev.filenameMention) passes = true;
          if (ev.artifactKeyHit && (
            ev.tokensMatched >= identifierEvidenceGate.minTokensMatched ||
            (identifierEvidenceGate.allowBasenameHit && ev.basenameHits >= 1)
          )) passes = true;
          // Strong Codex vector hits bypass gate — matched identifier in actual code
          if (ev.codexHit && ev.symbolScore >= SEARCH_CONFIG.identifierDominance.symbolThreshold) passes = true;
        }
        console.log('[evidence-gate]', a.filename || a.path, {
          similarity: a.similarity?.toFixed(3),
          ev: ev ? {
            sym: ev.symbolHit ? `${ev.symbolScore.toFixed(2)}` : '-',
            bm25: ev.bm25Hit ? `${ev.bm25Norm.toFixed(2)}` : '-',
            fname: ev.filenameMention,
            ak: ev.artifactKeyHit ? `tok=${ev.tokensMatched},bn=${ev.basenameHits}` : '-',
          } : 'NONE',
          passes,
        });
        if (passes) {
          gated.push(a);
        } else {
          ungated.push(a);
        }
      }

      // Apply gate, but respect minKeep
      if (gated.length >= identifierEvidenceGate.minKeep) {
        if (ungated.length > 0) {
          console.log('[toTieredResponse] Identifier evidence gate removed:', ungated.map(a => a.filename || a.path));
        }
        artifacts.length = 0;
        artifacts.push(...gated);
      } else {
        // Not enough gated results — backfill from ungated to reach minKeep
        const backfill = ungated.slice(0, identifierEvidenceGate.minKeep - gated.length);
        console.log('[toTieredResponse] Identifier evidence gate: only', gated.length,
          'passed, backfilling', backfill.length, 'to meet minKeep');
        artifacts.length = 0;
        artifacts.push(...gated, ...backfill);
      }
    }
  }

  // ── Final UI Clamp ── (deferred from post-fusion to preserve sort fidelity)
  for (const a of artifacts) {
    a.similarity = Math.min(a.similarity, SEARCH_CONFIG.scoring.maxDisplayScore);
  }

  // --- Extract Memory (messages from semantic) ---
  const memoryMap = new Map<string, MemoryHit>();

  for (const item of lists.semantic) {
    const meta = item.meta as any;
    if (meta?.kind === 'message') {
      const row = meta?.row;
      const messageId = item.id.replace(/^message:/, '');
      
      if (!memoryMap.has(messageId)) {
        const rawMsgScore = meta?.similarity ?? row?.score ?? 0;
        const normalizedMsgScore = rawMsgScore > 1.0 
          ? 1.0 / (1.0 + Math.exp(-0.5 * (rawMsgScore - 2))) 
          : rawMsgScore;
        memoryMap.set(messageId, {
          id: messageId,
          conversationId: row?.path?.replace('conversation:', '') ?? '',
          preview: row?.content ?? '',
          similarity: normalizedMsgScore,
          createdAt: row?.updated_at ?? undefined,
          provider: row?.provider ?? undefined,
        });
      }
    }
  }

 // Clamp, sort, then apply absolute + relative threshold
  const sortedMessages: MemoryHit[] = Array.from(memoryMap.values())
    .map(m => ({ ...m, similarity: Math.min(m.similarity, SEARCH_CONFIG.scoring.maxDisplayScore) }))
    .sort((a, b) => b.similarity - a.similarity);

  // Boost messages whose content contains query tokens (breaks embedding score ties)
  const { messageContentBoost } = SEARCH_CONFIG;
  const normalizedQuery = query.toLowerCase().trim();

  // Create a "Core Phrase" by stripping common conversational filler 
  // This helps when the user asks "In which conversation can I find Path A Roadmap?"
  const corePhrase = normalizedQuery
    .replace(/^(in which conversation can i find the|where is the|can you find the|show me the|what did we decide about the)\s+/i, '')
    .trim();

  const msgQueryTokens = corePhrase.toLowerCase().split(/\s+/).filter(t => t.length > 2 && !SEARCH_CONFIG.stopWords.has(t));
  
  if (msgQueryTokens.length > 0) {
    for (const m of sortedMessages) {
      const hay = (m.preview || '').toLowerCase();
      let contentBoost = 0;

      // A. Individual Token Match (Density)
      for (const token of msgQueryTokens) {
        if (hay.includes(token)) contentBoost += messageContentBoost.perTokenBoost;
      }

      // B. Exact Phrase Match
      // Check both the full query and the "Core Phrase"
      if (hay.includes(normalizedQuery) || (corePhrase.length > 5 && hay.includes(corePhrase))) {
        contentBoost += messageContentBoost.phraseMatchBoost;
      }

      m.similarity = Math.min(m.similarity + Math.min(contentBoost, messageContentBoost.maxBoost), SEARCH_CONFIG.scoring.maxDisplayScore);
    }
    sortedMessages.sort((a, b) => b.similarity - a.similarity);
  }

  const messageCutoff = Math.max(
    SEARCH_CONFIG.scoring.minDisplayScore,
    (sortedMessages[0]?.similarity ?? 0) * SEARCH_CONFIG.scoring.relativeThreshold
  );
  const MAX_MSGS_PER_CONV_OUTPUT = 2;
  const convMsgCount = new Map<string, number>();
  const messages: MemoryHit[] = sortedMessages
    .filter(m => m.similarity >= messageCutoff)
    .filter(m => m.conversationId && m.conversationId !== 'null' && m.conversationId !== '')
    .filter(m => {
      const count = convMsgCount.get(m.conversationId) ?? 0;
      if (count >= MAX_MSGS_PER_CONV_OUTPUT) return false;
      convMsgCount.set(m.conversationId, count + 1);
      return true;
    })
    .slice(0, SEARCH_CONFIG.resultCaps.maxMessages);

  // --- Build Response ---
  return {
    query,
    intent,
    artifacts: {
      files: artifacts,
    },
    memory: {
      messages,
      bestMessage: lists.bestMessage ?? null,
    },
    meta: {
      searchTimeMs: Date.now() - startTime,
      artifactCount: artifacts.length,
      memoryCount: messages.length,
    },
  };
}