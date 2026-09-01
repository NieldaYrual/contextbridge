// packages/backend/src/agent/agent-dsl.types.ts

export type ContextPack = {
  instruction: string;
  intent: 'context_injection';
  operators: ParsedOperators;
  subquestions: Array<ContextSubQuestion>;
  index: {
    files: Array<{ path: string; lastModified?: string }>;
    messages: Array<{ conversationId: string; messageId: string; createdAt?: string }>;
    entities?: Array<{ id: string; name: string; kind: string }>;
  };
  budget: { inputTokens: number; outputTokens: number; compacted: boolean };
  version: string; // schema version
};

export type ContextSubQuestion = {
  id: string;             // stable id (e.g., sq-001)
  text: string;           // normalized sub-question
  coverage: 'gap' | 'partial' | 'primary'; // stubbed now as 'gap'
  facts: string[];        // filled later
  code: Array<{
    path: string;
    startLine: number;
    endLine: number;
    snippet: string;
    compaction?: { removedLines: number[]; preservedLines: number[] };
    message?: { id: string | null; title: string; preview: string; conversation_id: string | null };
  }>;
  messages: Array<{
    conversationId: string;
    messageId: string;
    role: 'user' | 'assistant';
    excerpt: string;
  }>;
  sources: Array<{
    kind: 'file' | 'message' | 'entity';
    path?: string;
    startLine?: number; endLine?: number;
    conversationId?: string; messageId?: string;
    score: number;
    signals: Record<string, number>;
    content?: string;
  }>;
  /** NEW: simple, LLM-friendly list of file/line locations for this subquestion */
  locations?: Array<{ path: string; startLine?: number; endLine?: number }>;
  gaps?: string[];
};

export type ParsedOperators = {
  file?: string[];
  path?: string[];
  func?: string[];
  class?: string[];
  type?: Array<'code'|'file'|'message'|'entity'|'document'|'data'|'text'>;
  since?: string[];
  entity?: string[];
  raw?: Record<string, string[]>;
};
