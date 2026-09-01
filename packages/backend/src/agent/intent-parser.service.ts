// packages/backend/src/agent/intent-parser.service.ts
import type { ParsedOperators } from '../agent/agent-dsl.types';

const OP_PATTERNS: Record<keyof ParsedOperators, RegExp> = {
  file: /\bfile:([^\s]+)/gi,
  path: /\bpath:([^\s]+)/gi,
  func: /\bfunc:([^\s]+)/gi,
  class: /\bclass:([^\s]+)/gi,
  type:  /\btype:(code|file|message|entity|document|data|text)\b/gi,
  since: /\b(?:since|after|from):([^\s]+)/gi,
  entity: /\bentity:([^\s]+)\b/gi,
  raw: /$^/gi // unused placeholder
};

export function parseOperators(input: string): { cleaned: string; ops: ParsedOperators } {
  const ops: ParsedOperators = { raw: {} };
  let cleaned = input;

  // Typed setter to avoid @ts-expect-error
  function setList<K extends keyof ParsedOperators>(key: K, values: string[]) {
    if (!values.length) return;
    if (key === 'type') {
      // 'type' expects a union of specific string literals
      (ops.type as Array<'code'|'file'|'message'|'entity'> | undefined) =
        values as Array<'code'|'file'|'message'|'entity'>;
    } else {
      // file, path, func, class, since, entity are string arrays
      (ops[key] as unknown as string[] | undefined) = values;
    }
    // keep a raw copy for any consumer
    (ops.raw as Record<string, string[]>)[key as string] = values;
  }

  function pullAll(re: RegExp): string[] {
    const acc: string[] = [];
    cleaned = cleaned.replace(re, (_m, g1) => {
      acc.push(String(g1));
      return '';
    });
    return acc;
  }

  // Collect each operator
  setList('file',   pullAll(OP_PATTERNS.file));
  setList('path',   pullAll(OP_PATTERNS.path));
  setList('func',   pullAll(OP_PATTERNS.func));
  setList('class',  pullAll(OP_PATTERNS.class));
  setList('since',  pullAll(OP_PATTERNS.since));
  setList('entity', pullAll(OP_PATTERNS.entity));

  // type: special handling to normalize union literals
  const typeMatches: string[] = [];
  cleaned = cleaned.replace(OP_PATTERNS.type, (_m, g1) => {
    // OP_PATTERNS.type = /\btype:(code|file|message|entity|document|data|text)\b/gi
    typeMatches.push(String(g1).toLowerCase());
    return '';
  });
  setList('type', typeMatches);

  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return { cleaned, ops };
}

/**
 * Split into explicit, minimal sub-questions.
 * Rules:
 *  - If the prompt contains a numbered list or bullets, use those items.
 *  - Else split on line breaks first; fall back to sentence terminals for short inputs.
 *  - Strip leading numerals/bullets and whitespace.
 */
export function splitSubquestions(text: string): string[] {
  const items: string[] = [];

  // 1) Enumerated lists like "1. ..." or "1) ..."
  const enumMatches = text.match(/(^|\n)\s*(\d+[\.\)])\s+.+/g);
  if (enumMatches && enumMatches.length >= 2) {
    for (const m of enumMatches) {
      const cleaned = m.replace(/(^|\n)\s*\d+[\.\)]\s+/, '').trim();
      if (cleaned) items.push(cleaned);
    }
    return dedupe(items);
  }

  // 2) Bulleted lists "-", "*", "•"
  const bulletMatches = text.match(/(^|\n)\s*[-*•]\s+.+/g);
  if (bulletMatches && bulletMatches.length >= 2) {
    for (const m of bulletMatches) {
      const cleaned = m.replace(/(^|\n)\s*[-*•]\s+/, '').trim();
      if (cleaned) items.push(cleaned);
    }
    return dedupe(items);
  }

  // 3) Explicit newlines
  if (text.includes('\n')) {
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (s) items.push(s);
    }
    return dedupe(items);
  }

  // 4) Light sentence split as a fallback
  const sentences = text.split(/(?<=[\.\?\!])\s+(?=[A-Z])/).map(s => s.trim()).filter(Boolean);
  if (sentences.length >= 2) return dedupe(sentences);

  // 5) Otherwise single ask
  return [text.trim()];
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const k = s.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out;
}
