import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { SupabaseClient } from '@supabase/supabase-js';
import { ExtractionService } from '../services/extraction.service';
import dotenv from 'dotenv';

export function createConversationRoutes(supabase: SupabaseClient) {
  const router = Router();
  const extractionService = new ExtractionService();

// Load environment variables
dotenv.config({ path: '../../.env' });

// Create Supabase client with error checking
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Missing Supabase environment variables!');
  console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? 'Set' : 'Missing');
  console.log('SUPABASE_SERVICE_KEY:', process.env.SUPABASE_SERVICE_KEY ? 'Set' : 'Missing');
}

// Process and store a conversation (LLM-agnostic)
router.post('/conversations/process', async (req, res) => {
  try {
    const { 
      projectId, 
      branchId, 
      messages, 
      conversationId,  // Made generic (not claude-specific)
      llmProvider = 'claude'  // Default to claude but accept others
    } = req.body;

     // Extract context from conversation
    const conversationText = messages.map((m: any) => 
      `${m.role}: ${m.content}`
    ).join('\n\n');

    console.log(`Extracting context from ${llmProvider} conversation...`);
    const extraction = await extractionService.extractContext(conversationText);

    // Generate embedding for semantic search
    const embedding = await extractionService.generateEmbedding(conversationText);

    // Determine extraction method based on what's available
    let extractionMethod = 'fallback';
    if (extractionService['ollama']) {  // Check if Ollama is available
      extractionMethod = 'codellama-7b';
    } else if (process.env.OPENAI_API_KEY) {
      extractionMethod = 'gpt-4o-mini';
    }

    // Store conversation
    const { data: conversation, error: convError } = await supabase
      .from('cb_conversations')
      .insert({
        project_id: projectId,
        branch_id: branchId,
        claude_conversation_id: conversationId,  // Keep column name for now but it works for any LLM
        llm_provider: llmProvider,  // Track which LLM
        raw_messages: messages,
        summary: extraction.decisions?.join('; ') || '',
        extracted_context: extraction,
        embedding: embedding,
        extraction_method: extractionMethod
      })
      .select()
      .single();

    if (convError) throw convError;

    // Store artifacts
    if (extraction.files && extraction.files.length > 0) {
      const artifacts = extraction.files.map(file => ({
        conversation_id: conversation.id,
        project_id: projectId,
        type: 'code',
        name: file.name,
        content: file.content || '',
        language: file.language,
        embedding: null // Generate individual embeddings later if needed
      }));

      const { error: artifactError } = await supabase
        .from('artifacts')
        .insert(artifacts);

      if (artifactError) throw artifactError;
    }

    // Store URLs if extracted
    if (extraction.urls && extraction.urls.length > 0) {
      const urls = extraction.urls.map(url => ({
        conversation_id: conversation.id,
        project_id: projectId,
        url: url,
        title: null,
        description: null
      }));

      const { error: urlError } = await supabase
        .from('extracted_urls')
        .insert(urls);

      if (urlError) console.error('URL storage error:', urlError);
    }

    res.json({
      success: true,
      conversationId: conversation.id,
      extraction
    });

  } catch (error: any) {
    console.error('Processing error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test extraction endpoint
router.post('/test-extraction', async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text) {
      return res.status(400).json({
        success: false,
        error: 'No text provided'
      });
    }

    console.log('Testing extraction...');
    const extraction = await extractionService.extractContext(text);

    res.json({
      success: true,
      extraction
    });

  } catch (error: any) {
    console.error('Extraction test error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

  return router;
}