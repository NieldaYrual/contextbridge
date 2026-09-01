// After
export interface Chunk {
  text: string;
  startLine: number;
  endLine: number;
  type: 'function' | 'class' | 'method' | 'global' | 'block';
  parentName?: string;
  name?: string;
}

export interface ChunkingStrategy {
  chunk(content: string, parser: any): Chunk[];
}