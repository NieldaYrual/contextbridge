// packages/backend/src/types/agent-dsl.types.ts

/**
 * Agent DSL (Domain-Specific Language) for ContextBridge
 * This defines the structured output format from the LLM intent parser
 */

export interface AgentPlan {
  // Basic understanding
  intent: 'search' | 'insert' | 'search_and_insert' | 'clarification_needed';
  confidence: number; // 0.0 - 1.0
  
  // Search parameters
  search: {
    query: string; // extracted keywords for semantic/keyword search
    filters?: {
      dateRange?: {
        from?: string; // ISO date
        to?: string;
        relative?: string; // "2 months ago", "last week"
      };
      fileTypes?: string[]; // ['.ts', '.py', '.pdf']
      conversationTitles?: string[]; // partial match
      contentTypes?: ('message' | 'file' | 'block')[]; // scope
      entityTypes?: string[]; // ['person', 'organization', 'location']
    };
    limit?: number; // max results to consider
  };
  
  // Selection strategy (what to pick from results)
  selection: {
    strategy: 'first' | 'last' | 'all' | 'top_n' | 'specific_indices' | 'highest_scored';
    count?: number; // for 'top_n'
    indices?: number[]; // for 'specific_indices' (0-based: [0, 2, 4])
    scoreThreshold?: number; // for 'highest_scored' (0.0 - 1.0)
  };
  
  // Transformation (how to process each selected item)
  transform: {
    mode: 'full' | 'snippet' | 'lines' | 'first_n_lines' | 'custom';
    lineRange?: {
      start?: number; // 1-based line number
      end?: number;
      first?: number; // first N lines
      last?: number; // last N lines
    };
    snippetContext?: number; // sentences of context around match
    customInstructions?: string; // for complex transformations
  };
  
  // Output format
  output: {
    format: 'plain' | 'markdown' | 'code_fence';
    includeMetadata: boolean; // include source attribution
    includeScores: boolean; // show relevance scores
    separator?: string; // between multiple items
  };
  
  // Budget constraints
  budget: {
    maxTokens?: number; // hard limit
    preferredTokens?: number; // soft target
    truncationStrategy?: 'trim_end' | 'trim_start' | 'smart_summarize';
  };
  
  // Action to take
  action: {
    type: 'auto_insert' | 'show_preview' | 'copy_to_clipboard';
    insertionPoint?: 'cursor' | 'end' | 'replace'; // for auto_insert
  };
  
  // Clarification (if intent unclear)
  clarification?: {
    reason: string;
    suggestedQuestions: string[];
  };
}

// Example plans for reference:
export const EXAMPLE_PLANS: Record<string, AgentPlan> = {
  // "find the last version of knowledge-graph.routes.ts and insert it"
  simpleFileSearch: {
    intent: 'search_and_insert',
    confidence: 0.95,
    search: {
      query: 'knowledge-graph.routes.ts',
      filters: {
        fileTypes: ['.ts'],
        contentTypes: ['file', 'block']
      },
      limit: 5
    },
    selection: {
      strategy: 'last' // most recent version
    },
    transform: {
      mode: 'full'
    },
    output: {
      format: 'code_fence',
      includeMetadata: true,
      includeScores: false
    },
    budget: {
      maxTokens: 4000
    },
    action: {
      type: 'auto_insert',
      insertionPoint: 'cursor'
    }
  },
  
  // "get the first 3 results for semantic search and show only first 5 lines"
  partialResults: {
    intent: 'search',
    confidence: 0.90,
    search: {
      query: 'semantic search',
      limit: 10
    },
    selection: {
      strategy: 'top_n',
      count: 3
    },
    transform: {
      mode: 'first_n_lines',
      lineRange: { first: 5 }
    },
    output: {
      format: 'markdown',
      includeMetadata: true,
      includeScores: true,
      separator: '\n\n---\n\n'
    },
    budget: {
      preferredTokens: 500
    },
    action: {
      type: 'show_preview'
    }
  },
  
  // "find my conversation about real estate from 2 months ago, full thing"
  temporalSearch: {
    intent: 'search_and_insert',
    confidence: 0.85,
    search: {
      query: 'real estate',
      filters: {
        dateRange: {
          relative: '2 months ago'
        },
        contentTypes: ['message']
      },
      limit: 20
    },
    selection: {
      strategy: 'highest_scored',
      scoreThreshold: 0.7,
      count: 1
    },
    transform: {
      mode: 'full'
    },
    output: {
      format: 'markdown',
      includeMetadata: true,
      includeScores: false
    },
    budget: {
      maxTokens: 8000,
      truncationStrategy: 'smart_summarize'
    },
    action: {
      type: 'show_preview' // because "full thing" might be huge
    }
  }
};

// Validation helper
export function validateAgentPlan(plan: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!plan.intent) {
    errors.push('Missing required field: intent');
  }
  
  // Only require search.query for search/search_and_insert intents
  if (!plan.search) {
    errors.push('Missing required field: search');
  } else {
    // For pure "insert" intent, empty query is OK (we're selecting from existing results)
    const needsQuery = plan.intent !== 'insert';
    if (needsQuery && !plan.search.query) {
      errors.push('Missing required field: search.query (required for search intents)');
    }
  }
  
  if (!plan.selection?.strategy) {
    errors.push('Missing required field: selection.strategy');
  }
  
  if (!plan.transform?.mode) {
    errors.push('Missing required field: transform.mode');
  }
  
  // Validate ranges
  if (plan.budget?.maxTokens !== undefined && plan.budget.maxTokens < 0) {
    errors.push('budget.maxTokens must be positive');
  }
  
  if (plan.selection?.count !== undefined && plan.selection.count < 1) {
    errors.push('selection.count must be at least 1');
  }
  
  // Validate indices are numbers
  if (plan.selection?.strategy === 'specific_indices') {
    if (!Array.isArray(plan.selection.indices) || plan.selection.indices.length === 0) {
      errors.push('selection.indices must be a non-empty array for specific_indices strategy');
    } else if (!plan.selection.indices.every((idx: any) => typeof idx === 'number' && idx >= 0)) {
      errors.push('selection.indices must contain only non-negative numbers');
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}