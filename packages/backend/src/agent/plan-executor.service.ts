// packages/backend/src/agent/plan-executor.service.ts
import type { ContextPack } from './agent-dsl.types';
import type { HybridRetriever, RetrieveRequest } from './retriever.types';
import { rrfFuse, applyStructureSignals, toSortedArray } from './rank-combiner';
import { toTieredResponse } from './supabase-retriever';
import { FileContentFetcher } from './content-fetcher';
import { fencedCode } from './code-utils';
import { extractFileFacts } from '../facts-extractor';
import { estimateTokens, compactCodeWithMap } from './code-utils';
import type { ParsedOperators } from '../agent/agent-dsl.types';
import { supabase } from '../supabase';
import { SupabaseRetriever } from './supabase-retriever';

// Small helper to build an executor with the real retriever
export function createContextPackExecutor(perSubTopK = 6) {
  const retriever = new SupabaseRetriever(supabase);
  return new ContextPackExecutor({ retriever, perSubTopK });
}

function cleanPathLocal(p?: string): string {
  return (p || '').replace(/^['"`]+|['"`]+$/g, '');
}

function sizeOfSubq(sq: any): number {
  let t = 0;
  // Count code blocks (dominant), a bit for facts
  for (const c of (sq.code ?? [])) t += estimateTokens(c.snippet || '');
  t += estimateTokens((sq.facts ?? []).join('\n'));
  return t;
}

function sizeOfPack(pack: any): number {
  return (pack.subquestions ?? []).reduce((sum: number, sq: any) => sum + sizeOfSubq(sq), 0);
}

type BudgetPolicy = {
  // tiers
  keepCodeTopNPerSQ: number;   // after compaction, keep at most N full files per subquestion
  compactAlwaysIfOver: boolean;
};

const DEFAULT_POLICY: BudgetPolicy = {
  keepCodeTopNPerSQ: 2,
  compactAlwaysIfOver: true
};

// Mutates the pack: compacts code and trims tails until <= budget (best effort).
function enforceBudget(pack: any, hardBudget: number, policy: BudgetPolicy = DEFAULT_POLICY) {
  const before = sizeOfPack(pack);
  pack.budget = pack.budget || {};
  pack.budget.outputTokens = before;
  pack.budget.compacted = false;

  if (before <= hardBudget) return;

  // 1) Compact every code block (loss-aware with line maps)
  if (policy.compactAlwaysIfOver) {
    for (const sq of (pack.subquestions ?? [])) {
      for (const block of (sq.code ?? [])) {
        // already compacted?
        if (block.compaction?.preservedLines?.length) continue;
        const { compacted, map } = compactCodeWithMap(block.path, block.snippet || '');
        block.snippet = compacted;
        block.compaction = map;
      }
    }
    pack.budget.compacted = true;
  }

  // Re-evaluate
  let afterCompaction = sizeOfPack(pack);
  pack.budget.outputTokens = afterCompaction;

  if (afterCompaction <= hardBudget) return;

  // 2) Trim tails: keep only top-N code blocks per subquestion (based on source ranking order)
  for (const sq of (pack.subquestions ?? [])) {
    if ((sq.code?.length ?? 0) > policy.keepCodeTopNPerSQ) {
      sq.code = sq.code.slice(0, policy.keepCodeTopNPerSQ);
    }
  }

  // Re-evaluate again
  const final = sizeOfPack(pack);
  pack.budget.outputTokens = final;
}

export type ExecutorOptions = {
  retriever?: HybridRetriever;
  perSubTopK?: number;    // take top-k after fusion
};

export class ContextPackExecutor {
  private retriever: HybridRetriever;
  private perSubTopK: number;
  private content?: FileContentFetcher;

  constructor(opts: ExecutorOptions) {
    // Default to the real Supabase retriever if none was provided
    this.retriever = opts?.retriever ?? new SupabaseRetriever(supabase);
    this.perSubTopK = opts?.perSubTopK ?? 6;
  }

  setContentFetcher(fetcher: FileContentFetcher) {
    this.content = fetcher;
  }

  /**
   * Mutates the pack in-place: fills sources (ranked), leaves facts/code/messages empty for now.
   */
  async fillPack(projectId: string, pack: ContextPack) {
    pack.index = pack.index || { files: [], messages: [] };
    pack.index.files = pack.index.files || [];
    for (const sq of pack.subquestions) {
      const req: RetrieveRequest = { projectId, query: sq.text, operators: pack.operators };

      const lists = await this.retriever.retrieve(req);
        const tiered = toTieredResponse(sq.text, lists, Date.now());

        // Extract ranked file paths from the unified ranking pipeline
        const rankedArtifacts = tiered.artifacts.files;
        const rankedMessages = tiered.memory.messages;

        // === NEW: thread panel helpers ===
        const ret = lists as any;

        // 1) Merge uiIndex.files (dedupe by path, keep first)
        if (ret?.uiIndex?.files?.length) {
          const seen = new Set((pack.index.files as Array<{ path: string }>).map(f => f.path));
          for (const f of ret.uiIndex.files as Array<{ path: string }>) {
            const path = cleanPathLocal(f.path);
            if (!seen.has(path)) {
              // NOTE: pack.index.files only accepts { path, lastModified? } by type.
              // Push only { path } to keep TS happy.
              pack.index.files.push({ path });
              seen.add(path);
            }
          }
        }

        // 2) Attach bestMessage to this subquestion (what Top Picks reads)
        if (ret?.bestMessage && !(sq as any).message) {
          (sq as any).message = {
            id: ret.bestMessage.id ?? null,
            title: ret.bestMessage.title ?? '',
            preview: ret.bestMessage.preview ?? '',
            conversation_id: ret.bestMessage.conversation_id ?? null,
          };
        }
        // === END NEW ===

        // Build sources from unified ranking pipeline (toTieredResponse)
        // Artifacts → file/span sources
        const artifactSources = rankedArtifacts.slice(0, this.perSubTopK).map(a => {
          const isSpan = !!(a.startLine && a.endLine);
          const path = cleanPathLocal(a.path);
          console.log(`[fillPack] Processing item: file:${a.path}`);
          console.log(`[fillPack]   kind: ${isSpan ? 'span' : 'file'}, isMessage: false`);
          console.log(`[fillPack]   row.content exists: false, row.preview exists: ${!!a.preview}`);
          return {
            kind: 'file' as const,
            path,
            startLine: a.startLine,
            endLine: a.endLine,
            score: a.similarity,
            signals: {} as Record<string, number>,
            content: undefined as string | undefined,
          };
        });

        // Messages → message sources
        const messageSources = rankedMessages.slice(0, 3).map(m => {
          console.log(`[fillPack] Processing item: message:${m.id}`);
          console.log(`[fillPack]   kind: message, isMessage: true`);
          console.log(`[fillPack]   MESSAGE CONTENT (first 100 chars): ${(m.preview || 'NONE').slice(0, 100)}`);
          return {
            kind: 'message' as const,
            path: `message:${m.id}`,
            startLine: undefined as number | undefined,
            endLine: undefined as number | undefined,
            score: m.similarity,
            signals: {} as Record<string, number>,
            content: m.preview || undefined,
          };
        });

        sq.sources = [...artifactSources, ...messageSources];

        // De-dupe by path: prefer spans over plain file hits; else keep higher score
        {
          const keep = new Map<string, typeof sq.sources[number]>();
          for (const s of sq.sources) {
            if (!s.path) continue;
            const current = keep.get(s.path);
            const sIsSpan = Number.isFinite(s.startLine) && Number.isFinite(s.endLine);
            const cIsSpan = current ? (Number.isFinite(current.startLine) && Number.isFinite(current.endLine)) : false;

            if (!current) keep.set(s.path, s);
            else if (sIsSpan && !cIsSpan) keep.set(s.path, s);
            else if (!sIsSpan && !cIsSpan && (s.score > (current.score || 0))) keep.set(s.path, s);
            else if (sIsSpan && cIsSpan && (s.score > (current.score || 0))) keep.set(s.path, s);
          }
          sq.sources = Array.from(keep.values());

          console.log('[fillPack] After de-dupe, sources:');
          sq.sources.forEach((s, i) => {
            console.log(`  [${i}] kind=${s.kind}, path=${s.path?.slice(0,40)}, score=${s.score?.toFixed(3)}, hasContent=${!!s.content}`);
          });
        }

        // 5) index unique files
        for (const s of sq.sources) {
        if (s.path && !pack.index.files.find(f => f.path === s.path)) {
            pack.index.files.push({ path: s.path });
        }
        }

        // 6) locations (prefer uiIndex files first, then spans from sources)
        {
          const locMap = new Map<string, { path: string; startLine?: number; endLine?: number }>();
          
          // FIRST: Add uiIndex.files (retriever's boosted results in correct order)
          if (ret.uiIndex?.files) {
            for (const f of ret.uiIndex.files) {
              locMap.set(f.path, { path: f.path });
            }
          }
          
          // THEN: Add sources (keyword results + spans, prefer spans, don't overwrite files)
          for (const s of sq.sources) {
            if (!s.path) continue;
            const prev = locMap.get(s.path);
            const curr = { path: s.path, startLine: s.startLine, endLine: s.endLine };
            const currIsSpan = !!(s.startLine && s.endLine);
            const prevIsSpan = !!(prev?.startLine && prev?.endLine);
            if (!prev || (currIsSpan && !prevIsSpan)) locMap.set(s.path, curr);
          }
          
          sq.locations = Array.from(locMap.values());
        }

        // 7a) Handle messages (add their content directly)
        const messageItems = sq.sources.filter(s => s.kind === 'message');
        for (const msg of messageItems) {
          if (msg.content && msg.path) {
            // Add message as a text block
            sq.code.push({
              path: msg.path,
              startLine: 1,
              endLine: (msg.content.match(/\n/g)?.length ?? 0) + 1,
              snippet: fencedCode(msg.path, msg.content)
            });
            
            // Add to locations
            if (!sq.locations) sq.locations = [];
            if (!sq.locations.find(l => l.path === msg.path)) {
              sq.locations.push({ path: msg.path });
            }
          }
        }

        // 7b) fetch full file contents + extract facts
        if (this.content) {
          // Only fetch actual files, not messages
          const fetchOrder = (sq.locations ?? [])
            .filter(l => l.path && !l.path.startsWith('conversation:'))  // <-- Skip message paths
            .map(l => l.path)
            .filter((p): p is string => !!p);

            if (fetchOrder.length) {
                const files = await this.content.getLatestFiles(projectId, fetchOrder);

                for (const file of files) {
                const totalLines = (file.content.match(/\n/g)?.length ?? 0) + 1;
                sq.code.push({
                    path: file.path,
                    startLine: 1,
                    endLine: totalLines,
                    snippet: fencedCode(file.path, file.content)
                });

                const facts = extractFileFacts(file.path, file.content);
                for (const it of facts.items) {
                    if (!sq.facts.includes(it)) sq.facts.push(it);
                }
                }

                // Ensure code blocks follow the exact "File Locations" order
                if (sq.locations?.length && sq.code?.length) {
                const byPath = new Map<string, typeof sq.code[number]>();
                for (const b of sq.code) if (!byPath.has(b.path)) byPath.set(b.path, b);

                const ordered: typeof sq.code = [];
                for (const loc of sq.locations) {
                    const b = loc.path ? byPath.get(loc.path) : undefined;
                    if (b) ordered.push(b);
                }
                for (const b of sq.code) if (!ordered.includes(b)) ordered.push(b);
                sq.code = ordered;
                }

                // pack-wide index follows Locations order
                for (const l of (sq.locations ?? [])) {
                if (l.path && !pack.index.files.find(f => f.path === l.path)) {
                    pack.index.files.push({ path: l.path });
                }
                }
            }
        }

        // === Keep reranked UI files at the front of pack.index.files (stable) ===
        // NOTE: Using 'ret' from line 124 - DO NOT call retriever again!
        {
          const uiFiles: string[] = (ret?.uiIndex?.files ?? []).map((f: any) => cleanPathLocal(f.path));
          if (uiFiles.length) {
            // unique all current files by path
            const unique = new Map<string, { path: string }>();
            for (const f of pack.index.files as Array<{ path: string }>) {
              unique.set(cleanPathLocal(f.path), { path: cleanPathLocal(f.path) });
            }
            // rebuild with uiFiles first (in order), then the rest
            const reordered: Array<{ path: string }> = [];
            for (const p of uiFiles) {
              const r = unique.get(p);
              if (r) { reordered.push(r); unique.delete(p); }
              else { reordered.push({ path: p }); }
            }
            for (const r of unique.values()) reordered.push(r);
            pack.index.files = reordered;
          }
        }

        // 8) coverage
        sq.coverage = sq.code.length > 0 ? 'primary'
                : (sq.sources.length ? 'partial' : 'gap');
    }
    enforceBudget(pack, pack.budget?.inputTokens || 12000);
    
    // Final pass: ensure code blocks follow Locations order
    for (const sq of pack.subquestions ?? []) {
    if (sq.locations?.length && sq.code?.length) {
        const byPath = new Map<string, typeof sq.code[number]>();
        for (const b of sq.code) if (!byPath.has(b.path)) byPath.set(b.path, b);
        const ordered: typeof sq.code = [];
        for (const loc of sq.locations) {
        const b = loc.path ? byPath.get(loc.path) : undefined;
        if (b) ordered.push(b);
        }
        for (const b of sq.code) if (!ordered.includes(b)) ordered.push(b);
        sq.code = ordered;
    }
    }
  }
}