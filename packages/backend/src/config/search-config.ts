// packages/backend/src/config/search-config.ts
// Centralized search tuning parameters
// Adjust these values to control how search results are scored and blended.



export const SEARCH_CONFIG = {

  // ── Fusion Weights (combineAndRankResults) ──
  // These control how each search method contributes to the final blended score.
  // All scores are normalized to 0-100 before weighting.
  weights: {
    semantic: 0.40,   // Embedding similarity (cosine)
    keyword:  0.40,   // BM25 / lexical match
    entity:   0.10,   // Entity name match + mention frequency
  },

  // ── RRF Parameters (fuseResults) ──
  rrf: {
    k: 60,  // Smoothing constant; higher = less impact from top ranks
  },

  // ── Semantic Search ──
  semantic: {
    matchThreshold: 0.30,  // Minimum cosine similarity to include
  },

  // ── Entity Scoring ──
  // Final entity score = (matchRatio * termMatchWeight) + (normalizedMentions * mentionWeight)
  entity: {
    termMatchWeight: 0.70,  // How much term overlap matters (0-1)
    mentionWeight:   0.30,  // How much mention frequency matters (0-1)
    mentionCap:      100,   // Normalize mentions: min(mentions, cap) / cap
  },

  // ── Default Limits ──
  limits: {
    semanticFetchMultiplier: 2,  // Fetch N × requestedLimit for RRF fusion
    semanticMax: 100,
    keywordMax:  100,
    entity:      15,
    resultDefault: 25,
    resultMax:     100,
  },

  // ── Stop Words ──
  // Filtered out before entity search to improve precision.
  stopWords: new Set([
    // Question words
    'who', 'what', 'where', 'when', 'why', 'how', 'which',
    // Articles & prepositions
    'a', 'an', 'the', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
    'from', 'by', 'about', 'into', 'through', 'between', 'after', 'before',
    // Common verbs
    'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'do', 'does', 'did', 'doing',
    'have', 'has', 'had', 'having',
    'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might',
    'get', 'got', 'make', 'made',
    // Pronouns
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they', 'them',
    // Conjunctions & misc
    'and', 'or', 'but', 'not', 'if', 'then', 'so', 'just', 'also',
    'this', 'that', 'these', 'those',
    'all', 'any', 'some', 'no', 'each', 'every',
    // Search noise
    'find', 'show', 'tell', 'give', 'located', 'called', 'named',
    'look', 'search', 'there', 'here',
  ]),

  // ── Concept Extraction (LLM-based) ──
  conceptExtraction: {
    model: 'claude-sonnet-4-5-20250929',
    maxInputTokens: 1500,
    maxConcepts: 15,
    minConcepts: 3,
    messagesHead: 2,
    messagesTail: 2,
    maxCharsPerMessage: 1500,
  },

  // ── Authority Weights (SupabaseRetriever) ──
  // Files > Messages, but not so extreme that messages get buried
  authority: {
    CODE_CHUNK:      1.20,   // VS Code synced chunks (was 1.5)
    CODE_FILE:       1.15,   // Full code files (was 1.4)
    CODE_SPAN:       1.15,   // Code spans (was 1.3)
    ATTACHED_DOC:    1.20,   // PDFs, Word, Excel (was 1.3)
    DOCUMENT:        1.10,   // Markdown, txt (was 1.1)
    MESSAGE:         0.80,   // Chat messages (was 0.6)
    MESSAGE_SNIPPET: 0.40,   // msg_ attachment files (was 0.3)
  },

  // ── Intent Boosts (toTieredResponse) ──
  intentBoosts: {
    codeSeekingSemantic: 1.3,        // Lowered from 1.4 to prevent over-inflation
    codeSeekingKeywordPenalty: 0.85,  // was 0.7 — too harsh
  },

  intentPenalties: {
    codeSeeking: {
      messageSnippet: 0.10,    // #1: msg_* files
      testFile: 0.50,          // #2+6 merged: .test., .spec., /tests/, __tests__
      typeDefinition: 0.70,    // #4: .types.ts, .d.ts, /types/
      debugFile: 0.60,         // #5: debug-*, debug.*
      archivedFile: 0.30,      // #7: /archive/, /old/, /deprecated/
      vendorFile: 0.20,        // #8: /vendor/, node_modules, .min.
    },
    memorySeeking: {
      messageSnippet: 1.30,    // boost msg_* files
      codeFile: 0.70,          // suppress code extensions
    },
    general: {
      messageSnippet: 0.50,    // soft penalty (was 0.8, lowered for Phase 2 safety)
    },
  },

  // ── Filename / Path Boost (nameBoost in SupabaseRetriever) ──
  pathBoost: {
    tokenMatchBoost: 0.15,       // Per query token found in file path/name (was 0.08)
    extensionBoost: 0.05,        // File has a recognized code/doc extension
    directoryMatchBoost: 0.10,   // Query token matches a directory name in path
    maxTotalBoost: 0.45,         // Cap to prevent path boost from dominating
  },

  // ── Score Display ──
  scoring: {
    maxDisplayScore: 1.0,
    minDisplayScore: 0.25,        // absolute floor — nothing below this ever shows
    relativeThreshold: 0.45,    // Lowered from 0.62 to allow secondary results to survive
    exactMatchBoost: 0.95,     // exact string matches get this as minimum similarity
    filenameMentionBoost: 1.8,   // multiply score when query explicitly names a file
  },

  // ── Result Caps (tiered response + frontend) ──
  resultCaps: {
    maxArtifacts: 8,   // Max total results to return from search (before final re-ranking), changed from 5 to 8 to encourage more aggressive pruning
    maxMessages: 5,
  },

  // ── Recency Tie-Breaking ──
  recency: {
    threshold: 0.05,         // Scores within this range → use recency
    versionBoost: 0.08,      // Boost for newest version of same-path file
  },

  // ── Message Content Re-Ranking (toTieredResponse) ──
  // Breaks embedding score ties by boosting messages whose content contains query tokens
  messageContentBoost: {
    perTokenBoost: 0.05,   // per matching query token found in message preview
    phraseMatchBoost: 0.25,   // Big boost for exact phrase match
    maxBoost: 0.30,        // cap total content boost
  },

  // ── Identifier Dominance (when query contains camelCase/snake_case) ──
  identifierDominance: {
    symbolHit: 1.8,        // strong boost for "defines it"
    symbolWeak: 0.70,      // Was 1.0 → penalize "partially matches but doesn't define it"
    symbolThreshold: 0.3,   // minimum symbol score to count as a hit (was 0.40, lowered due to source guard preventing false positives)
    bm25Hit: 1.2,          
    filenameOnly: 0.65,    
    noEvidence: 0.85,      
  },

  // ── Identifier Evidence Gate (toTieredResponse) ──
  // When query contains an identifier (camelCase/snake_case/cb_*), only show files
  // with strong retrieval evidence. Prevents conversation-bleed files from appearing.
  identifierEvidenceGate: {
    enabled: true,
    applyToIdentifierQueriesOnly: true,
    symbolThreshold: 0.10,   // was 0.40 — lowered because source guard prevents false scores
    bm25Threshold: 0.55,
    minTokensMatched: 2,
    allowBasenameHit: true,
    minKeep: 1,  // TODO: split minKeep by query class if gate is extended to non-identifier queries
  },

  searchExclusions: {
    // Hard exclude from ALL results — test harness artifacts
    fullExclude: [
      'test-queries.json',
    ],
    // Hard exclude from Code Files only (allow in Conversations)
    filesOnlyExclude: [
      'search-quality-session-summary*',
      'search-quality-session-summary*',
      'search-quality-session-primer*',
      'search-test-*',
    ],
    // Penalty multiplier (0.0–1.0) applied to similarity score
    penaltyPatterns: [
      { pattern: /\btest\b/i, multiplier: 0.5 },  // halve score for "test" in path
      { pattern: /\bspec\b/i, multiplier: 0.5 },
      { pattern: /\bmock\b/i, multiplier: 0.6 },
      { pattern: /\bfixture\b/i, multiplier: 0.5 },
      // Generated/output files — auto-detected, not hardcoded by name
      { pattern: /\d{4}-\d{2}-\d{2}/, multiplier: 0.2 },           // Timestamp in filename
      { pattern: /\/(results|output|dist|build)\//, multiplier: 0.3 }, // Output directories
      { pattern: /session-primer|session-summary/, multiplier: 0.2 },  // Meta-documentation
      { pattern: /\b(verify|check|debug|inspect|diagnose|benchmark)-/i, multiplier: 0.4 },
    ],
  }
};

/** Remove stop words from a query, returning only substantive terms */
export function filterStopWords(terms: string[]): string[] {
  return terms.filter(t => t.length > 1 && !SEARCH_CONFIG.stopWords.has(t.toLowerCase()));
}