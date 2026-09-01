// packages/backend/src/services/codex-utils.ts
// Shared helpers for code/file ingestion — used by both Codex (VS Code) and GitHub sync.

import crypto from 'crypto';

export function chunkText(text: string, maxLines?: number, overlap = 25): { text: string; startLine: number; endLine: number }[] {
  const lines = text.split('\n');
  const effectiveMax = maxLines ?? Math.min(200, Math.max(120, Math.floor(lines.length / 20)));
  const chunks = [];
  for (let i = 0; i < lines.length; i += (effectiveMax - overlap)) {
    const end = Math.min(i + effectiveMax, lines.length);
    const chunkLines = lines.slice(i, end);
    const meaningfulLines = chunkLines.filter(l => l.trim().length > 0);
    if (meaningfulLines.length < 8) {
      if (end === lines.length) break;
      continue;
    }
    chunks.push({
      text: chunkLines.join('\n'),
      startLine: i + 1,
      endLine: end
    });
    if (end === lines.length) break;
  }
  return chunks;
}

export function detectFileType(filePath: string): { fileType: string; extension: string; language: string } {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  const codeExtensions: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', go: 'go', rs: 'rust', java: 'java', cs: 'csharp',
    php: 'php', rb: 'ruby', kt: 'kotlin', swift: 'swift',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
    sql: 'sql', html: 'html', css: 'css', scss: 'scss', sass: 'sass',
  };

  const docExtensions = ['md', 'txt', 'json', 'yaml', 'yml', 'xml', 'toml', 'ini', 'env'];

  if (codeExtensions[ext]) {
    return { fileType: 'code', extension: ext, language: codeExtensions[ext] };
  } else if (docExtensions.includes(ext)) {
    return { fileType: 'text', extension: ext, language: ext };
  } else {
    return { fileType: 'text', extension: ext || 'unknown', language: ext || 'plaintext' };
  }
}

export function isValidFilePath(path: string): boolean {
  if (!path || path.trim() === '') return false;

  if (path.includes('${')) return false;
  if (path.includes('\\')) return false;
  if (path.includes('=')) return false;

  const validExts = /\.(ts|tsx|js|jsx|py|go|rs|java|cs|php|rb|kt|c|cpp|h|html|css|json|md|txt|sql|yaml|yml)$/i;
  if (!validExts.test(path)) {
    const special = ['Dockerfile', 'Makefile', 'LICENSE', 'README'];
    if (!special.some(s => path.endsWith(s))) return false;
  }

  return true;
}

export function generateContentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 32);
}

export function prepareContentForEmbedding(filePath: string, content: string, fileType: string): string {
  const fileName = filePath.split('/').pop() || filePath;
  let processed = `File: ${filePath}\nFilename: ${fileName}\nType: ${fileType}\n\n`;

  if (fileType === 'code') {
    const lines = content.split('\n');
    const denseLines = lines.filter(line => {
      const l = line.trim();

      if (l.startsWith('import ') || l.startsWith('export * from')) return false;
      if (l.startsWith('export { ') && l.includes(' from ')) return false;
      if (l.startsWith('package ') || l.startsWith('using ')) return false;

      if (l.startsWith('//') && !l.startsWith('///')) return false;
      if (l === '/*' || l === '*/' || l === '*') return false;
      if (l.startsWith('* ') && !l.startsWith('* @')) return false;

      if (l.startsWith('type ') && l.includes('=')) return false;
      if (l.startsWith('interface ') && l.endsWith('{')) return false;
      if (l.startsWith('export type ') || l.startsWith('export interface ')) return false;

      return true;
    });

    processed += denseLines.join('\n').replace(/\n{3,}/g, '\n\n');
  } else {
    processed += content.replace(/\n{3,}/g, '\n\n');
  }

  return processed;
}