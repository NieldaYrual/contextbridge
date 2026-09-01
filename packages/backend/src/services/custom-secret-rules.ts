// packages/backend/src/services/custom-secret-rules.ts
//
// Custom secret-detection rules layered on top of secretlint's built-in
// preset-recommend. Each entry here becomes a regex-based secretlint rule
// scoped to a specific provider.
//
// Currently covered by THIS file:
//   - Supabase (sb_secret_*, sb_publishable_*)
//   - OpenAI (sk-proj-*, sk-*)
//   - Anthropic (sk-ant-*)
//   - Stripe (sk_live_*, sk_test_*, rk_*, whsec_*)
//   - AWS (access key IDs, secret access keys, ARN account IDs)
//   - JWT (three-segment base64, catches Supabase JWTs + most auth tokens)
//   - Grok (xAI API keys)
//   - Twilio (AC + SK account/API SIDs)
//
// Currently covered by secretlint's preset-recommend (do NOT duplicate here):
//   - GitHub (ghp_*, gho_*, ghs_*, ghu_*, ghr_*)
//   - GCP service account keys
//   - Azure access tokens
//   - SendGrid API keys
//   - Slack tokens (xoxp, xoxb, xoxa, xoxr)
//   - Shopify tokens (shpat, shpca, shpss, shppa)
//   - npm tokens
//   - Basic auth URLs (user:pass@host)
//   - PEM private key blocks
//
// KNOWN GAPS (PRs welcome — add providers in order of security impact):
//   - TODO: Dropbox (sl.*)
//   - TODO: Box OAuth tokens
//   - TODO: Postmark API tokens
//   - TODO: Mailgun private API keys (key-*)
//   - TODO: PayPal client IDs/secrets
//   - TODO: Cloudflare API tokens (v1.0-*)
//   - TODO: Datadog API/APP keys
//   - TODO: New Relic license keys (NRAK-*, NRII-*)
//   - TODO: Google Maps API keys (AIza*)
//   - TODO: Mapbox tokens (pk.eyJ*, sk.eyJ*)
//   - TODO: Segment write keys
//   - TODO: Intercom access tokens
//   - TODO: Generic database URLs (postgres://user:pw@, mysql://user:pw@)
//   - TODO: SSH key fingerprints (not the key itself — secretlint covers PEM)
//
// When adding a rule:
//   1. Add the entry to CUSTOM_RULES below
//   2. Update the "Currently covered by THIS file" list above
//   3. Remove the provider from the KNOWN GAPS list
//   4. Add a realistic (fake) test fixture to the test suite
//
// ---------------------------------------------------------------------

export interface CustomSecretRule {
  /** Human-readable identifier used in log messages (e.g. "supabase-secret"). */
  id: string;
  /** Short description shown in findings (e.g. "Supabase service role key"). */
  description: string;
  /** Regex to match the secret. Use anchored patterns where possible. */
  pattern: RegExp;
}

export const CUSTOM_RULES: CustomSecretRule[] = [
  // ─── Supabase ─────────────────────────────────────────────────────
  {
    id: 'supabase-secret-key',
    description: 'Supabase service role / secret key',
    pattern: /sb_secret_[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'supabase-publishable-key',
    description: 'Supabase publishable (anon) key',
    pattern: /sb_publishable_[A-Za-z0-9_-]{20,}/g,
  },

  // ─── OpenAI ───────────────────────────────────────────────────────
  // sk-proj-... (project keys) and sk-... (legacy keys)
  {
    id: 'openai-project-key',
    description: 'OpenAI project API key',
    pattern: /sk-proj-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'openai-legacy-key',
    description: 'OpenAI legacy API key',
    // Negative lookbehind to avoid overlapping with sk-proj-, sk-ant-, sk_live_
    pattern: /(?<![A-Za-z0-9_-])sk-(?!proj-|ant-)[A-Za-z0-9]{20,}/g,
  },

  // ─── Anthropic ────────────────────────────────────────────────────
  {
    id: 'anthropic-api-key',
    description: 'Anthropic API key',
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
  },

  // ─── Stripe ───────────────────────────────────────────────────────
  {
    id: 'stripe-secret-key',
    description: 'Stripe secret key (live or test)',
    pattern: /sk_(?:live|test)_[A-Za-z0-9]{20,}/g,
  },
  {
    id: 'stripe-restricted-key',
    description: 'Stripe restricted key',
    pattern: /rk_(?:live|test)_[A-Za-z0-9]{20,}/g,
  },
  {
    id: 'stripe-webhook-secret',
    description: 'Stripe webhook signing secret',
    pattern: /whsec_[A-Za-z0-9]{20,}/g,
  },

  // ─── AWS ──────────────────────────────────────────────────────────
  // Tighter than secretlint's default: detect a standalone access key ID
  // even without surrounding context (the secretlint built-in is context-dependent).
  {
    id: 'aws-access-key-id',
    description: 'AWS access key ID',
    // AKIA / ASIA / AGPA / AIDA / ANPA / ANVA / AROA / ABIA / ACCA prefixes
    pattern: /(?<![A-Z0-9])(?:AKIA|ASIA|AGPA|AIDA|ANPA|ANVA|AROA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Z0-9])/g,
  },
  {
    id: 'aws-secret-access-key',
    description: 'AWS secret access key (context-based detection)',
    // 40-char base64 following "aws_secret_access_key" or "AWS_SECRET_ACCESS_KEY"
    pattern: /(?:aws[_-]?secret[_-]?access[_-]?key|AWS_SECRET_ACCESS_KEY)[\s:=]+['"]?[A-Za-z0-9/+=]{40}['"]?/g,
  },

  // ─── Generic JWT ──────────────────────────────────────────────────
  // Catches Supabase anon/service JWTs, Firebase tokens, Auth0 tokens, etc.
  // Three base64-url segments joined by dots, each non-trivially long.
  {
    id: 'generic-jwt',
    description: 'JWT token',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },

  // ─── Grok / xAI ───────────────────────────────────────────────────
  {
    id: 'grok-api-key',
    description: 'Grok (xAI) API key',
    pattern: /xai-[A-Za-z0-9]{40,}/g,
  },

  // ─── Twilio ───────────────────────────────────────────────────────
  {
    id: 'twilio-account-sid',
    description: 'Twilio account SID',
    pattern: /(?<![A-Za-z0-9])AC[a-f0-9]{32}(?![A-Za-z0-9])/g,
  },
  {
    id: 'twilio-api-sid',
    description: 'Twilio API key SID',
    pattern: /(?<![A-Za-z0-9])SK[a-f0-9]{32}(?![A-Za-z0-9])/g,
  },
  // AWS ARNs leak account ID (12 digits). Not a credential, but reveals
  // infrastructure topology. Match only inside full ARN format to avoid
  // false positives on bare 12-digit numbers (timestamps, IDs, etc.).
  {
    id: 'aws-account-id-arn',
    description: 'AWS ARN containing account ID',
    pattern: /arn:aws[\w-]*:[\w-]*:[\w-]*:\d{12}:[^\s'"]+/g,
  },
];