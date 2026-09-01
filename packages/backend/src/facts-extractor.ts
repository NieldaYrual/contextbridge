export type FileFacts = {
  path: string;
  items: string[]; // each item is a precise, single-fact string
};

const ROUTE_RE = /\brouter\.(get|post|put|delete|patch|options|head)\s*\(\s*['"`]([^'"`]+)['"`]\s*,/g;
const EXPORT_FN_RE = /\bexport\s+function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g;
const EXPORT_CONST_FN_RE = /\bexport\s+const\s+([A-Za-z0-9_]+)\s*=\s*function\s*\(([^)]*)\)/g;
const EXPORT_ARROW_RE = /\bexport\s+const\s+([A-Za-z0-9_]+)\s*=\s*\(([^)]*)\)\s*=>/g;
const IMPORT_RE = /^\s*import\s+.*?from\s+['"`]([^'"`]+)['"`]\s*;?\s*$/gm;

export function extractFileFacts(path: string, content: string): FileFacts {
  const items: string[] = [];

  // 1) Route registrations
  {
    ROUTE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ROUTE_RE.exec(content)) !== null) {
      const method = m[1].toUpperCase();
      const route = m[2];
      items.push(`route: ${method} ${route}`);
    }
  }

  // 2) Exported functions (named)
  {
    EXPORT_FN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXPORT_FN_RE.exec(content)) !== null) {
      const name = m[1];
      const params = m[2].trim();
      items.push(`export: function ${name}(${params})`);
    }
  }

  // 3) Exported functions (const fn)
  {
    EXPORT_CONST_FN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXPORT_CONST_FN_RE.exec(content)) !== null) {
      const name = m[1];
      const params = m[2].trim();
      items.push(`export: const function ${name}(${params})`);
    }
  }

  // 4) Exported arrow functions
  {
    EXPORT_ARROW_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXPORT_ARROW_RE.exec(content)) !== null) {
      const name = m[1];
      const params = m[2].trim();
      items.push(`export: const ${name}(${params}) =>`);
    }
  }

  // 5) Top-level imports (optional, short signal)
  {
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = IMPORT_RE.exec(content)) !== null) {
      const spec = m[1];
      if (!seen.has(spec)) {
        seen.add(spec);
        // keep concise; don’t flood facts
        if (items.length < 50) items.push(`import: ${spec}`);
      }
    }
  }

  return { path, items };
}
