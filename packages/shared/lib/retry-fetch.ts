// src/lib/retry-fetch.ts
import { setGlobalDispatcher, Agent } from "undici";

setGlobalDispatcher(
  new Agent({
    // keep connections warm to reduce TLS handshakes on spotty links
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
    connections: 64,
  })
);

type RetryOpts = {
  retries?: number;          // total attempts incl. the first one (default 5)
  baseDelayMs?: number;      // backoff base (default 250ms)
  maxDelayMs?: number;       // cap (default 4000ms)
  timeoutMs?: number;        // per-attempt timeout (default 8000ms)
};

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit = {},
  opts: RetryOpts = {}
): Promise<Response> {
  const retries = opts.retries ?? 5;
  const base = opts.baseDelayMs ?? 250;
  const cap = opts.maxDelayMs ?? 4000;
  const timeoutMs = opts.timeoutMs ?? 8000;

  let lastErr: unknown;

  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(input, { ...init, signal: controller.signal });

      // Retry on transient HTTPs
      if (TRANSIENT_STATUS.has(res.status)) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else {
        clearTimeout(id);
        return res;
      }
    } catch (err: any) {
      // Retry on network errors we often see in bad connectivity
      const code = err?.code || err?.cause?.code;
      const name = err?.name;

      const retryable =
        name === "AbortError" ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "EAI_AGAIN" ||
        code === "ENOTFOUND";

      if (!retryable && attempt === retries - 1) throw err;
      lastErr = err;
    } finally {
      clearTimeout(id);
    }

    // exponential backoff + jitter
    const delay = Math.min(cap, base * 2 ** attempt) * (0.5 + Math.random());
    await new Promise((r) => setTimeout(r, delay));
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
