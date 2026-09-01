// packages/backend/src/agent/retriever.types.ts
import type { RankItem, FusedScore } from './rank-combiner';
import type { ParsedOperators } from '../agent/agent-dsl.types';

export type RetrieveRequest = {
  projectId: string;
  query: string;
  operators: ParsedOperators;
  /** Optional: Project IDs that contain Codex sources (for code file search) */
  codexProjectIds?: string[];
};

export type RetrieveLists = {
  keyword: RankItem[];
  semantic: RankItem[];
  kg: RankItem[];
  uiIndex?: { files: UiIndexFile[] };
  bestMessage?: BestMessageLite | null;
  intent?: QueryIntent;
};

export interface HybridRetriever {
  // Return per-list ranked ids (no DB yet; Step 3 will implement)
  retrieve(req: RetrieveRequest): Promise<RetrieveLists>;

  // Map an item id (e.g., a file path key) to structure signals
  getSignals(id: string): Promise<Record<string, number>>;
}

export type RankedResult = {
  id: string;
  fused: FusedScore;
};

export type UiIndexFile = {
  path: string;
  filename: string | null;
  similarity: number;
};

export type BestMessageLite = {
  id: string | null;
  title: string;
  preview: string;
  conversation_id: string | null;
};

export interface HybridRetrieveResult {
  keyword: RankItem[];
  semantic: RankItem[];
  kg: RankItem[];
  // NEW (optional) – used by the panel
  uiIndex?: {
    files: UiIndexFile[];
    // spans?: ...  
  };
  bestMessage?: BestMessageLite | null;
};

// ============================================================================
// TIERED RESPONSE TYPES
// ============================================================================

/** Three-way intent classification for query routing */
export type QueryIntent = 'code_seeking' | 'memory_seeking' | 'general';

/** A file or code chunk hit in the artifacts tier */
export type ArtifactHit = {
  path: string;
  filename: string | null;
  similarity: number;
  preview?: string;
  startLine?: number;
  endLine?: number;
  updatedAt?: string;
};

export type MemoryHit = {
  id: string;
  conversationId: string;
  preview: string;
  similarity: number;
  title?: string;
  createdAt?: string;
  provider?: string;
  url?: string;
};

/** Artifacts tier: code files, documents, spans */
export type ArtifactsTier = {
  files: ArtifactHit[];
};

/** Memory tier: conversation messages */
export type MemoryTier = {
  messages: MemoryHit[];
  bestMessage: BestMessageLite | null;
};

/** Search metadata for debugging and analytics */
export type SearchMeta = {
  searchTimeMs: number;
  artifactCount: number;
  memoryCount: number;
};

/** 
 * Tiered search response - separates artifacts (code/docs) from memory (conversations)
 * Intent determines which tier is presented first in the UI
 */
export type TieredSearchResponse = {
  query: string;
  intent: QueryIntent;
  artifacts: ArtifactsTier;
  memory: MemoryTier;
  meta: SearchMeta;
};
