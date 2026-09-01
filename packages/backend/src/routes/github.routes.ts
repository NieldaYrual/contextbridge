// packages/backend/src/routes/github.routes.ts
// Express routes for GitHub App webhooks.
// IMPORTANT: This router uses express.raw() so HMAC signatures verify against
// the original request bytes. It MUST be mounted BEFORE app.use(express.json(...))
// in index.ts, otherwise the body will already be parsed and signature checks fail.

import express from 'express';
import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { fetchInstallation, getInstallationToken } from '../services/github-auth.service.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { syncRepoFull, syncPush } from '../services/github-sync.service.js';

// Compare two strings in constant time to avoid timing attacks during HMAC checks.
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Verify GitHub's X-Hub-Signature-256 header against the raw request body.
// Returns true on a valid signature, false otherwise.
function verifyGitHubSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(signatureHeader, expected);
}

export function createGithubRoutes(supabase: SupabaseClient) {
  const router = express.Router();

  // Capture the raw body bytes; GitHub sends application/json but we need the
  // unparsed buffer to verify the HMAC.
  const rawJsonBody = express.raw({ type: 'application/json', limit: '25mb' });

  // POST /api/github/webhook
  router.post('/github/webhook', rawJsonBody, async (req: Request, res: Response) => {
    const deliveryId = req.header('x-github-delivery') || 'unknown';
    const eventType = req.header('x-github-event') || 'unknown';
    const signature = req.header('x-hub-signature-256');

    const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
    if (!secret) {
      console.error('[github] GITHUB_APP_WEBHOOK_SECRET is not set; rejecting webhook');
      return res.status(500).json({ error: 'Server misconfigured' });
    }

    // express.raw() leaves req.body as a Buffer. Anything else means the raw
    // middleware did not run (likely a mounting-order bug).
    if (!Buffer.isBuffer(req.body)) {
      console.error('[github] req.body is not a Buffer — raw middleware did not run');
      return res.status(500).json({ error: 'Server misconfigured (raw body)' });
    }
    const rawBody: Buffer = req.body;

    if (!verifyGitHubSignature(rawBody, signature, secret)) {
      console.warn(`[github] Signature verification failed (delivery=${deliveryId}, event=${eventType})`);
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Parse JSON only after signature verification succeeded.
    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      console.error(`[github] Failed to parse webhook JSON (delivery=${deliveryId}):`, err);
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const action = payload?.action ?? null;
    const installationId = payload?.installation?.id ?? null;
    const repoFullName = payload?.repository?.full_name ?? null;

    console.log(`[github] webhook ok event=${eventType} action=${action} installation=${installationId} repo=${repoFullName} delivery=${deliveryId}`);

    // Stub handlers — full logic lands in Step 8+.
    switch (eventType) {
      case 'ping':
        // GitHub sends this once when the webhook is first configured.
        break;
      case 'installation': {
        const inst = payload?.installation;
        if (!inst?.id) {
          console.warn(`[github] installation event missing installation.id (delivery=${deliveryId})`);
          break;
        }

        if (action === 'created') {
          // Backstop: if the setup redirect already created/updated this row, this is a no-op.
          // If the redirect was missed, we record an orphan with user_id = NULL (claimable later).
          const { data: existing, error: selErr } = await supabase
            .from('cb_github_installations')
            .select('id, user_id')
            .eq('installation_id', inst.id)
            .maybeSingle();

          if (selErr) {
            console.error('[github] installation.created select error:', selErr);
            break;
          }

          if (!existing) {
            const acct = inst.account || {};
            const { error: insErr } = await supabase
              .from('cb_github_installations')
              .insert({
                user_id: null,
                installation_id: inst.id,
                account_login: acct.login || 'unknown',
                account_type: acct.type === 'Organization' ? 'Organization' : 'User',
                account_id: acct.id || 0,
                account_avatar_url: acct.avatar_url || null,
                metadata: { backstop: true, delivery_id: deliveryId },
              });
            if (insErr) {
              console.error('[github] installation.created insert error:', insErr);
            } else {
              console.log(`[github] installation.created backstop wrote orphan row install=${inst.id}`);
            }
          } else {
            console.log(`[github] installation.created already recorded install=${inst.id} (no-op)`);
          }
        } else if (action === 'deleted') {
          const { error: updErr } = await supabase
            .from('cb_github_installations')
            .update({ uninstalled_at: new Date().toISOString() })
            .eq('installation_id', inst.id);
          if (updErr) {
            console.error('[github] installation.deleted update error:', updErr);
          } else {
            console.log(`[github] installation.deleted marked uninstalled install=${inst.id}`);
          }
          // NOTE: F2 cascading delete (removing repos, chunks, sources) is intentionally
          //       NOT done here — that lands in Step 8b/F2 work where it belongs.
        } else {
          // suspend, unsuspend, new_permissions_accepted — log only for now.
          console.log(`[github] installation.${action} install=${inst.id} (no DB change)`);
        }
        break;
      }
      case 'installation_repositories':
        // action: added | removed
        break;
      case 'push': {
        const ref = payload?.ref as string | undefined;
        const headSha = payload?.after as string | undefined;
        const pushRepo = payload?.repository?.full_name as string | undefined;
        const commits = payload?.commits as Array<{ added: string[]; modified: string[]; removed: string[] }> | undefined;

        if (!ref || !headSha || !pushRepo || !commits || !installationId) {
          console.warn(`[github] push event missing required fields (delivery=${deliveryId})`);
          break;
        }

        const branch = ref.replace(/^refs\/heads\//, '');

        syncPush(installationId, pushRepo, branch, headSha, commits).catch((err: any) => {
          console.error(`[github] push sync failed for ${pushRepo}@${branch}:`, err?.message || err);
        });

        console.log(`[github] push sync triggered: ${pushRepo}@${branch} (${commits.length} commits)`);
        break;
      }
      default:
        // Other events arrive only if subscribed; safe to ignore.
        break;
    }

    return res.status(200).json({ status: 'ok', event: eventType, action, deliveryId });
  });

  // GET /api/github/webhook/health — quick liveness check (no auth, no signature)
  router.get('/github/webhook/health', (_req: Request, res: Response) => {
    return res.status(200).json({
      status: 'ok',
      route: '/api/github/webhook',
      method: 'POST',
      secretConfigured: !!process.env.GITHUB_APP_WEBHOOK_SECRET,
    });
  });

  // GET /api/github/install
  // Returns the GitHub App install URL. The install page calls this to know
  // where to redirect the user.
  router.get('/github/install', (_req: Request, res: Response) => {
    const slug = process.env.GITHUB_APP_SLUG;
    if (!slug) {
      console.error('[github] GITHUB_APP_SLUG is not set');
      return res.status(500).json({ error: 'Server misconfigured' });
    }
    return res.status(200).json({
      installUrl: `https://github.com/apps/${slug}/installations/new`,
    });
  });

  // GET /api/github/setup
  // GitHub redirects users here after they complete an install.
  // Required query params: installation_id, setup_action.
  // Requires a logged-in ContextBridge user (so we know whom to link).
  router.post('/github/setup', express.json(), requireAuth, async (req: Request, res: Response) => {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const installationIdRaw = req.body?.installation_id;
    const setupAction = (req.body?.setup_action as string) || 'install';

    if (!installationIdRaw) {
      return res.status(400).json({ error: 'Missing installation_id' });
    }
    const installationId = Number(installationIdRaw);
    if (!Number.isFinite(installationId) || installationId <= 0) {
      return res.status(400).json({ error: 'Invalid installation_id' });
    }

    try {
      // Fetch install details from GitHub (authoritative source for account info).
      const detail = await fetchInstallation(installationId);

      // Use Supabase from the closure that wraps this router. We need the
      // outer-scope `supabase` injected via createGithubRoutes(supabase).
      const { error: upsertErr } = await supabase
        .from('cb_github_installations')
        .upsert({
          user_id: userId,
          installation_id: installationId,
          account_login: detail.account.login,
          account_type: detail.account.type,
          account_id: detail.account.id,
          account_avatar_url: detail.account.avatar_url,
          uninstalled_at: null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'installation_id' });

      if (upsertErr) {
        console.error('[github] setup upsert failed:', upsertErr);
        return res.status(500).json({ error: 'Failed to record installation' });
      }

      console.log(`[github] setup ok user=${userId} install=${installationId} account=${detail.account.login} action=${setupAction}`);

      // Redirect to a success page on the frontend.
      return res.status(200).json({
        status: 'ok',
        installation_id: installationId,
        account_login: detail.account.login,
        account_type: detail.account.type,
        setup_action: setupAction,
      });
    } catch (err: any) {
      console.error('[github] setup exception:', err?.message || err);
      return res.status(500).json({ error: 'Setup failed' });
    }
  });

  // GET /api/github/repos
  // Returns all repos accessible to the user's GitHub installations,
  // cross-referenced with cb_github_repos for sync status.
  router.get('/github/repos', requireAuth, async (req: Request, res: Response) => {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      // 1. Get all active installations for this user
      const { data: installations, error: instErr } = await supabase
        .from('cb_github_installations')
        .select('installation_id, account_login')
        .eq('user_id', userId)
        .is('uninstalled_at', null);

      if (instErr) {
        console.error('[github] repos: installation query error:', instErr);
        return res.status(500).json({ error: 'Failed to query installations' });
      }

      if (!installations || installations.length === 0) {
        return res.status(200).json({ repos: [] });
      }

      // 2. Fetch repos from GitHub API for each installation
      const allRepos: any[] = [];

      for (const inst of installations) {
        try {
          const token = await getInstallationToken(inst.installation_id);
          const ghRes = await fetch('https://api.github.com/installation/repositories?per_page=100', {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'ContextBridge-Sync',
            },
          });

          if (!ghRes.ok) {
            console.warn(`[github] repos: GitHub API error for install=${inst.installation_id}: ${ghRes.status}`);
            continue;
          }

          const ghData = await ghRes.json() as { repositories: any[] };
          for (const repo of ghData.repositories || []) {
            allRepos.push({
              github_repo_id: repo.id,
              full_name: repo.full_name,
              private: repo.private,
              default_branch: repo.default_branch,
              installation_id: inst.installation_id,
              account_login: inst.account_login,
            });
          }
        } catch (err: any) {
          console.warn(`[github] repos: failed to fetch repos for install=${inst.installation_id}:`, err?.message);
          continue;
        }
      }

      // 3. Cross-reference with cb_github_repos for sync status
      if (allRepos.length > 0) {
        const repoIds = allRepos.map(r => r.github_repo_id);
        const { data: syncRows, error: syncErr } = await supabase
          .from('cb_github_repos')
          .select('github_repo_id, last_synced_at')
          .in('github_repo_id', repoIds);

        if (syncErr) {
          console.warn('[github] repos: sync status query error:', syncErr);
        }

        const syncMap = new Map<number, { last_synced_at: string | null }>();
        if (syncRows) {
          for (const row of syncRows) {
            syncMap.set(row.github_repo_id, {
              last_synced_at: row.last_synced_at,
            });
          }
        }

        for (const repo of allRepos) {
          const sync = syncMap.get(repo.github_repo_id);
          repo.sync_enabled = !!sync;
          repo.last_synced_at = sync?.last_synced_at ?? null;
        }
      }

      console.log(`[github] repos: returning ${allRepos.length} repos for user=${userId}`);
      return res.status(200).json({ repos: allRepos });

    } catch (err: any) {
      console.error('[github] repos: unexpected error:', err?.message || err);
      return res.status(500).json({ error: 'Failed to fetch repos' });
    }
  });

  // POST /api/github/repos
  // Enables sync for a repo across one or more projects.
  // Creates cb_sources + cb_github_repos rows for each project.
  router.post('/github/repos', express.json(), requireAuth, async (req: Request, res: Response) => {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { github_repo_id, installation_id, project_ids, branch } = req.body;

    // --- Validation ---
    if (!github_repo_id || !installation_id) {
      return res.status(400).json({ error: 'github_repo_id and installation_id are required' });
    }
    if (!Array.isArray(project_ids) || project_ids.length === 0) {
      return res.status(400).json({ error: 'project_ids must be a non-empty array' });
    }

    try {
      // 1. Verify installation belongs to this user (get the UUID row id)
      const { data: instRow, error: instErr } = await supabase
        .from('cb_github_installations')
        .select('id, installation_id, account_login')
        .eq('installation_id', installation_id)
        .eq('user_id', userId)
        .is('uninstalled_at', null)
        .maybeSingle();

      if (instErr) {
        console.error('[github] enable-repo: installation query error:', instErr);
        return res.status(500).json({ error: 'Failed to verify installation' });
      }
      if (!instRow) {
        return res.status(403).json({ error: 'Installation not found or not owned by you' });
      }

      // 2. Verify repo is accessible via GitHub API
      const token = await getInstallationToken(instRow.installation_id);
      const ghRes = await fetch(`https://api.github.com/repositories/${github_repo_id}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'ContextBridge-Sync',
        },
      });

      if (!ghRes.ok) {
        console.warn(`[github] enable-repo: GitHub API error for repo ${github_repo_id}: ${ghRes.status}`);
        return res.status(404).json({ error: 'Repository not found or not accessible' });
      }

      const ghRepo = await ghRes.json() as {
        id: number;
        full_name: string;
        owner: { login: string };
        name: string;
        default_branch: string;
        private: boolean;
      };

      const selectedBranch = branch || ghRepo.default_branch;

      // 3. Check which projects already have this repo linked (to avoid duplicates)
      const { data: existingRepos, error: existErr } = await supabase
        .from('cb_github_repos')
        .select('source_id, cb_sources:source_id(project_id)')
        .eq('github_repo_id', github_repo_id)
        .eq('installation_id', instRow.id);

      if (existErr) {
        console.warn('[github] enable-repo: existing repos query error:', existErr);
      }

      const existingProjectIds = new Set<string>();
      if (existingRepos) {
        for (const row of existingRepos) {
          const source = row.cb_sources as any;
          if (source?.project_id) {
            existingProjectIds.add(source.project_id);
          }
        }
      }

      // 4. Create cb_sources + cb_github_repos for each new project
      const created: any[] = [];
      const skipped: string[] = [];

      for (const projectId of project_ids) {
        if (existingProjectIds.has(projectId)) {
          skipped.push(projectId);
          continue;
        }

        // 4a. Create cb_sources row
        const { data: source, error: srcErr } = await supabase
          .from('cb_sources')
          .insert({
            project_id: projectId,
            provider: 'github',
            source_kind: 'repo',
            name: `GitHub: ${ghRepo.full_name}`,
            external_id: String(ghRepo.id),
            metadata: {
              full_name: ghRepo.full_name,
              owner: ghRepo.owner.login,
              branch: selectedBranch,
            },
          })
          .select('id')
          .single();

        if (srcErr) {
          console.error(`[github] enable-repo: cb_sources insert error for project=${projectId}:`, srcErr);
          continue;
        }

        // 4b. Create cb_github_repos row
        const { data: repoRow, error: repoErr } = await supabase
          .from('cb_github_repos')
          .insert({
            installation_id: instRow.id,
            source_id: source.id,
            github_repo_id: ghRepo.id,
            owner: ghRepo.owner.login,
            name: ghRepo.name,
            default_branch: ghRepo.default_branch,
            selected_branch: selectedBranch,
            is_private: ghRepo.private,
            metadata: {},
          })
          .select('id, github_repo_id, selected_branch')
          .single();

        if (repoErr) {
          console.error(`[github] enable-repo: cb_github_repos insert error for project=${projectId}:`, repoErr);
          // Clean up the orphaned source
          await supabase.from('cb_sources').delete().eq('id', source.id);
          continue;
        }

        created.push({
          project_id: projectId,
          source_id: source.id,
          repo_id: repoRow.id,
          full_name: ghRepo.full_name,
          selected_branch: selectedBranch,
        });
      }

      console.log(`[github] enable-repo: user=${userId} repo=${ghRepo.full_name} created=${created.length} skipped=${skipped.length}`);

      return res.status(200).json({
        status: 'ok',
        full_name: ghRepo.full_name,
        created,
        skipped,
      });

    } catch (err: any) {
      console.error('[github] enable-repo: unexpected error:', err?.message || err);
      return res.status(500).json({ error: 'Failed to enable repo sync' });
    }
  });

  router.post('/github/repos/:repoId/sync', express.json(), requireAuth, async (req: Request, res: Response) => {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { repoId } = req.params;

    try {
      // Verify this repo belongs to the authenticated user
      const { data: repoRow, error: repoErr } = await supabase
        .from('cb_github_repos')
        .select('id, owner, name, cb_github_installations!inner(user_id)')
        .eq('id', repoId)
        .single();

      if (repoErr || !repoRow) {
        return res.status(404).json({ error: 'Repository not found' });
      }

      const instData = (repoRow as any).cb_github_installations;
      if (instData?.user_id !== userId) {
        return res.status(403).json({ error: 'Repository not owned by you' });
      }

      // Fire-and-forget: respond immediately, sync runs in background
      syncRepoFull(repoId).catch((err: any) => {
        console.error(`[github] Background sync failed for repo=${repoId}:`, err?.message || err);
      });

      console.log(`[github] Sync triggered: repo=${repoId} (${(repoRow as any).owner}/${(repoRow as any).name}) user=${userId}`);

      return res.status(202).json({
        status: 'accepted',
        repo_id: repoId,
        message: 'Sync started. Poll GET /api/github/repos/:repoId/sync-status for progress.',
      });

    } catch (err: any) {
      console.error('[github] sync trigger error:', err?.message || err);
      return res.status(500).json({ error: 'Failed to start sync' });
    }
  });

  router.get('/github/repos/:repoId/sync-status', requireAuth, async (req: Request, res: Response) => {
    const userId = (req.user as any)?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { repoId } = req.params;

    try {
      const { data: repoRow, error: repoErr } = await supabase
        .from('cb_github_repos')
        .select('id, owner, name, last_sync_status, last_synced_at, files_synced_count, sync_files_total, sync_files_done, cb_github_installations!inner(user_id)')
        .eq('id', repoId)
        .single();

      if (repoErr || !repoRow) {
        return res.status(404).json({ error: 'Repository not found' });
      }

      const instData = (repoRow as any).cb_github_installations;
      if (instData?.user_id !== userId) {
        return res.status(403).json({ error: 'Repository not owned by you' });
      }

      return res.status(200).json({
        repo_id: repoId,
        status: (repoRow as any).last_sync_status,
        last_synced_at: (repoRow as any).last_synced_at,
        files_synced_count: (repoRow as any).files_synced_count,
        files_total: (repoRow as any).sync_files_total,
        files_done: (repoRow as any).sync_files_done,
      });

    } catch (err: any) {
      console.error('[github] sync-status error:', err?.message || err);
      return res.status(500).json({ error: 'Failed to fetch sync status' });
    }
  });

  return router;
}