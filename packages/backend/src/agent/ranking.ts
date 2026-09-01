// packages/backend/src/agent/ranking.ts
// Single Source of Truth for ranking in ContextBridge.
// Both the search modal (toTieredResponse) and auto-context (fillPack) consume this.

import { SEARCH_CONFIG } from '../config/search-config';
import type { RetrieveLists, QueryIntent, ArtifactHit, MemoryHit, BestMessageLite, TieredSearchResponse } from './retriever.types';

// ── Evidence collected per file during ranking ──
export type FileEvidence = {
  symbolHit: boolean;
  symbolScore: number;
  bm25Hit: boolean;
  bm25Norm: number;
  filenameMention: boolean;
  codexHit: boolean;
  artifactKeyHit: boolean;
  tokensMatched: number;
  basenameHits: number;
};

// ── Uncapped ranked artifact (internal, before UI formatting) ──
export type RankedArtifact = ArtifactHit & {
  evidence: FileEvidence;
};

// ── Output of rankCandidates — the Single Source of Truth ──
export type RankedCandidates = {
  artifacts: RankedArtifact[];
  messages: MemoryHit[];
  bestMessage: BestMessageLite | null;
  intent: QueryIntent;
};

/**
 * Core ranking function — Single Source of Truth for relevance in ContextBridge.
 *
 * Input:  Raw candidates from retrieve()
 * Output: Ranked, filtered artifacts and messages with uncapped scores.
 *
 * Consumers:
 *   - formatForUI() → search modal (clamps scores, applies result caps)
 *   - fillPack()    → auto-context agent (uses ranked artifacts for content fetch)
 */
export function rankCandidates(
  query: string,
  lists: RetrieveLists,
): RankedCandidates {
  const intent: QueryIntent = lists.intent ?? 'general';

  // TODO: Extract logic from toTieredResponse
  // 1. Build artifactMap from semantic + keyword results
  // 2. Track evidence per file
  // 3. Apply graduated identifier dominance multiplier
  // 4. Apply identifier evidence gate
  // 5. Build and score messages
  // All without clamping or result caps.

  return {
    artifacts: [],
    messages: [],
    bestMessage: lists.bestMessage ?? null,
    intent,
  };
}

/**
 * Formats RankedCandidates for the search modal UI.
 * Applies: score clamping to 1.0, result caps, conversation title enrichment.
 */
export function formatForUI(
  ranked: RankedCandidates,
  query: string,
  startTime: number,
): TieredSearchResponse {
  const { scoring, resultCaps } = SEARCH_CONFIG;

  const artifacts = ranked.artifacts
    .slice(0, resultCaps.maxArtifacts)
    .map(a => ({
      path: a.path,
      filename: a.filename,
      similarity: Math.min(a.similarity, scoring.maxDisplayScore),
      preview: a.preview,
      startLine: a.startLine,
      endLine: a.endLine,
      updatedAt: a.updatedAt,
    }));

  const messages = ranked.messages
    .slice(0, resultCaps.maxMessages)
    .map(m => ({
      ...m,
      similarity: Math.min(m.similarity, scoring.maxDisplayScore),
    }));

  return {
    query,
    intent: ranked.intent,
    artifacts: { files: artifacts },
    memory: { messages, bestMessage: ranked.bestMessage },
    meta: {
      searchTimeMs: Date.now() - startTime,
      artifactCount: artifacts.length,
      memoryCount: messages.length,
    },
  };
}