// packages/backend/src/services/secret-guard.service.ts
// Two-layer protection against ingesting secrets into the Codex pipeline:
//   Layer 1: filename denylist (whole-file rejection)
//   Layer 2: content scanning (secretlint preset + custom regex rules), line-level redaction
//
// Used by codex.routes.ts (VS Code sync) and codex-ingestion.routes.ts (CLI sync).

import { lintSource } from '@secretlint/core';
import { creator as recommendPreset } from '@secretlint/secretlint-rule-preset-recommend';
import { CUSTOM_RULES, type CustomSecretRule } from './custom-secret-rules';

// ────────────────────────────────────────────────────────────────────
// Layer 1: filename denylist
// ────────────────────────────────────────────────────────────────────

const FILENAME_DENY_PATTERNS: RegExp[] = [
  // ... (keep your existing patterns — unchanged) ...
  /(^|\/)\.env$/i,
  /(^|\/)\.env\.[^/]+$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.keystore$/i,
  /\.jks$/i,
  /(^|\/)id_rsa(\.[^/]*)?$/i,
  /(^|\/)id_ed25519(\.[^/]*)?$/i,
  /(^|\/)id_dsa(\.[^/]*)?$/i,
  /(^|\/)id_ecdsa(\.[^/]*)?$/i,
  /(^|\/)secrets\//i,
  /(^|\/)secret\//i,
  /(^|\/)credentials\.(json|ya?ml)$/i,
  /(^|\/)aws-credentials$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)service-account[^/]*\.json$/i,
  /(^|\/)firebase-adminsdk[^/]*\.json$/i,
  /\.tfstate$/i,
  /\.tfstate\.backup$/i,
  /(^|\/)terraform\.tfvars$/i,
  /(^|\/)docker-compose\.override\.ya?ml$/i,
  /(^|\/)\.vault-token$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.npmrc$/i,
  /\.kdbx$/i,
  /\.asc$/i,
];

export function isFilenameDenied(filePath: string): {
  denied: boolean;
  matchedPattern?: string;
} {
  const normalized = filePath.replace(/\\/g, '/');
  for (const pattern of FILENAME_DENY_PATTERNS) {
    if (pattern.test(normalized)) {
      return { denied: true, matchedPattern: pattern.source };
    }
  }
  return { denied: false };
}

// ────────────────────────────────────────────────────────────────────
// Layer 2: secretlint + custom-regex content scan with line-level redaction
// ────────────────────────────────────────────────────────────────────

export interface ScanVerdict {
  status: 'clean' | 'redacted';
  redactedContent: string;
  findings: Array<{
    ruleId: string;
    line: number;
    message: string;
  }>;
}

const SECRETLINT_CONFIG = {
  rules: [
    {
      id: '@secretlint/secretlint-rule-preset-recommend',
      rule: recommendPreset,
    },
  ],
};

/**
 * Run CUSTOM_RULES against content, returning line numbers (1-indexed) and
 * the rule ID that fired on each matching line.
 */
function scanWithCustomRules(content: string): Map<number, string> {
  const lineHits = new Map<number, string>();
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of CUSTOM_RULES) {
      // Important: reset lastIndex because patterns are /g.
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(line)) {
        const lineNum = i + 1; // 1-indexed to match secretlint
        if (!lineHits.has(lineNum)) {
          lineHits.set(lineNum, rule.id);
        }
        break; // one rule per line is enough; move on
      }
    }
  }
  return lineHits;
}

/**
 * Scan file content and redact any lines containing secrets.
 * Combines secretlint's built-in rules (preset-recommend) with our
 * custom regex rules (CUSTOM_RULES) for providers secretlint doesn't cover.
 */
export async function scanAndRedact(
  filePath: string,
  content: string,
): Promise<ScanVerdict> {
  // ── Secretlint scan ───────────────────────────────────────────────
  const secretlintResult = await lintSource({
    source: {
      filePath,
      content,
      contentType: 'text',
    },
    options: {
      config: SECRETLINT_CONFIG,
    },
  });

  const secretlintMessages = secretlintResult.messages ?? [];

  // ── Custom regex scan ─────────────────────────────────────────────
  const customLineHits = scanWithCustomRules(content);

  // Short-circuit: neither layer found anything.
  if (secretlintMessages.length === 0 && customLineHits.size === 0) {
    return { status: 'clean', redactedContent: content, findings: [] };
  }

  // ── Merge: line -> ruleId (first-win, deterministic) ─────────────
  const linesToRedact = new Map<number, string>();

  for (const msg of secretlintMessages) {
    const lineNum = msg.loc?.start?.line;
    if (typeof lineNum === 'number' && !linesToRedact.has(lineNum)) {
      linesToRedact.set(lineNum, msg.ruleId ?? 'unknown');
    }
  }
  for (const [lineNum, ruleId] of customLineHits.entries()) {
    if (!linesToRedact.has(lineNum)) {
      linesToRedact.set(lineNum, ruleId);
    }
  }

  // ── Redact ────────────────────────────────────────────────────────
  const lines = content.split('\n');
  for (const [lineNum, ruleId] of linesToRedact.entries()) {
    const idx = lineNum - 1;
    if (idx >= 0 && idx < lines.length) {
      lines[idx] = `[REDACTED: secret detected by ${ruleId}]`;
    }
  }

  // ── Build findings ────────────────────────────────────────────────
  const findings: ScanVerdict['findings'] = [];

  for (const msg of secretlintMessages) {
    findings.push({
      ruleId: msg.ruleId ?? 'unknown',
      line: msg.loc?.start?.line ?? 0,
      message: msg.message ?? '',
    });
  }
  for (const [lineNum, ruleId] of customLineHits.entries()) {
    // Skip if secretlint already reported something on this line.
    const alreadyReported = secretlintMessages.some(
      (m) => m.loc?.start?.line === lineNum,
    );
    if (alreadyReported) continue;
    const rule = CUSTOM_RULES.find((r) => r.id === ruleId);
    findings.push({
      ruleId,
      line: lineNum,
      message: rule?.description ?? 'secret detected',
    });
  }

  return {
    status: 'redacted',
    redactedContent: lines.join('\n'),
    findings,
  };
}