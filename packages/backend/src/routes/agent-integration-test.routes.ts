// packages/backend/src/routes/agent-integration-test.routes.ts

import { Router, Request, Response } from 'express';
import { getIntentParser } from '../services/intent-parser.service';
import { getPlanExecutor, SearchItem } from '../services/plan-executor.service';

const router = Router();

/**
 * POST /api/agent/execute-test
 * Full pipeline test: instruction → plan → execution → output
 */
router.post('/api/agent/execute-test', async (req: Request, res: Response) => {
  try {
    const {
      instruction,
      mockItems = [],
      budgetTokens = 2000,
      projectId = 'test-project'
    } = req.body;

    if (!instruction) {
      return res.status(400).json({
        error: 'instruction is required',
        example: {
          instruction: 'insert the second result',
          mockItems: [
            { id: '1', kind: 'message', title: 'First conversation', content: 'Hello world' },
            { id: '2', kind: 'message', title: 'Second conversation', content: 'This is the content' }
          ]
        }
      });
    }

    if (!Array.isArray(mockItems) || mockItems.length === 0) {
      return res.status(400).json({
        error: 'mockItems array is required (simulates search results)'
      });
    }

    console.log(`\n🚀 Starting full pipeline test for: "${instruction}"`);
    const startTime = Date.now();

    // Step 1: Parse instruction into AgentPlan
    console.log('📝 Step 1: Parsing instruction...');
    const parser = getIntentParser();
    const parseResult = await parser.parseInstruction(instruction, {
      projectId,
      budgetTokens,
      itemsMeta: mockItems.map((item: any, idx: number) => ({
        index: idx,
        title: item.title || 'Untitled',
        kind: item.kind || 'message',
        id: item.id
      }))
    });

    if (!parseResult.success || !parseResult.plan) {
      return res.status(400).json({
        success: false,
        error: parseResult.error || 'Failed to parse instruction',
        step: 'parse',
        rawResponse: parseResult.rawResponse
      });
    }

    const parseTime = Date.now() - startTime;
    console.log(`  ✅ Parsed in ${parseTime}ms (source: ${parseResult.source})`);

    // Step 2: Execute the plan
    console.log('⚙️  Step 2: Executing plan...');
    const executor = getPlanExecutor();
    const executionResult = await executor.executePlan(
      parseResult.plan,
      mockItems as SearchItem[]
    );

    if (!executionResult.success) {
      return res.status(500).json({
        success: false,
        error: executionResult.error || 'Execution failed',
        step: 'execute',
        plan: parseResult.plan
      });
    }

    const totalTime = Date.now() - startTime;
    console.log(`  ✅ Executed in ${totalTime - parseTime}ms`);
    console.log(`\n✅ Pipeline complete in ${totalTime}ms\n`);

    // Step 3: Return comprehensive result
    return res.json({
      success: true,
      totalTime: `${totalTime}ms`,
      pipeline: {
        parse: {
          source: parseResult.source,
          time: `${parseTime}ms`,
          confidence: parseResult.plan.confidence,
          intent: parseResult.plan.intent
        },
        execute: {
          time: `${totalTime - parseTime}ms`,
          itemsSelected: executionResult.selectedItems?.length || 0,
          tokenEstimate: executionResult.tokenEstimate,
          truncated: executionResult.truncated
        }
      },
      plan: parseResult.plan,
      result: {
        pasteBlock: executionResult.pasteBlock,
        tokenEstimate: executionResult.tokenEstimate,
        truncated: executionResult.truncated,
        selectedItems: executionResult.selectedItems?.map(item => ({
          id: item.id,
          title: item.title,
          kind: item.kind,
          contentLength: item.content?.length || 0
        })),
        metadata: executionResult.metadata
      }
    });

  } catch (error: any) {
    console.error('❌ Integration test error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || String(error)
    });
  }
});

/**
 * GET /api/agent/integration-examples
 * Get example test scenarios
 */
router.get('/api/agent/integration-examples', (req: Request, res: Response) => {
  const mockData = [
    {
      id: 'msg-1',
      kind: 'message',
      title: 'Database Migration Discussion',
      content: 'We should migrate to PostgreSQL for better performance.\nThe current MySQL setup has scaling issues.\nProposed timeline: 2 weeks.',
      score: 0.95,
      created_at: '2024-10-15T10:30:00Z'
    },
    {
      id: 'file-1',
      kind: 'file',
      title: 'background.js',
      content: `// Background service worker
console.log('Extension loaded');

chrome.runtime.onInstalled.addListener(() => {
  console.log('Extension installed');
});

function captureData() {
  // Capture logic here
  return { success: true };
}`,
      score: 0.88,
      created_at: '2024-10-16T14:20:00Z'
    },
    {
      id: 'msg-2',
      kind: 'message',
      title: 'API Endpoint Design',
      content: 'The new /api/search endpoint should support:\n- Semantic search\n- Keyword filtering\n- Entity recognition\n- Token budget limits',
      score: 0.82,
      created_at: '2024-10-17T09:15:00Z'
    },
    {
      id: 'block-1',
      kind: 'block',
      title: 'SQL Query',
      content: `SELECT 
  conversations.id,
  conversations.title,
  COUNT(messages.id) as message_count
FROM conversations
LEFT JOIN messages ON messages.conversation_id = conversations.id
WHERE conversations.project_id = $1
GROUP BY conversations.id
ORDER BY conversations.created_at DESC
LIMIT 50;`,
      score: 0.75,
      created_at: '2024-10-18T11:00:00Z'
    }
  ];

  const testScenarios = [
    {
      name: 'Simple selection',
      instruction: 'insert the second result',
      mockItems: mockData,
      expectedBehavior: 'Should select background.js file and insert full content'
    },
    {
      name: 'Line extraction',
      instruction: 'show the first 5 lines of the second result',
      mockItems: mockData,
      expectedBehavior: 'Should show first 5 lines of background.js'
    },
    {
      name: 'Complex search and insert',
      instruction: 'find the most recent file about background and insert it',
      mockItems: mockData,
      expectedBehavior: 'Should use LLM to parse, select background.js, insert with code fence'
    },
    {
      name: 'Multiple items with budget',
      instruction: 'insert first 3 results',
      mockItems: mockData,
      expectedBehavior: 'Should format 3 items with separators and metadata'
    },
    {
      name: 'Budget enforcement',
      instruction: 'insert all results',
      mockItems: mockData,
      budgetTokens: 200,
      expectedBehavior: 'Should truncate output to fit 200 token budget'
    }
  ];

  res.json({
    mockData,
    testScenarios,
    usage: 'POST /api/agent/execute-test with { instruction, mockItems }'
  });
});

export default router;