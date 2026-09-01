import { Router } from 'express';
import { getEmbeddingService } from '../services/embedding.service';

const router = Router();

// Test endpoint for embedding generation
router.post('/api/test/embedding', async (req, res) => {
  try {
    const embeddingService = getEmbeddingService();
    const { text = "Testing context injection semantic search" } = req.body;
    
    console.log('Testing embedding generation for:', text);
    
    // Test: Generate embedding with metadata
    const result = await embeddingService.generateEmbedding(text);
    console.log('Embedding generated');
    console.log('Service:', result.model);
    console.log('Dimensions:', result.dimensions);
    console.log('First 5 values:', result.embedding.slice(0, 5));
    
    // Test: Generate pgvector format
    const vectorResult = await embeddingService.generateEmbeddingVector(text);
    console.log('Vector format ready, length:', vectorResult.vector.length);
    
    // Test: Check available models
    const available = embeddingService.getAvailableModels();
    console.log('Available models:', available);
    
    res.json({
      success: true,
      text: text,
      service: result.model,
      dimensions: result.dimensions,
      firstFiveValues: result.embedding.slice(0, 5),
      vectorFormatLength: vectorResult.vector.length,
      isValidPgvectorFormat: vectorResult.vector.startsWith('[') && vectorResult.vector.endsWith(']'),
      availableModels: available,
      sample: vectorResult.vector.substring(0, 100) + '...'
    });
    
  } catch (error: any) {
    console.error('Embedding test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

export default router;