// packages/backend/src/routes/intent-parser-test.routes.ts

import { Router, Request, Response } from 'express';
import { getIntentParser } from '../services/intent-parser.service';

const router = Router();

/**
 * POST /api/agent/parse-test
 * Test the intent parser with various instructions
 */
router.post('/api/agent/parse-test', async (req: Request, res: Response) => {
  try {
    const {
      instruction,
      projectId = 'test-project',
      budgetTokens = 2000,
      itemsMeta = [],
      userPreferences = {},
      recentQueries = []
    } = req.body;

    if (!instruction) {
      return res.status(400).json({ 
        error: 'instruction is required',
        example: {
          instruction: 'find the last version of background.js and insert it',
          budgetTokens: 2000
        }
      });
    }

    const parser = getIntentParser();
    const startTime = Date.now();

    const result = await parser.parseInstruction(instruction, {
      projectId,
      budgetTokens,
      itemsMeta,
      userPreferences,
      recentQueries
    });

    const processingTime = Date.now() - startTime;

    return res.json({
      success: result.success,
      source: result.source, // 'fast-path' or 'llm'
      processingTime: `${processingTime}ms`,
      instruction,
      plan: result.plan,
      error: result.error,
      rawResponse: result.rawResponse?.substring(0, 500), // Truncate for readability
      metadata: {
        anthropicApiConfigured: !!process.env.ANTHROPIC_API_KEY,
        fastPathAvailable: true,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error: any) {
    console.error('❌ Parse test error:', error);
    return res.status(500).json({ 
      error: error.message || String(error) 
    });
  }
});

/**
 * POST /api/agent/parse-batch
 * Test multiple instructions at once (for benchmarking)
 */
router.post('/api/agent/parse-batch', async (req: Request, res: Response) => {
  try {
    const { instructions = [], budgetTokens = 2000 } = req.body;

    if (!Array.isArray(instructions) || instructions.length === 0) {
      return res.status(400).json({ 
        error: 'instructions array is required',
        example: {
          instructions: [
            'insert the first result',
            'show the last 5 lines of the second result',
            'find background.js and insert it'
          ]
        }
      });
    }

    const parser = getIntentParser();
    const results = [];
    const startTime = Date.now();

    for (const instruction of instructions) {
      const result = await parser.parseInstruction(instruction, {
        budgetTokens
      });

      results.push({
        instruction,
        success: result.success,
        source: result.source,
        confidence: result.plan?.confidence,
        intent: result.plan?.intent,
        selectionStrategy: result.plan?.selection?.strategy,
        error: result.error
      });
    }

    const totalTime = Date.now() - startTime;
    const fastPathCount = results.filter(r => r.source === 'fast-path').length;
    const llmCount = results.filter(r => r.source === 'llm').length;
    const failedCount = results.filter(r => !r.success).length;

    return res.json({
      totalInstructions: instructions.length,
      totalTime: `${totalTime}ms`,
      averageTime: `${Math.round(totalTime / instructions.length)}ms`,
      statistics: {
        fastPath: fastPathCount,
        llm: llmCount,
        failed: failedCount,
        successRate: `${Math.round((results.length - failedCount) / results.length * 100)}%`
      },
      results
    });

  } catch (error: any) {
    console.error('❌ Batch parse test error:', error);
    return res.status(500).json({ 
      error: error.message || String(error) 
    });
  }
});

/**
 * GET /api/agent/test-examples
 * Get example instructions to test with
 */
router.get('/api/agent/test-examples', (req: Request, res: Response) => {
  const examples = {
    fastPathExamples: [
      'insert the first result',
      'insert the second result',
      'show the first 5 lines of the third result',
      'insert first 3 results',
      'get lines 10-20 from the first result'
    ],
    llmExamples: [
      'find the last version of background.js and insert it',
      'get the most recent conversation about real estate from 2 months ago',
      'show me the top 5 results for semantic search',
      'find all TypeScript files related to knowledge graphs',
      'insert the full conversation about database migration'
    ],
    complexExamples: [
      'find conversations from last week about the API endpoint and show just the code blocks',
      'get the latest version of the routes file with highest relevance score',
      'show me the first 10 lines from all Python files mentioning embeddings'
    ]
  };

  res.json({
    examples,
    usage: {
      singleTest: 'POST /api/agent/parse-test with { instruction: "..." }',
      batchTest: 'POST /api/agent/parse-batch with { instructions: [...] }'
    }
  });
});

export default router;