// packages/backend/src/agent/rank-combiner.ts
// Simple signal model + RRF combiner for hybrid ranking

export type RankItem = {
  id: string;                          // stable id (file path or message key)
  rank: number;                        // 1-based rank within one list
  meta?: Record<string, any>;
};

export type SignalScores = {
  filenameMatch?: number;              // 0..1
  pathMatch?: number;                  // 0..1
  symbolSim?: number;                  // 0..1
  codeDensity?: number;                // 0..1
  recency?: number;                    // 0..1
  entityOverlap?: number;              // 0..1
  keywordScore?: number;               // 0..1 (from keyword retriever)
  semanticScore?: number;              // 0..1 (from embedding retriever)
  kgScore?: number;                    // 0..1 (from KG/entity retriever)
  routeHit?: number;                   // 0..1 (from KG/entity retriever)
  docHit?: number;                     // 0..1 (documentation match)
};

export type FusedScore = {
  id: string;
  score: number;                       // fused (RRF + signals)
  signals: SignalScores;
  sources: Array<{
    list: 'keyword'|'semantic'|'kg'|'structure';
    rank?: number;
    raw?: any;
  }>;
};

export function rrfFuse(
  lists: { name: 'keyword'|'semantic'|'kg'; items: RankItem[] }[],
  k: number = 60
): Map<string, FusedScore> {
  const out = new Map<string, FusedScore>();
  for (const list of lists) {
    for (const it of list.items) {
      const prev = out.get(it.id);
      const add = 1 / (k + it.rank);
      if (!prev) {
        out.set(it.id, {
          id: it.id,
          score: add,
          signals: {},
          sources: [{ list: list.name, rank: it.rank, raw: it.meta }]
        });
      } else {
        prev.score += add;
        prev.sources.push({ list: list.name, rank: it.rank, raw: it.meta });
      }
    }
  }
  return out;
}

// === Signal categories for hybrid scoring ===
const CORE_RELEVANCE: (keyof SignalScores)[] = ['semanticScore', 'keywordScore', 'kgScore'];
const STRUCTURAL: (keyof SignalScores)[] = ['symbolSim', 'codeDensity', 'entityOverlap'];
// Added 'docHit' here to simplify the loop
const SURFACE: (keyof SignalScores)[] = ['filenameMatch', 'pathMatch', 'routeHit', 'recency', 'docHit'];

// === Tuned Weights for RRF Scale (base ~0.016 max) ===
const DEFAULT_WEIGHTS: Record<string, number> = {
  // Core relevance (multiplicative)
  semanticScore: 0.8,    // Max 1.8x multiplier
  keywordScore: 0.5,
  kgScore: 0.4,

  // Structural hints (multiplicative)
  symbolSim: 0.6,        // Reward function/class name matches
  codeDensity: 0.2,
  entityOverlap: 0.25,

  // Surface hints (additive, capped) - scaled to RRF magnitude
  filenameMatch: 0.008,  // ~half a rank #1 score
  pathMatch: 0.004,
  routeHit: 0.001,       // Routes rarely boost generic queries
  recency: 0.003,
  docHit: 0.003,
};

// Cap at ~1 rank's worth. Prevents metadata from overriding semantic relevance.
const SURFACE_CAP = 0.015;

// Attach structure-aware signals using hybrid scoring model
export function applyStructureSignals(
  fused: Map<string, FusedScore>,
  getSignals: (id: string) => SignalScores,
  weights: Partial<Record<keyof SignalScores, number>> = {}
) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };

  for (const v of fused.values()) {
    const s = getSignals(v.id) || {};
    v.signals = s;

    const baseScore = v.score; // RRF base (approx 0.01 - 0.02)

    // 1) Core relevance: Multiplicative
    // These amplify the base signal (e.g. 0.016 * 1.8 = 0.028)
    let coreMultiplier = 1;
    for (const k of CORE_RELEVANCE) {
      const val = s[k];
      if (typeof val === 'number' && isFinite(val)) {
        coreMultiplier += (w[k] ?? 0) * val;
      }
    }

    // 2) Structural hints: Multiplicative
    // These further amplify if specific code structures match (symbol, density)
    let structMultiplier = 1;
    for (const k of STRUCTURAL) {
      const val = s[k];
      if (typeof val === 'number' && isFinite(val)) {
        structMultiplier += (w[k] ?? 0) * val;
      }
    }

    // 3) Surface hints: Additive & Capped
    // These provide small nudges for filenames/paths/recency
    let surfaceSum = 0;
    for (const k of SURFACE) {
      const val = s[k];
      if (typeof val === 'number' && isFinite(val)) {
        surfaceSum += (w[k] ?? 0) * val;
      }
    }
    const surfaceBoost = Math.min(SURFACE_CAP, surfaceSum);

    // Final Formula: Amplify the Base, then Nudge with Surface
    v.score = baseScore * coreMultiplier * structMultiplier + surfaceBoost;
  }

  return fused;
}

export function toSortedArray(m: Map<string, FusedScore>) {
  return Array.from(m.values()).sort((a, b) => b.score - a.score);
}