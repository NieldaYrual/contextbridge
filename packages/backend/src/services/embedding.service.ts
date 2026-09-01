import OpenAI from 'openai';
import { Ollama } from 'ollama';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { encoding_for_model } from 'tiktoken';
import pLimit from 'p-limit';
import sgMail from '@sendgrid/mail';

// ====================================================================
// BATCH EMBEDDING CONFIGURATION
// ====================================================================
const EMBED_BATCH_SIZE = 500;      // Max inputs per OpenAI API request (max: 2048)
const EMBED_CONCURRENCY = 5;       // Max parallel OpenAI batch requests
// Singleton tiktoken encoder — created once, reused for all truncation calls
const _encoder = encoding_for_model('text-embedding-3-small');
// ====================================================================

type EmbeddingModel = {
  name: string;
  dimensions: number;
  service: 'openai' | 'ollama';
};

export class EmbeddingService {
  private openai: OpenAI | null = null;
  private ollama: Ollama | null = null;
  private supabase: SupabaseClient | null = null;
  
  // Model configurations
  private models: Record<string, EmbeddingModel> = {
    'text-embedding-3-small': { name: 'text-embedding-3-small', dimensions: 1536, service: 'openai' },
    'nomic-embed-text': { name: 'nomic-embed-text', dimensions: 768, service: 'ollama' },
  };
  
  private currentModel: string = 'text-embedding-3-small'; // Default

  // Lazy initialization
  private initClients() {
    if (!this.openai && process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
      console.log('OpenAI embedding service initialized');
    }
    
    if (!this.ollama) {
      try {
        this.ollama = new Ollama({
          host: process.env.OLLAMA_HOST || 'http://localhost:11434'
        });
        console.log('Ollama embedding service initialized');
      } catch (error) {
        console.log('Ollama initialization skipped:', error);
        this.ollama = null;
      }
    }
    
    if (!this.supabase) {
      this.supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_KEY!
      );
    }
  }

  /**
   * Generate embedding using the best available service
   * Returns both the embedding vector and metadata about which model was used
   */
  async generateEmbedding(text: string): Promise<{
    embedding: number[];
    model: string;
    dimensions: number;
  }> {
    this.initClients();
    
    const preSliced = text.length > 35000 ? text.slice(0, 35000) : text;
    const tokens = _encoder.encode(preSliced);
    const maxTokens = 8000;
    const truncatedTokens = tokens.slice(0, maxTokens);
    const cleanText = new TextDecoder('utf-8', { fatal: false }).decode(_encoder.decode(truncatedTokens)).replace(/\s+/g, ' ').trim();
    
    // Try OpenAI first (highest quality)
    if (this.openai) {
      try {
        const response = await this.openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: cleanText,
          dimensions: 1536,
        });
        
        return {
          embedding: response.data[0].embedding,
          model: 'text-embedding-3-small',
          dimensions: 1536,
        };
      } catch (error) {
        console.error('OpenAI embedding failed, trying Ollama:', error);
      }
    }
    
    // Fallback to Ollama
    if (this.ollama) {
      try {
        const response = await this.ollama.embeddings({
          model: 'nomic-embed-text',
          prompt: cleanText,
        });
        
        return {
          embedding: response.embedding,
          model: 'nomic-embed-text',
          dimensions: 768,
        };
      } catch (error) {
        console.error('Ollama embedding failed:', error);
      }
    }
    
    throw new Error('No embedding service available. Please configure OPENAI_API_KEY or OLLAMA_HOST');
  }

  /**
   * Generate embedding in pgvector format with model metadata
   */
  async generateEmbeddingVector(text: string): Promise<{
    vector: string;
    model: string;
    dimensions: number;
  }> {
    const result = await this.generateEmbedding(text);
    return {
      vector: `[${result.embedding.join(',')}]`,
      model: result.model,
      dimensions: result.dimensions,
    };
  }

  /**
   * Get information about current embedding capability
   */
  getAvailableModels(): { service: string; model: string; dimensions: number }[] {
    this.initClients();
    const available = [];
    
    if (this.openai) {
      available.push({ service: 'openai', model: 'text-embedding-3-small', dimensions: 1536 });
    }
    if (this.ollama) {
      available.push({ service: 'ollama', model: 'nomic-embed-text', dimensions: 768 });
    }
    
    return available;
  }

  /**
   * Expose the initialised OpenAI client for batch operations outside the class.
   * Returns null if OPENAI_API_KEY is not configured.
   */
  getOpenAIClient(): OpenAI | null {
    this.initClients();
    return this.openai;
  }
}

// Factory function
// Singleton instance
let instance: EmbeddingService | null = null;

/**
 * Get the singleton instance of EmbeddingService
 * Creates the instance on first call, reuses it afterwards
 */
export const getEmbeddingService = (): EmbeddingService => {
  if (!instance) {
    instance = new EmbeddingService();
    console.log('🎯 EmbeddingService singleton initialized');
  }
  return instance;
};

// ====================================================================
// BACKFILL ADAPTER EXPORTS
// ====================================================================

/**
 * Reuse a single instance for backfill jobs to avoid repeated client init.
 */
const _embeddingService = getEmbeddingService();

/**
 * Truncate a single text to the OpenAI token limit before batching.
 */
