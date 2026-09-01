// packages/backend/src/services/semantic-chunker/semantic-chunker.service.ts
import { LanguageManager, SemanticLanguage } from '../../LanguageManager.js';
import { Chunk } from './types.js';
import { JavaScriptStrategy } from './strategies/javascript.js';
import { PythonStrategy } from './strategies/python.js';

export class SemanticChunker {
  private languageManager: LanguageManager;
  private strategies: Map<SemanticLanguage, any> = new Map();

  constructor() {
    this.languageManager = LanguageManager.getInstance();
    
    // Register JS/TS/TSX strategy
    const jsStrategy = new JavaScriptStrategy();
    this.strategies.set('javascript', jsStrategy);
    this.strategies.set('typescript', jsStrategy);
    this.strategies.set('tsx', jsStrategy);
    
    // Register Python
    const pyStrategy = new PythonStrategy();
    this.strategies.set('python', pyStrategy);
  }

  public async chunkFile(filePath: string, content: string): Promise<Chunk[]> {
    const lang = this.languageManager.getLanguageFromExtension(filePath);
    console.log(`[SemanticChunker] File: ${filePath}, Detected lang: ${lang}`);

    // 1. Fallback for non-semantic languages
    if (!this.languageManager.isSemanticLanguage(lang)) {
      console.log(`[SemanticChunker] Not semantic language, using line-based`);
      return this.lineBasedChunking(content);
    }

    // 2. Parse using Tree-sitter
    const parser = await this.languageManager.getParser(lang);
    if (!parser) {
      console.warn(`[SemanticChunker] Parser failed for ${lang}, falling back`);
      return this.lineBasedChunking(content);
    }

    // 3. Select Strategy
    const strategy = this.strategies.get(lang);
    if (!strategy) {
      console.log(`[SemanticChunker] No strategy for ${lang}, falling back`);
      return this.lineBasedChunking(content);
    }

    console.log(`[SemanticChunker] Using ${lang} strategy`);
    try {
      const chunks = strategy.chunk(content, parser, filePath);
      console.log(`[SemanticChunker] Strategy returned ${chunks.length} chunks`);
      return chunks;
    } catch (e) {
      console.error("[SemanticChunker] Chunking error:", e);
      return this.lineBasedChunking(content);
    }
  }

  // Fallback implementation
  private lineBasedChunking(content: string, chunkSize = 120, overlap = 20): Chunk[] {
    const lines = content.split('\n');
    const chunks: Chunk[] = [];
    let start = 0;

    while (start < lines.length) {
      const end = Math.min(lines.length, start + chunkSize);
      const text = lines.slice(start, end).join('\n');
      chunks.push({ 
          text, 
          startLine: start + 1, 
          endLine: end,
          type: 'block' 
      });

      if (end === lines.length) break;
      start = end - overlap;
    }

    return chunks;
  }
}