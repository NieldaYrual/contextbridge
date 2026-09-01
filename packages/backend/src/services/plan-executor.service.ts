// packages/backend/src/services/plan-executor.service.ts

import type { AgentPlan } from '../types/agent-dsl.types';

export interface SearchItem {
  id: string;
  kind: 'message' | 'file' | 'block';
  title: string;
  content: string;
  score?: number;
  created_at?: string;
  conversation_id?: string;
  source?: {
    conversation_id?: string;
    message_id?: string;
    file_id?: string;
    block_id?: string;
  };
}

export interface ExecutionResult {
  success: boolean;
  pasteBlock?: string;
  tokenEstimate?: number;
  selectedItems?: SearchItem[];
  truncated?: boolean;
  error?: string;
  metadata?: {
    itemsConsidered: number;
    itemsSelected: number;
    transformMode: string;
    budgetUsed: number;
  };
}

export class PlanExecutorService {
  /**
   * Execute an AgentPlan against search results
   */
  async executePlan(
    plan: AgentPlan,
    items: SearchItem[]
  ): Promise<ExecutionResult> {
    try {
      console.log(`📋 Executing plan: ${plan.intent} with ${items.length} items`);

      // Step 1: Select items based on strategy
      const selectedItems = this.selectItems(items, plan.selection);
      console.log(`  ✓ Selected ${selectedItems.length} items`);

      if (selectedItems.length === 0) {
        return {
          success: false,
          error: 'No items matched the selection criteria'
        };
      }

      // Step 2: Transform each selected item
      const transformedParts: string[] = [];
      for (const item of selectedItems) {
        const transformed = this.transformItem(item, plan.transform);
        transformedParts.push(transformed);
      }

      // Step 3: Format output
      const pasteBlock = this.formatOutput(
        transformedParts,
        selectedItems,
        plan.output
      );

      // Step 4: Estimate tokens and enforce budget
      const tokenEstimate = this.estimateTokens(pasteBlock);
      let finalPasteBlock = pasteBlock;
      let truncated = false;

      if (plan.budget?.maxTokens && tokenEstimate > plan.budget.maxTokens) {
        console.log(`  ⚠️ Exceeds budget (${tokenEstimate} > ${plan.budget.maxTokens}), truncating...`);
        finalPasteBlock = this.truncateToFit(
          pasteBlock,
          plan.budget.maxTokens,
          plan.budget.truncationStrategy || 'trim_end'
        );
        truncated = true;
      }

      const tokenBudgetTarget = plan.budget?.maxTokens ?? 0;

      return {
        success: true,
        pasteBlock: finalPasteBlock,
        tokenEstimate: this.estimateTokens(finalPasteBlock),
        selectedItems,
        truncated,
        metadata: {
            itemsConsidered: items.length,
            itemsSelected: selectedItems.length,
            transformMode: plan.transform.mode,
            budgetUsed: this.estimateTokens(finalPasteBlock)
        }
    };

    } catch (error: any) {
      console.error('❌ Plan execution failed:', error);
      return {
        success: false,
        error: error.message || String(error)
      };
    }
  }

  /**
   * Select items based on selection strategy
   */
  private selectItems(
    items: SearchItem[],
    selection: AgentPlan['selection']
    ): SearchItem[] {
    const { strategy } = selection;
    const cap = Math.min(Math.max(selection.count ?? 1, 1), 50); // hard cap
    const inRange = (i: number) => i >= 0 && i < items.length;

    switch (strategy) {
        case 'first':
        return items.slice(0, cap);

        case 'last':
        return items.slice(-cap);

        case 'all':
        return items;

        case 'top_n':
        return items.slice(0, cap);

        case 'specific_indices': {
          // Indices from AgentPlan are 1-based (user-facing), convert to 0-based
          const idxs = (selection.indices ?? [])
            .map(n => typeof n === 'number' ? n - 1 : -1)  // Convert 1-based → 0-based
            .filter(i => inRange(i))
            .slice(0, cap);
          return idxs.map(i => items[i]);
        }

        case 'highest_scored': {
        const threshold = selection.scoreThreshold ?? 0;
        return items
            .filter(it => (it.score ?? 0) >= threshold)
            .slice(0, cap);
        }

        default:
        console.warn(`Unknown selection strategy: ${strategy}`);
        return items.slice(0, 1);
    }
    }

  /**
   * Transform item content based on transform mode
   */
  private transformItem(
    item: SearchItem & { snippet?: string; title?: string },
    transform: AgentPlan['transform']
    ): string {
    const { mode, lineRange, snippetContext } = transform;
    const full = item.content ?? '';
    const snippet = (item as any).snippet as string | undefined;

    switch (mode) {
        case 'full':
        return full;

        case 'snippet': {
        // Prefer provided snippet; fallback to first N sentences of full
        if (snippet && snippet.trim()) return snippet.trim();
        const sentences = this.splitIntoSentences(full);
        const ctx = Math.max(1, snippetContext ?? 2);
        return sentences.slice(0, ctx + 1).join(' ');
        }

        case 'first_n_lines': {
        const firstN = Math.max(1, lineRange?.first ?? 10);
        return full.split('\n').slice(0, firstN).join('\n');
        }

        case 'lines': {
        const start = Math.max(1, lineRange?.start ?? 1) - 1; // 0-based
        const end = Math.max(start + 1, lineRange?.end ?? lineRange?.start ?? (start + 1));
        return full.split('\n').slice(start, end).join('\n');
        }

        case 'custom':
        default:
        return full;
    }
    }

