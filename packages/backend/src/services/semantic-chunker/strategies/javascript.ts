import { Chunk, ChunkingStrategy } from '../types.js';

export class JavaScriptStrategy implements ChunkingStrategy {
  // Nodes we want to treat as standalone chunks
  private readonly TARGET_NODES = new Set([
    'function_declaration',
    'class_declaration',
    'lexical_declaration',      // const x = ...
    'variable_declaration',     // var x = ...
    'export_statement',
    'interface_declaration',
    'type_alias_declaration',
    'expression_statement',     // app.get(...), app.post(...), etc.
  ]);

  // Max lines before we force a split
  private readonly MAX_CHUNK_LINES = 250;
  
  // Min lines to be worth chunking (skip tiny one-liners)
  private readonly MIN_CHUNK_LINES = 8;

  chunk(content: string, parser: any, filePath?: string): Chunk[] {
    console.log('[JSStrategy] NEW STRATEGY RUNNING - MIN_CHUNK_LINES:', this.MIN_CHUNK_LINES);
    const tree = parser.parse(content);
    const chunks: Chunk[] = [];
    
    const visit = (node: any, parentName?: string) => {
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const length = endLine - startLine + 1;

      if (filePath?.includes('auth.routes') && this.TARGET_NODES.has(node.type)) {
        console.log(`[AST-TARGET] type=${node.type} lines=${startLine}-${endLine} (${length} lines)`);
      }

      // 1. Is this a node we care about?
      if (this.TARGET_NODES.has(node.type)) {
        
        // Skip tiny declarations (single-line const x = 5;)
        if (length < this.MIN_CHUNK_LINES && node.type !== 'class_declaration' && node.type !== 'function_declaration') {
          return;
        }

        // 2. Is it too big? (Recursive Strategy for classes)
        if (length > this.MAX_CHUNK_LINES && node.type === 'class_declaration') {
          // Drill down into the class body to chunk methods individually
          node.children.forEach((child: any) => {
            if (child.type === 'class_body') {
              child.children.forEach((method: any) => {
                if (method.type === 'method_definition') {
                  chunks.push({
                    text: method.text,
                    startLine: method.startPosition.row + 1,
                    endLine: method.endPosition.row + 1,
                    type: 'method',
                    parentName: this.extractIdentifier(node)
                  });
                }
              });
            }
          });
          return; // Don't add the huge class itself
        }

        // 2b. Large export_statement? Drill into children
        if (length > this.MAX_CHUNK_LINES && node.type === 'export_statement') {
          if (node.children) {
            node.children.forEach((child: any) => visit(child, parentName));
          }
          return;
        }

        // 2c. Large function_declaration? Drill into its body
        if (length > this.MAX_CHUNK_LINES && node.type === 'function_declaration') {
          if (node.children) {
            node.children.forEach((child: any) => visit(child, parentName || this.extractIdentifier(node)));
          }
          return;
        }

        // 2d. Large lexical/variable declarations? Drill into children
        if (length > this.MAX_CHUNK_LINES && (node.type === 'lexical_declaration' || node.type === 'variable_declaration')) {
          if (node.children) {
            node.children.forEach((child: any) => visit(child, parentName));
          }
          return;
        }

        // 3. For large expression statements, split them
        if (length > this.MAX_CHUNK_LINES && node.type === 'expression_statement') {
          // Split into smaller pieces using line-based chunking
          const lines = node.text.split('\n');
          let start = 0;
          const chunkSize = 100;
          const overlap = 20;
          
          while (start < lines.length) {
            const end = Math.min(lines.length, start + chunkSize);
            const text = lines.slice(start, end).join('\n');
            chunks.push({
              text,
              startLine: startLine + start,
              endLine: startLine + end - 1,
              type: 'block',
              parentName
            });
            if (end === lines.length) break;
            start = end - overlap;
          }
          return;
        }

        chunks.push({
          text: node.text,
          startLine,
          endLine,
          type: this.mapType(node.type),
          parentName,
          name: this.extractIdentifier(node)
        });
        
      } else {
        // For any other node type, keep drilling down into children
        if (node.children) {
          node.children.forEach((child: any) => visit(child, parentName));
        }
      }
    };

    visit(tree.rootNode);
    
    // If we got no chunks (parser issue?), fall back to line-based
    if (chunks.length === 0) {
      return this.lineBasedFallback(content);
    }
    
    return chunks;
  }

  private lineBasedFallback(content: string): Chunk[] {
    const lines = content.split('\n');
    const chunks: Chunk[] = [];
    let start = 0;
    const chunkSize = 120;
    const overlap = 20;

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

  private extractIdentifier(node: any): string {
    const idNode = node.children.find((c: any) => c.type === 'identifier' || c.type === 'type_identifier');
    return idNode ? idNode.text : 'anonymous';
  }

  private mapType(tsType: string): Chunk['type'] {
    if (tsType.includes('class')) return 'class';
    if (tsType.includes('function')) return 'function';
    if (tsType === 'expression_statement') return 'function'; // Route handlers
    return 'global';
  }
}