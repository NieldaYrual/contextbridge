import { Chunk, ChunkingStrategy } from '../types.js';

export class PythonStrategy implements ChunkingStrategy {
  private readonly TARGET_NODES = new Set([
    'function_definition',
    'class_definition',
    'decorated_definition' // Handles @decorators wrapping functions/classes
  ]);

  // Recursively split if larger than this
  private readonly MAX_CHUNK_LINES = 250; 

  chunk(content: string, parser: any): Chunk[] {
    const tree = parser.parse(content);
    const chunks: Chunk[] = [];
    
    const visit = (node: any, parentName?: string) => {
      if (this.TARGET_NODES.has(node.type)) {
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const length = endLine - startLine;
        const currentName = this.extractIdentifier(node);

        // RECURSIVE SPLITTING: If it's a huge class, drill down immediately
        if (length > this.MAX_CHUNK_LINES && node.type === 'class_definition') {
            // Don't add the class itself; add its methods instead
            node.children.forEach((child: any) => {
                if (child.type === 'block') { // Python code is inside a 'block' node
                    child.children.forEach((grandchild: any) => {
                        visit(grandchild, currentName); // Visit methods with class name as parent
                    });
                }
            });
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
        // Continue traversing children (e.g., inside 'module', 'if_statement', etc.)
        if (node.children) {
            node.children.forEach((child: any) => visit(child, parentName));
        }
      }
    };

    visit(tree.rootNode);
    return chunks;
  }

  private extractIdentifier(node: any): string {
      // Python definitions usually have a child node of type 'identifier'
      const idNode = node.children.find((c: any) => c.type === 'identifier');
      return idNode ? idNode.text : 'anonymous';
  }

  private mapType(pyType: string): Chunk['type'] {
      if (pyType.includes('class')) return 'class';
      return 'function';
  }
}