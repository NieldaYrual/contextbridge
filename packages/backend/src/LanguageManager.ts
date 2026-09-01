import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Handle module wrapping (CommonJS vs ESM interop)
const TreeSitter = require('web-tree-sitter');

export type SemanticLanguage = 'javascript' | 'typescript' | 'tsx' | 'python' | 'rust' | 'go';
export type FallbackLanguage = 'json' | 'markdown' | 'html' | 'css' | 'yaml' | 'unknown';
export type SupportedLanguage = SemanticLanguage | FallbackLanguage;

export class LanguageManager {
  private static instance: LanguageManager;
  private isInitialized = false;

  // Cache the "Heavy" Language objects (WASM modules) separately
  private languages: Map<SemanticLanguage, any> = new Map();
  
  // Cache the Parsers (Lightweight wrappers)
  private parsers: Map<SemanticLanguage, any> = new Map();

  private constructor() {}

  public static getInstance(): LanguageManager {
    if (!LanguageManager.instance) {
      LanguageManager.instance = new LanguageManager();
    }
    return LanguageManager.instance;
  }

  public async init(): Promise<void> {
    if (this.isInitialized) return;
    
    await TreeSitter.Parser.init();
    
    this.isInitialized = true;
    console.log('✅ Tree-sitter WASM initialized');
  }

  /**
   * ROBUST FINDER: Checks multiple standard locations for the .wasm file
   */
  private findWasmPath(packageName: string, wasmFileName: string): string | null {
    try {
      let currentDir = path.dirname(require.resolve(packageName));

      // 1. Walk up to find package root
      for (let i = 0; i < 10; i++) {
        if (fs.existsSync(path.join(currentDir, 'package.json'))) {
          // Found the root! Now check candidates.
          const candidates = [
            path.join(currentDir, wasmFileName),           // Root
            path.join(currentDir, 'dist', wasmFileName),   // Dist folder
            path.join(currentDir, 'wasm', wasmFileName),   // Wasm folder
            path.join(currentDir, 'lib', wasmFileName),    // Lib folder
            path.join(currentDir, 'bindings', 'node', wasmFileName) // Bindings folder
          ];

          for (const candidate of candidates) {
            if (fs.existsSync(candidate)) return candidate;
          }
          
          console.warn(`⚠️ Package ${packageName} found at ${currentDir}, but ${wasmFileName} was not in standard subfolders.`);
          return null;
        }
        
        const parent = path.dirname(currentDir);
        if (parent === currentDir) break;
        currentDir = parent;
      }
      return null;
    } catch (err) {
      console.warn(`❌ Package not found: ${packageName}`);
      return null;
    }
  }

  /**
   * Loads the Language (Heavy) once, then returns a Parser (Light)
   */
  public async getParser(lang: SemanticLanguage): Promise<any | null> {
    if (!this.isInitialized) await this.init();

    // 1. Return cached parser if available
    if (this.parsers.has(lang)) {
      return this.parsers.get(lang);
    }

    // 2. Load Language if not cached (Heavy I/O + Compile)
    if (!this.languages.has(lang)) {
        const wasmMap: Record<SemanticLanguage, { pkg: string; file: string }> = {
            javascript: { pkg: 'tree-sitter-javascript', file: 'tree-sitter-javascript.wasm' },
            typescript: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
            tsx:        { pkg: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' },
            python:     { pkg: 'tree-sitter-python',     file: 'tree-sitter-python.wasm' },
            rust:       { pkg: 'tree-sitter-rust',       file: 'tree-sitter-rust.wasm' },
            go:         { pkg: 'tree-sitter-go',         file: 'tree-sitter-go.wasm' },
        };

        const info = wasmMap[lang];
        const wasmPath = this.findWasmPath(info.pkg, info.file);

        if (!wasmPath) {
            console.error(`Cannot load parser for ${lang}: WASM file not found in ${info.pkg}`);
            return null;
        }

        try {
            const language = await TreeSitter.Language.load(wasmPath);
            this.languages.set(lang, language);
        } catch (err) {
            console.error(`Failed to load WASM for ${lang}:`, err);
            return null;
        }
    }

    // 3. Create and configure Parser (Lightweight)
    try {
        const parser = new TreeSitter.Parser();
        parser.setLanguage(this.languages.get(lang));
        
        // Cache the parser instance too
        this.parsers.set(lang, parser);
        return parser;
    } catch (err) {
        console.error(`Failed to create parser for ${lang}:`, err);
        return null;
    }
  }

  public getLanguageFromExtension(filename: string): SupportedLanguage {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const extMap: Record<string, SupportedLanguage> = {
      js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
      ts: 'typescript', tsx: 'tsx',
      py: 'python',
      rs: 'rust',
      go: 'go',
      json: 'json', md: 'markdown', markdown: 'markdown',
      html: 'html', htm: 'html', css: 'css', scss: 'css',
      yaml: 'yaml', yml: 'yaml',
    };
    return extMap[ext] || 'unknown';
  }

  public isSemanticLanguage(lang: SupportedLanguage): lang is SemanticLanguage {
    return ['javascript', 'typescript', 'tsx', 'python', 'rust', 'go'].includes(lang);
  }
}