  /**
   * Format output with metadata and separators
   */
  private formatOutput(
    parts: string[],
    items: (SearchItem & { snippet?: string; title?: string })[],
    output: AgentPlan['output']
    ): string {
    const { format, includeMetadata, includeScores, separator } = output;
    const sep = separator || '\n\n---\n\n';

    const langFromExt = (name: string) => {
        const ext = (name.split('.').pop() || '').toLowerCase();
        const map: Record<string,string> = {
        ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx',
        py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
        java: 'java', cs: 'csharp', cpp: 'cpp', c: 'c',
        md: 'md', json: 'json', yaml: 'yaml', yml: 'yaml',
        sql: 'sql', sh: 'bash', ps1: 'powershell'
        };
        return map[ext] || '';
    };

    const formatted = parts.map((content, idx) => {
        const it = items[idx];
        const lines: string[] = [];

        if (includeMetadata) {
        const ts = it.created_at
            ? new Date(it.created_at).toISOString().slice(0,16).replace('T',' ')
            : '';
        const scoreText = includeScores && typeof it.score === 'number'
            ? ` · Score: ${Math.round((it.score ?? 0) * 100)}%`
            : '';
        const title = it.title || '(untitled)';
        lines.push(`## ${title} (${it.kind}${ts ? ` · ${ts}` : ''}${scoreText})`);
        }

        if (format === 'code_fence' && it.kind === 'file') {
        const lang = langFromExt(it.title || '');
        lines.push('```' + lang);
        lines.push(content);
        lines.push('```');
        } else {
        lines.push(content);
        }

        if (includeMetadata) {
        lines.push(`— source: ${it.kind}/${it.id}`);
        }

        return lines.join('\n');
    });

    return formatted.join(sep);
    }

  /**
   * Estimate token count (rough approximation: ~4 chars per token)
   */
  private estimateTokens(text: string): number {
    if (!text) return 0;
    const chars = text.length;
    const words = text.split(/\s+/).length;
    const lines = text.split('\n').length;
    const fromChars = Math.ceil(chars / 4);
    const fromWords = Math.ceil(words * 1.2);
    const fromLines = Math.ceil(lines * 3.2); // typical code line ~3 tokens
    return Math.round((fromChars * 0.55) + (fromWords * 0.25) + (fromLines * 0.20));
    }

  private splitIntoBlocks(text: string): string[] {
    // Split by paragraphs / fenced code blocks / headings as coarse blocks
    const blocks: string[] = [];
    const lines = text.split('\n');
    let buf: string[] = [];
    let inFence = false;

    for (const line of lines) {
        const fence = line.trim().startsWith('```');
        if (fence) inFence = !inFence;

        buf.push(line);

        const isHeading = !inFence && /^#{1,6}\s/.test(line);
        const isBlank = !inFence && line.trim() === '';

        if (!inFence && (isHeading || isBlank)) {
        blocks.push(buf.join('\n'));
        buf = [];
        }
    }
    if (buf.length) blocks.push(buf.join('\n'));
    return blocks.filter(b => b.trim() !== '');
    }

    private safeTrimToTokens(text: string, maxTokens: number): { out: string; truncated: boolean } {
    const targetChars = Math.floor(maxTokens * 4);
    if (text.length <= targetChars) return { out: text, truncated: false };

    const blocks = this.splitIntoBlocks(text);

    // Greedy add blocks until near target, then refine by lines if needed
    const out: string[] = [];
    let accLen = 0;
    for (const b of blocks) {
        const nextLen = accLen + b.length + 1;
        if (nextLen <= targetChars * 0.95) {
        out.push(b);
        accLen = nextLen;
        } else {
        // refine at line-level
        const lines = b.split('\n');
        for (const line of lines) {
            if (accLen + line.length + 1 > targetChars) break;
            out.push(line);
            accLen += line.length + 1;
        }
        break;
        }
    }

    const suffix = '\n\n[... truncated to fit budget]';
    const joined = out.join('\n');
    return { out: joined.endsWith('```') ? joined + '\n```' + suffix : joined + suffix, truncated: true };
    }

  /**
   * Truncate text to fit within token budget
   */
  private truncateToFit(
    text: string,
    maxTokens: number,
    strategy: 'trim_end' | 'trim_start' | 'smart_summarize'
    ): string {
    if (strategy === 'smart_summarize') {
        // Coarse smart: keep first blocks until half budget, last blocks for the rest
        const targetChars = Math.floor(maxTokens * 4);
        const blocks = this.splitIntoBlocks(text);
        if (text.length <= targetChars) return text;

        let head = '';
        let tail = '';
        let acc = 0;

        // head
        for (const b of blocks) {
        if (acc + b.length + 1 > targetChars / 2) break;
        head += (head ? '\n' : '') + b;
        acc += b.length + 1;
        }

        // tail
        acc = 0;
        for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (acc + b.length + 1 > targetChars / 2) break;
        tail = b + (tail ? '\n' : '') + tail;
        acc += b.length + 1;
        }

        return `${head}\n\n[... middle section truncated ...]\n\n${tail}`;
    }

    // default: safe head trim
    const { out } = this.safeTrimToTokens(text, maxTokens);
    return out;
    }

  /**
   * Split text into sentences (simplified)
   */
  private splitIntoSentences(text: string): string[] {
    return text
      .split(/[.!?]+\s+/)
      .map(s => s.trim())
      .filter(Boolean);
  }
}

// Singleton instance
let executorInstance: PlanExecutorService | null = null;

export function getPlanExecutor(): PlanExecutorService {
  if (!executorInstance) {
    executorInstance = new PlanExecutorService();
  }
  return executorInstance;
}