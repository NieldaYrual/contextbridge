// packages/backend/src/services/github-auth.service.ts
// Helpers for authenticating as the GitHub App and as a specific installation.
// Uses jsonwebtoken (already a dependency) — no @octokit packages required.

import jwt from 'jsonwebtoken';

// Decode the base64-encoded private key from env. We base64-encode it because
// PEM newlines do not survive cleanly through Lightsail's environment-var UI.
function getPrivateKeyPem(): string {
  const b64 = process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
  if (!b64) {
    throw new Error('GITHUB_APP_PRIVATE_KEY_BASE64 is not set');
  }
  return Buffer.from(b64, 'base64').toString('utf8');
}

function getAppId(): string {
  const id = process.env.GITHUB_APP_ID;
  if (!id) {
    throw new Error('GITHUB_APP_ID is not set');
  }
  return id;
}

// Generate a short-lived JWT signed by the App's private key. Used to call
// /app/* endpoints (e.g., to mint installation access tokens).
// Per GitHub docs, max validity is 10 minutes; we use ~9 minutes to leave slack.
export function generateAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,        // backdate by 60s to tolerate clock skew
    exp: now + 9 * 60,    // 9-minute lifetime
    iss: getAppId(),      // App ID is the issuer
  };
  return jwt.sign(payload, getPrivateKeyPem(), { algorithm: 'RS256' });
}

// Tiny in-memory cache so we don't hit /app/installations/:id/access_tokens
// on every request. GitHub's install tokens are valid for 1 hour; we refresh
// at 50 minutes to be safe.
type CachedToken = { token: string; expiresAt: number };
const tokenCache = new Map<number, CachedToken>();

export async function getInstallationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const appJwt = generateAppJwt();
  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${appJwt}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ContextBridge-Sync',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub installation token request failed: ${res.status} ${body}`);
  }
  const data = await res.json() as { token: string; expires_at: string };
  const expiresAt = new Date(data.expires_at).getTime();
  tokenCache.set(installationId, { token: data.token, expiresAt });
  return data.token;
}

// Convenience: fetch an installation's metadata using the App JWT.
// Used by the setup-callback to confirm the install exists and read
// account_login / account_type / account_id before we write the row.
export async function fetchInstallation(installationId: number): Promise<{
  id: number;
  account: { login: string; id: number; type: 'User' | 'Organization'; avatar_url: string };
}> {
  const appJwt = generateAppJwt();
  const url = `https://api.github.com/app/installations/${installationId}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${appJwt}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ContextBridge-Sync',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub fetchInstallation failed: ${res.status} ${body}`);
  }
  return res.json() as any;
}