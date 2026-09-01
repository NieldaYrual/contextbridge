export function extToLang(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'ts': return 'ts';
    case 'tsx': return 'tsx';
    case 'js': case 'mjs': case 'cjs': return 'javascript';
    case 'json': return 'json';
    case 'py': return 'python';
    case 'go': return 'go';
    case 'rs': return 'rust';
    case 'java': return 'java';
    case 'cs': return 'csharp';
    case 'php': return 'php';
    case 'rb': return 'ruby';
    case 'kt': return 'kotlin';
    case 'c': return 'c';
    case 'cc': case 'cpp': case 'cxx': return 'cpp';
    case 'h': case 'hpp': return 'cpp';
    case 'yaml': case 'yml': return 'yaml';
    case 'html': return 'html';
    case 'css': return 'css';
    case 'sql': return 'sql';
    default: return '';
  }
}

export function fencedCode(path: string, content: string): string {
  const ext = path.split('.').pop() || '';
  const lang = extToLang(ext);
  return lang ? `\`\`\`${lang}\n${content}\n\`\`\`\n` : `\`\`\`\n${content}\n\`\`\`\n`;
}

// --- Token estimator (rough, fast) ---
export function estimateTokens(text: string): number {
  // very close for English/code; aligns with your existing rough calc elsewhere
  return Math.ceil((text?.length ?? 0) / 4);
}

export type CompactionMap = {
  removedLines: number[];
  preservedLines: number[];
};

export function compactCodeWithMap(path: string, content: string): { compacted: string; map: CompactionMap } {
  // Strategy:
  //  - remove blank lines
  //  - remove obvious single-line comments
  //  - remove obvious block comments (/* */ or /** */)
  // Works best for JS/TS/C/CSS; harmless for others (still drops blanks).
  const lines = content.split(/\r?\n/);
  const preserved: number[] = [];
  const removed: number[] = [];

  const ext = (path.split('.').pop() || '').toLowerCase();
  const supportsSlashComments = ['ts','tsx','js','jsx','mjs','cjs','java','cs','go','c','cc','cpp','cxx','h','hpp','rs','kt','swift'].includes(ext);
  const supportsBlockComments = supportsSlashComments || ['css','scss','less'].includes(ext);

  let inBlock = false;
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (supportsBlockComments) {
      // crude block comment stripper
      if (!inBlock) {
        const openIdx = line.indexOf('/*');
        const closeIdx = line.indexOf('*/');
        if (openIdx >= 0 && (closeIdx < 0 || closeIdx < openIdx)) {
          inBlock = true;
          // keep anything before '/*' if non-empty
          const keep = line.slice(0, openIdx).trim();
          if (keep.length > 0) {
            out.push(line.slice(0, openIdx));
            preserved.push(i + 1);
          } else {
            removed.push(i + 1);
          }
          continue;
        }
      }

      if (inBlock) {
        const closeIdx = line.indexOf('*/');
        removed.push(i + 1);
        if (closeIdx >= 0) {
          inBlock = false;
        }
        continue;
      }
    }

    let trimmed = line.trim();
    if (supportsSlashComments) {
      // remove trailing // comments
      const slashIdx = trimmed.indexOf('//');
      if (slashIdx === 0) {
        removed.push(i + 1);
        continue;
      }
      if (slashIdx > 0) trimmed = trimmed.slice(0, slashIdx).trim();
    }

    if (trimmed.length === 0) {
      removed.push(i + 1);
      continue;
    }

    // preserve full original line for line-number stability (not the trimmed one)
    out.push(line);
    preserved.push(i + 1);
  }

  const compacted = out.join('\n');
  return { compacted, map: { removedLines: removed, preservedLines: preserved } };
}
