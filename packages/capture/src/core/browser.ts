import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = process.env.PLAYWRIGHT_PROFILE_ROOT || '.cb-profiles';

export async function getContextFor(
    provider: string,
    ownerLabel?: string | null,
    headless?: boolean
    ): Promise<BrowserContext> {
    const bucket = ownerLabel?.trim()
        ? ownerLabel.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
        : 'default';

    const userDataDir = path.resolve(ROOT, provider, bucket);
    fs.mkdirSync(userDataDir, { recursive: true });

    const isWindows = process.platform === 'win32';

    const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: process.env.HEADLESS === 'true' || headless === true,

    // include channel ONLY when we actually want it
    ...(isWindows ? { channel: 'chrome' as const } : {}),

    viewport: { width: 1366, height: 850 },
    userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    ignoreHTTPSErrors: true,
    });


    // Higher defaults so Cloudflare pages don’t trip “30s timeout”
    ctx.setDefaultNavigationTimeout(120_000);
    ctx.setDefaultTimeout(120_000);

  return ctx;
}
