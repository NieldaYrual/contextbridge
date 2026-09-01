// packages/backend/src/utils/file-type-detector.ts
import { fileTypeFromBuffer } from 'file-type';
import mime from 'mime-types';

export type FileTypeResult = {
  file_type: 'code' | 'document' | 'data' | 'text' | 'image' | 'video' | 'audio' | 'archive';
  file_extension: string;
  language: string | null;
  mime_type: string | null;
  is_binary: boolean;
};

/**
 * Robustly detect file type using multiple signals:
 * 1. Binary magic numbers (for images, PDFs, etc.)
 * 2. Shebang detection (for scripts)
 * 3. Syntax patterns (for code files)
 * 4. Extension fallback
 */
export async function detectFileType(
  fileName: string,
  content: string | Buffer
): Promise<FileTypeResult> {
  // Try binary detection first (images, PDFs, etc.)
  const binaryResult = await detectBinaryType(content);
  if (binaryResult) return binaryResult;

  // For text content, use content-based detection
  if (typeof content === 'string') {
    const textResult = detectTextType(fileName, content);
    if (textResult) return textResult;
  }

  // Fallback to extension-based detection
  return detectFromExtension(fileName);
}

/**
 * Detect binary files (images, videos, PDFs) using magic numbers
 */
async function detectBinaryType(content: string | Buffer): Promise<FileTypeResult | null> {
  try {
    const buffer = Buffer.isBuffer(content) 
      ? content 
      : isBase64(content)
        ? Buffer.from(content, 'base64')
        : null;

    if (!buffer) return null;

    const detected = await fileTypeFromBuffer(buffer);
    if (!detected) return null;

    return {
      file_type: categorizeByMime(detected.mime),
      file_extension: detected.ext,
      language: null,
      mime_type: detected.mime,
      is_binary: true
    };
  } catch {
    return null;
  }
}

/**
 * Detect text-based files (code, markdown, etc.) using content analysis
 */
function detectTextType(fileName: string, content: string): FileTypeResult | null {
  // Check shebang
  const shebangResult = detectFromShebang(content);
  if (shebangResult) return shebangResult;

  // Check syntax patterns
  const syntaxResult = detectFromSyntax(content, fileName);
  if (syntaxResult) return syntaxResult;

  return null;
}

/**
 * Detect from shebang line (#!)
 */
function detectFromShebang(content: string): FileTypeResult | null {
  if (!content.startsWith('#!')) return null;

  const shebangLine = content.split('\n')[0].toLowerCase();

  const shebangMap: Record<string, { language: string; ext: string }> = {
    'python': { language: 'python', ext: 'py' },
    'node': { language: 'javascript', ext: 'js' },
    'bash': { language: 'bash', ext: 'sh' },
    'sh': { language: 'bash', ext: 'sh' },
    'ruby': { language: 'ruby', ext: 'rb' },
    'perl': { language: 'perl', ext: 'pl' }
  };

  for (const [key, value] of Object.entries(shebangMap)) {
    if (shebangLine.includes(key)) {
      return {
        file_type: 'code',
        file_extension: value.ext,
        language: value.language,
        mime_type: `text/x-${value.language}`,
        is_binary: false
      };
    }
  }

  return null;
}

/**
 * Detect from syntax patterns in content
 */
function detectFromSyntax(content: string, fileName: string): FileTypeResult | null {
  // Markdown detection
  if (hasMarkdownSyntax(content)) {
    return {
      file_type: 'document',
      file_extension: 'md',
      language: 'markdown',
      mime_type: 'text/markdown',
      is_binary: false
    };
  }

  // JavaScript/TypeScript
  if (hasJavaScriptSyntax(content)) {
    const isTypeScript = fileName.endsWith('.ts') || fileName.endsWith('.tsx') || 
                        content.includes(': string') || content.includes(': number');
    return {
      file_type: 'code',
      file_extension: isTypeScript ? 'ts' : 'js',
      language: isTypeScript ? 'typescript' : 'javascript',
      mime_type: isTypeScript ? 'text/typescript' : 'text/javascript',
      is_binary: false
    };
  }

  // Python
  if (hasPythonSyntax(content)) {
    return {
      file_type: 'code',
      file_extension: 'py',
      language: 'python',
      mime_type: 'text/x-python',
      is_binary: false
    };
  }

  // JSON
  if (isValidJSON(content)) {
    return {
      file_type: 'data',
      file_extension: 'json',
      language: 'json',
      mime_type: 'application/json',
      is_binary: false
    };
  }

  return null;
}

