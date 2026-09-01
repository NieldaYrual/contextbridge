import { Ollama } from 'ollama';
import OpenAI from 'openai';
import { z } from 'zod';

// Extraction result schema
const ExtractionSchema = z.object({
  files: z.array(z.object({
    name: z.string(),
    language: z.string().optional(),
    content: z.string().optional()
  })).optional(),
  decisions: z.array(z.string()).optional(),
  requirements: z.array(z.string()).optional(),
  architecture: z.array(z.string()).optional(),
  problems: z.array(z.string()).optional(),
  entities: z.array(z.object({
    name: z.string(),
    type: z.string()
  })).optional(),
  urls: z.array(z.string()).optional(),
  links: z.array(z.string()).optional()
});

export type ExtractionResult = z.infer<typeof ExtractionSchema>;

export class ExtractionService {
  private ollama: Ollama | null = null;
  private openai: OpenAI | null = null;
  
  constructor() {
    // Initialize Ollama (now that it's installed)
    try {
      this.ollama = new Ollama({
        host: process.env.OLLAMA_HOST || 'http://localhost:11434'
      });
      console.log('Ollama initialized successfully');
    } catch (error) {
      console.log('Ollama initialization failed:', error);
      this.ollama = null;
    }
    
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    }
  }

   async extractContext(conversation: string): Promise<ExtractionResult> {
    try {
      // Check if Ollama is available
      if (!this.ollama) {
        if (this.openai) {
          return await this.openaiExtract(conversation);
        } else {
          return this.fallbackExtraction(conversation);
        }
      }
      
      // Use CodeLlama as primary extractor
      const baseExtraction = await this.codeLlamaExtract(conversation);
      const needsRefinement = this.checkComplexity(baseExtraction);
      
      if (needsRefinement && this.openai) {
        return await this.refineWithGPT(baseExtraction, conversation);
      }
      
      return baseExtraction;
    } catch (error) {
      console.error('Extraction failed:', error);
      return this.fallbackExtraction(conversation);
    }
  }

  private async openaiExtract(conversation: string): Promise<ExtractionResult> {
    if (!this.openai) return this.fallbackExtraction(conversation);

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Extract key information from this conversation:
          1. Files or documents mentioned
          2. Decisions made
          3. Requirements stated
          4. Architecture/organizational choices
          5. Problems discussed
          6. People/companies mentioned
          7. URLs and links
          
          Conversation: ${conversation.substring(0, 4000)}
          
          Return as JSON with keys: files, decisions, requirements, architecture, problems, entities, urls, links`
        }],
        response_format: { type: 'json_object' }
      });

      const extracted = JSON.parse(response.choices[0].message.content || '{}');
      return ExtractionSchema.parse(extracted);
    } catch (error) {
      console.error('OpenAI extraction failed:', error);
      return this.fallbackExtraction(conversation);
    }
  }

  private async codeLlamaExtract(conversation: string): Promise<ExtractionResult> {
    if (!this.ollama) {
      throw new Error('Ollama not initialized');
    }
    
    const prompt = `Extract key information from this conversation.
    
    IMPORTANT: Return a valid JSON with these exact keys, where ALL values must be arrays (even if empty):
    - files: array of objects with name and language
    - decisions: array of strings  
    - requirements: array of strings
    - architecture: array of strings
    - problems: array of strings
    - entities: array of objects with name and type
    - urls: array of strings
    - links: array of strings

    Example response:
    {"files": [], "decisions": ["item1"], "requirements": [], "architecture": [], "problems": [], "entities": [{"name": "John", "type": "person"}], "urls": [], "links": []}

    Conversation: ${conversation.substring(0, 4000)}`;

    try {
      const response = await this.ollama.chat({
        model: 'codellama:7b',
        messages: [{ role: 'user', content: prompt }],
        format: 'json',
        stream: false
      });

      const content = response.message.content;
      let parsed = JSON.parse(content);
      
      // Fix common CodeLlama issues - convert strings to arrays
      ['requirements', 'architecture', 'problems', 'decisions', 'urls', 'links'].forEach(field => {
        if (typeof parsed[field] === 'string') {
          parsed[field] = [parsed[field]];
        }
      });
      
      return ExtractionSchema.parse(parsed);
    } catch (error) {
      console.error('CodeLlama extraction failed:', error);
      throw error;
    }
  }

  private checkComplexity(extraction: ExtractionResult): boolean {
    // Check if this needs GPT-4 refinement
    const hasArchitecture = extraction.architecture && extraction.architecture.length > 0;
    const hasMultipleFiles = extraction.files && extraction.files.length > 3;
    const hasComplexDecisions = extraction.decisions && 
      extraction.decisions.some(d => 
        d.toLowerCase().includes('architecture') ||
        d.toLowerCase().includes('design pattern') ||
        d.toLowerCase().includes('performance')
      );
    
    return hasArchitecture || hasMultipleFiles || hasComplexDecisions || false;
  }

  private async refineWithGPT(
    baseExtraction: ExtractionResult, 
    conversation: string
  ): Promise<ExtractionResult> {
    if (!this.openai) return baseExtraction;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Enhance this extraction with deeper analysis:
          
          Original extraction: ${JSON.stringify(baseExtraction)}
          
          Conversation excerpt: ${conversation.substring(0, 2000)}
          
          Add any missing: relationships between components, implicit requirements, architectural patterns.
          Return as JSON matching the original structure.`
        }],
        response_format: { type: 'json_object' }
      });

      const enhanced = JSON.parse(response.choices[0].message.content || '{}');
      // Fix requirements if they're objects instead of strings
      if (enhanced.requirements && Array.isArray(enhanced.requirements)) {
        enhanced.requirements = enhanced.requirements.map((req: any) => 
          typeof req === 'object' ? JSON.stringify(req) : req
        );
      }

      return ExtractionSchema.parse(enhanced);
    } catch (error) {
      console.error('GPT refinement failed:', error);
      return baseExtraction;
    }
  }

  private fallbackExtraction(conversation: string): ExtractionResult {
    // Basic pattern matching fallback
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    const files: any[] = [];
    let match;
    
    while ((match = codeBlockRegex.exec(conversation)) !== null) {
      if (match[1]) {
        files.push({
          name: `extracted_code.${match[1]}`,
          language: match[1],
          content: match[2]
        });
      }
    }

    return {
      files,
      decisions: [],
      requirements: [],
      architecture: [],
      problems: [],
      entities: [],
      urls: [],
      links: []
    };
  }

  async generateEmbedding(text: string): Promise<number[] | null> {
    if (!this.openai) return null;

    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text.substring(0, 8000) // Limit length
      });

      return response.data[0].embedding;
    } catch (error) {
      console.error('Embedding generation failed:', error);
      return null;
    }
  }
}