function truncateText(text: string): string {
  // Rough character pre-slice before tokenization (~4 chars per token, 8000 tokens = 32000 chars, use 35000 for safety)
  const preSliced = text.length > 35000 ? text.slice(0, 35000) : text;
  
  const tokens = _encoder.encode(preSliced);
  
  // If under limit, return as-is — no encode/decode cycle, no sliced bytes
  if (tokens.length <= 8000) {
    return preSliced.replace(/\s+/g, ' ').trim();
  }
  
  // Over limit: truncate tokens and decode with fatal:false to handle broken multibyte chars
  const truncated = tokens.slice(0, 8000);
  const raw = _encoder.decode(truncated);
  return new TextDecoder('utf-8', { fatal: false }).decode(raw).replace(/\s+/g, ' ').trim();
}

/**
 * Batch-embed a list of texts using true OpenAI batch requests.
 * - Truncates each text to the 8000-token limit
 * - Splits into batches of EMBED_BATCH_SIZE (500)
 * - Runs up to EMBED_CONCURRENCY (5) batches in parallel
 * - Falls back to Ollama per-text if OpenAI is unavailable
 * - On error, inserts a zero vector to keep array alignment
 */
export async function embedBatch(
    texts: string[],
    meta?: { projectId?: string; conversationId?: string; messageUuid?: string }
  ): Promise<number[][]> {
  const openai = _embeddingService.getOpenAIClient();

  if (openai) {
    const truncated = texts.map(truncateText);
    const ZERO = new Array(1536).fill(0);

    // Pre-validate: mark empty texts as instant zero vectors
    const validIndices: number[] = [];
    const results: number[][] = truncated.map((t, i) => {
      if (!t || t.trim().length === 0) {
        console.warn(`[embedBatch] Skipping empty text at index ${i}`);
        return ZERO;
      }
      validIndices.push(i);
      return ZERO; // placeholder, replaced on success
    });

    // Binary bisect: embed a sub-array, isolating poison pills recursively
    async function embedWithBisect(indices: number[]): Promise<void> {
      if (indices.length === 0) return;
      const batch = indices.map(i => truncated[i]);
      try {
        const response = await openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: batch,
          dimensions: 1536,
        });
        response.data.forEach((d, pos) => {
          results[indices[pos]] = d.embedding;
        });
      } catch (err: any) {
        if (indices.length === 1) {
        // Poison pill isolated
        const content500 = truncated[indices[0]].slice(0, 500);
        console.error(`[embedBatch] ☠️ Poison pill isolated at index ${indices[0]}:`);
        console.error(`[embedBatch] Content (first 500 chars): ${content500}`);
        console.error(`[embedBatch] Error: ${err?.message || err}`);
        results[indices[0]] = ZERO;

        // Send SendGrid notification
        try {
          const apiKey = process.env.SENDGRID_API_KEY;
          const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'djl@ctxbridge.io';
          if (apiKey) {
            sgMail.setApiKey(apiKey);
            await sgMail.send({
              to: 'djl@ctxbridge.io',
              from: fromEmail,
              subject: '☠️ ContextBridge: Poison Pill Detected',
              text: [
                `A poison pill was isolated during embedding.`,
                ``,
                `Project ID:      ${meta?.projectId ?? 'unknown'}`,
                `Conversation ID: ${meta?.conversationId ?? 'unknown'}`,
                `Message UUID:    ${meta?.messageUuid ?? 'unknown'}`,
                ``,
                `Content (first 500 chars):`,
                content500,
                ``,
                `Error: ${err?.message || err}`
              ].join('\n')
            });
            console.log('[embedBatch] ☠️ Poison pill notification sent via SendGrid');
          }
        } catch (mailErr: any) {
          console.warn('[embedBatch] Failed to send poison pill notification:', mailErr?.message);
        }

        return;
      }
        // Split and recurse
        console.warn(`[embedBatch] Batch of ${indices.length} failed, bisecting...`);
        const mid = Math.floor(indices.length / 2);
        await embedWithBisect(indices.slice(0, mid));
        await embedWithBisect(indices.slice(mid));
      }
    }

    // Split validIndices into chunks of EMBED_BATCH_SIZE, run with concurrency limit
    const chunks: number[][] = [];
    for (let i = 0; i < validIndices.length; i += EMBED_BATCH_SIZE) {
      chunks.push(validIndices.slice(i, i + EMBED_BATCH_SIZE));
    }

    console.log(`[embedBatch] ${texts.length} texts → ${chunks.length} batches (size ${EMBED_BATCH_SIZE}, concurrency ${EMBED_CONCURRENCY})`);

    const limit = pLimit(EMBED_CONCURRENCY);
    await Promise.all(chunks.map(chunk => limit(() => embedWithBisect(chunk))));

    return results;
  }

  // Fallback: no OpenAI — embed one at a time via Ollama
  console.warn('[embedBatch] OpenAI unavailable, falling back to sequential Ollama embedding');
  const vectors: number[][] = [];
  for (const t of texts) {
    try {
      const { embedding } = await _embeddingService.generateEmbedding(t);
      vectors.push(embedding);
    } catch (err) {
      console.error('[embedBatch] Ollama fallback error:', err);
      vectors.push(new Array(1536).fill(0));
    }
  }
  return vectors;
}

/**
 * Metadata used by the backfill script when upserting into *_embeddings tables.
 */
export const EMBEDDING_MODEL_NAME = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

// ====================================================================