/**
 * Fallback: detect from file extension
 */
function detectFromExtension(fileName: string): FileTypeResult {
  const ext = fileName.split('.').pop()?.toLowerCase() || 'txt';
  
  const codeExtensions: Record<string, string> = {
    'js': 'javascript', 'ts': 'typescript', 'jsx': 'javascript', 'tsx': 'typescript',
    'py': 'python', 'java': 'java', 'cpp': 'cpp', 'c': 'c', 'cs': 'csharp',
    'go': 'go', 'rs': 'rust', 'rb': 'ruby', 'php': 'php', 'swift': 'swift',
    'kt': 'kotlin', 'scala': 'scala', 'sql': 'sql', 'sh': 'bash', 'bat': 'batch'
  };

  const docExtensions = ['md', 'txt', 'pdf', 'docx', 'doc', 'rtf'];
  const dataExtensions = ['json', 'xml', 'csv', 'yaml', 'yml', 'toml'];
  const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];

  if (codeExtensions[ext]) {
    return {
      file_type: 'code',
      file_extension: ext,
      language: codeExtensions[ext],
      mime_type: mime.lookup(ext) || null,
      is_binary: false
    };
  }

  if (docExtensions.includes(ext)) {
    return {
      file_type: 'document',
      file_extension: ext,
      language: ext === 'md' ? 'markdown' : null,
      mime_type: mime.lookup(ext) || null,
      is_binary: ['pdf', 'docx', 'doc'].includes(ext)
    };
  }

  if (dataExtensions.includes(ext)) {
    return {
      file_type: 'data',
      file_extension: ext,
      language: ext,
      mime_type: mime.lookup(ext) || null,
      is_binary: false
    };
  }

  if (imageExtensions.includes(ext)) {
    return {
      file_type: 'image',
      file_extension: ext,
      language: null,
      mime_type: mime.lookup(ext) || null,
      is_binary: true
    };
  }

  // Default to text
  return {
    file_type: 'text',
    file_extension: ext,
    language: null,
    mime_type: 'text/plain',
    is_binary: false
  };
}

// Helper functions

function categorizeByMime(mimeType: string): FileTypeResult['file_type'] {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.includes('zip') || mimeType.includes('archive')) return 'archive';
  if (mimeType === 'application/pdf') return 'document';
  if (mimeType.startsWith('text/')) return 'text';
  return 'data';
}

function isBase64(str: string): boolean {
  if (typeof str !== 'string' || str.length < 4) return false;
  try {
    const decoded = Buffer.from(str, 'base64').toString('base64');
    return decoded === str;
  } catch {
    return false;
  }
}

function hasMarkdownSyntax(content: string): boolean {
  const lines = content.split('\n').slice(0, 20); // Check first 20 lines
  const mdPatterns = [
    /^#+\s/,           // Headers
    /^\*\*.*\*\*/,     // Bold
    /^\*.*\*/,         // Italic
    /^\[.*\]\(.*\)/,   // Links
    /^```/,            // Code blocks
    /^[-*+]\s/         // Lists
  ];
  return lines.some(line => mdPatterns.some(pattern => pattern.test(line)));
}

function hasJavaScriptSyntax(content: string): boolean {
  const jsPatterns = [
    /\b(const|let|var|function|class|import|export|async|await)\s/,
    /=>\s*{/,                    // Arrow functions
    /\bexport\s+(default|const|function|class)/,
    /\bimport\s+.*\s+from\s+['"`]/
  ];
  return jsPatterns.some(pattern => pattern.test(content));
}

function hasPythonSyntax(content: string): boolean {
  const pyPatterns = [
    /\bdef\s+\w+\s*\(/,         // Function definitions
    /\bclass\s+\w+/,            // Class definitions
    /\bimport\s+\w+/,           // Import statements
    /\bfrom\s+\w+\s+import/,    // From-import statements
    /:\s*$/m,                    // Colon at end of line (if/for/while)
  ];
  return pyPatterns.some(pattern => pattern.test(content));
}

function isValidJSON(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}