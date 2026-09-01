// packages/backend/src/services/github-sync.service.ts
// Full-repo sync pipeline for GitHub integration.
// Fetches the file tree from GitHub, runs each file through the same
// ingest pipeline as Codex (secret guard → chunk → embed → dual-write).

import { supabase } from '../supabase.js';
import { getInstallationToken } from './github-auth.service.js';
import { isFilenameDenied, scanAndRedact } from './secret-guard.service.js';
import {
  chunkText,
  detectFileType,
  isValidFilePath,
  generateContentHash,
  prepareContentForEmbedding,
} from './codex-utils.js';
import { embedBatch, getEmbeddingService } from './embedding.service.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface SyncResult {
  filesProcessed: number;
  filesSkipped: number;
  errors: number;
  treeSha: string | null;
}

interface RepoRow {
  id: string;
  source_id: string;
  owner: string;
  name: string;
  selected_branch: string;
  cb_github_installations: {
    installation_id: number; // GitHub numeric ID
  };
}

interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const GH_API = 'https://api.github.com';
const GH_HEADERS_BASE = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'ContextBridge-Sync',
};
const MAX_FILE_SIZE = 1024 * 1024; // 1 MB

// ────────────────────────────────────────────────────────────────
// syncRepoFull — full-repo sync
// ────────────────────────────────────────────────────────────────

export async function syncRepoFull(repoRowId: string): Promise<SyncResult> {
  const tag = '[github-sync]';

  // 1. Look up the cb_github_repos row + join for numeric installation ID
  const { data: repoRow, error: repoErr } = await supabase
    .from('cb_github_repos')
    .select('id, source_id, owner, name, selected_branch, cb_github_installations!inner(installation_id)')
    .eq('id', repoRowId)
    .single();

  if (repoErr || !repoRow) {
    throw new Error(`${tag} cb_github_repos row not found: ${repoRowId} (${repoErr?.message})`);
  }

  const repo = repoRow as unknown as RepoRow;
  const numericInstallationId = repo.cb_github_installations.installation_id;

  // Derive project_id from the linked cb_sources row
  const { data: sourceRow, error: srcErr } = await supabase
    .from('cb_sources')
    .select('id, project_id')
    .eq('id', repo.source_id)
    .single();

  if (srcErr || !sourceRow) {
    throw new Error(`${tag} cb_sources row not found for source_id=${repo.source_id}`);
  }

  const projectId: string = sourceRow.project_id;
  const sourceId: string = sourceRow.id;

  console.log(`${tag} Starting full sync: ${repo.owner}/${repo.name}@${repo.selected_branch} (project=${projectId})`);

  // 2. Get installation token
  const token = await getInstallationToken(numericInstallationId);

  // 3. Fetch recursive file tree
  const treeUrl = `${GH_API}/repos/${repo.owner}/${repo.name}/git/trees/${repo.selected_branch}?recursive=true`;
  const treeRes = await fetch(treeUrl, {
    headers: { ...GH_HEADERS_BASE, Authorization: `Bearer ${token}` },
  });

  if (!treeRes.ok) {
    const body = await treeRes.text().catch(() => '');
    throw new Error(`${tag} Tree fetch failed: ${treeRes.status} ${body}`);
  }

  const treeData = (await treeRes.json()) as { sha: string; tree: TreeEntry[]; truncated: boolean };

  if (treeData.truncated) {
    console.warn(`${tag} Tree was truncated by GitHub — very large repo. Some files may be missed.`);
  }

  // 4. Filter to valid blobs
  const validFiles = treeData.tree.filter(
    (entry) => entry.type === 'blob' && isValidFilePath(entry.path) && (!entry.size || entry.size <= MAX_FILE_SIZE),
  );

  console.log(`${tag} Tree: ${treeData.tree.length} entries → ${validFiles.length} valid files`);

  // Reset progress counters
  await supabase
    .from('cb_github_repos')
    .update({
      last_sync_status: 'syncing',
      sync_files_total: validFiles.length,
      sync_files_done: 0,
    })
    .eq('id', repoRowId);

  // 5. Process each file sequentially (avoid GitHub rate limits)
  let filesProcessed = 0;
  let filesSkipped = 0;
  let errors = 0;

  for (const entry of validFiles) {
    try {
      const processed = await ingestFile({
        owner: repo.owner,
        repoName: repo.name,
        branch: repo.selected_branch,
        filePath: entry.path,
        token,
        projectId,
        sourceId,
      });

      if (processed) {
        filesProcessed++;
      } else {
        filesSkipped++;
      }
    } catch (err: any) {
      errors++;
      console.error(`${tag} Error ingesting ${entry.path}:`, err?.message || err);
      // Continue with next file — don't abort the whole sync
    }

    // Update progress
    await supabase
      .from('cb_github_repos')
      .update({ sync_files_done: filesProcessed + filesSkipped + errors })
      .eq('id', repoRowId);
  }

  // 6. Update tracking columns on cb_github_repos
  const syncStatus = errors === 0 ? 'success' : filesProcessed > 0 ? 'partial' : 'error';
  const { error: trackErr } = await supabase
    .from('cb_github_repos')
    .update({
      last_synced_at: new Date().toISOString(),
      last_synced_sha: treeData.sha,
      last_sync_status: syncStatus,
      files_synced_count: filesProcessed,
      sync_files_total: validFiles.length,
      sync_files_done: validFiles.length,
    })
    .eq('id', repoRowId);

  if (trackErr) {
    console.error(`${tag} Failed to update tracking columns:`, trackErr);
  }

  console.log(
    `${tag} Sync complete: ${repo.owner}/${repo.name} — ` +
      `processed=${filesProcessed} skipped=${filesSkipped} errors=${errors} status=${syncStatus}`,
  );

  return { filesProcessed, filesSkipped, errors, treeSha: treeData.sha };
}

// ────────────────────────────────────────────────────────────────
// ingestFile — per-file pipeline
// ────────────────────────────────────────────────────────────────

interface IngestParams {
  owner: string;
  repoName: string;
  branch: string;
  filePath: string;
  token: string;
  projectId: string;
  sourceId: string;
}

/**
 * Fetches a single file from GitHub and ingests it through the full pipeline:
 *   secret guard → chunk → embedBatch → cb_chunks + cb_artifacts + cb_files + cb_file_embeddings
 *
 * Returns `true` if the file was processed, `false` if it was skipped.
 */
async function ingestFile(params: IngestParams): Promise<boolean> {
  const { owner, repoName, branch, filePath, token, projectId, sourceId } = params;
  const tag = '[github-sync]';

  // ── SECRET GUARD — Layer 1: filename denylist ──
  const denyCheck = isFilenameDenied(filePath);
  if (denyCheck.denied) {
    console.warn(`${tag} Skipped secret-bearing filename: ${filePath} (pattern: ${denyCheck.matchedPattern})`);
    return false;
  }

  // ── Fetch file content from GitHub Contents API ──
  const contentsUrl = `${GH_API}/repos/${owner}/${repoName}/contents/${encodeURIComponent(filePath)}?ref=${branch}`;
  const contentsRes = await fetch(contentsUrl, {
    headers: { ...GH_HEADERS_BASE, Authorization: `Bearer ${token}` },
  });

  if (!contentsRes.ok) {
    if (contentsRes.status === 404) {
      console.warn(`${tag} File not found (404): ${filePath}`);
      return false;
    }
    throw new Error(`GitHub Contents API error for ${filePath}: ${contentsRes.status}`);
  }

  const contentsData = (await contentsRes.json()) as {
    content?: string;
    encoding?: string;
    size: number;
  };

  if (!contentsData.content || contentsData.encoding !== 'base64') {
    console.warn(`${tag} Skipped non-base64 or empty content: ${filePath}`);
    return false;
  }

  if (contentsData.size > MAX_FILE_SIZE) {
    console.warn(`${tag} Skipped oversized file: ${filePath} (${contentsData.size} bytes)`);
    return false;
  }

  const rawContent = Buffer.from(contentsData.content, 'base64').toString('utf-8');

  // ── SECRET GUARD — Layer 2: content scan + redaction ──
  let workingContent: string;
  try {
    const scanResult = await scanAndRedact(filePath, rawContent);
    if (scanResult.status === 'redacted') {
      workingContent = scanResult.redactedContent;
      console.warn(
        `${tag} Redacted ${scanResult.findings.length} secret(s) in ${filePath}: ` +
          scanResult.findings.map((f) => `line ${f.line} (${f.ruleId})`).join(', '),
      );
    } else {
      workingContent = rawContent;
    }
  } catch (scanErr: any) {
    // Fail-closed: skip the file rather than risk leaking secrets
    console.error(`${tag} Secret scan failed for ${filePath} — skipping:`, scanErr?.message || scanErr);
    return false;
  }

  // ── File metadata ──
  const { fileType, extension, language } = detectFileType(filePath);
  const contentHash = generateContentHash(workingContent);
  const fileName = filePath.split('/').pop() || filePath;

  // ================================================================
  // PART 1: cb_artifacts → cb_chunks (same pattern as codex-ingestion)
  // ================================================================

  // Find or create artifact for this file
  let { data: artifact } = await supabase
    .from('cb_artifacts')
    .select('id')
    .eq('source_id', sourceId)
    .eq('key', filePath)
    .single();

  if (!artifact) {
    const { data: newArtifact, error: artError } = await supabase
      .from('cb_artifacts')
      .insert({
        project_id: projectId,
        source_id: sourceId,
        artifact_kind: 'file',
        title: fileName,
        key: filePath,
        metadata: { language, file_path: filePath },
      })
      .select('id')
      .single();

    if (artError) {
      throw new Error(`Failed to create artifact for ${filePath}: ${artError.message}`);
    }
    artifact = newArtifact;
  } else {
    await supabase
      .from('cb_artifacts')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', artifact.id);
  }

  // Delete existing chunks for this artifact (replace on re-sync)
  await supabase.from('cb_chunks').delete().eq('artifact_id', artifact!.id);

  // Chunk the content
  const textChunks = chunkText(workingContent);

  if (textChunks.length === 0) {
    console.log(`${tag} No meaningful chunks for ${filePath} — skipping`);
    return false;
  }

  // Batch-embed all chunks
  const chunkTexts = textChunks.map((c) => c.text);
  let embeddings: number[][] = [];
  try {
    embeddings = await embedBatch(chunkTexts);
  } catch (embErr: any) {
    console.warn(`${tag} embedBatch failed for ${filePath}:`, embErr?.message);
    embeddings = chunkTexts.map(() => []);
  }

  // Build chunk rows
  const chunksToInsert = textChunks.map((chunk, i) => {
    const emb = embeddings[i];
    return {
      project_id: projectId,
      source_id: sourceId,
      artifact_id: artifact!.id,
      provider: 'github',
      chunk_kind: 'code',
      text: chunk.text,
      start_line: chunk.startLine,
      end_line: chunk.endLine,
      metadata: {
        file_path: filePath,
        language,
      },
      embedding: emb && emb.length > 0 ? emb : null,
    };
  });

  // Batch insert chunks
  if (chunksToInsert.length > 0) {
    const { error: chunkError } = await supabase.from('cb_chunks').insert(chunksToInsert);
    if (chunkError) {
      throw new Error(`Failed to insert chunks for ${filePath}: ${chunkError.message}`);
    }
  }

  // ================================================================
  // PART 2: DUAL-WRITE to cb_files → cb_file_embeddings
  // ================================================================

  let cbFileId: string | null = null;

  // 5. Find or create cb_files record
  const { data: existingFile } = await supabase
    .from('cb_files')
    .select('id, content_sha')
    .eq('project_id', projectId)
    .eq('file_name', filePath)
    .single();

  if (!existingFile) {
    const { data: newFile, error: fileError } = await supabase
      .from('cb_files')
      .insert({
        project_id: projectId,
        file_name: filePath,
        file_type: fileType,
        file_extension: extension,
        language,
        content: workingContent,
        content_sha: contentHash,
        content_tokens: Math.ceil(workingContent.length / 4),
        importance_score: 0.7,
      })
      .select('id')
      .single();

    if (fileError) {
      console.error(`${tag} Failed to create cb_files record for ${filePath}:`, fileError);
    } else {
      cbFileId = newFile!.id;
    }
  } else if (existingFile.content_sha !== contentHash) {
    const { error: updateError } = await supabase
      .from('cb_files')
      .update({
        content: workingContent,
        content_sha: contentHash,
        content_tokens: Math.ceil(workingContent.length / 4),
      })
      .eq('id', existingFile.id);

    if (updateError) {
      console.error(`${tag} Failed to update cb_files record for ${filePath}:`, updateError);
    }
    cbFileId = existingFile.id;
  } else {
    // Content unchanged
    cbFileId = existingFile.id;
  }

  // 6. Create/update cb_file_embeddings (full-file embedding)
  if (cbFileId) {
    try {
      const embeddingService = getEmbeddingService();
      const denseContent = prepareContentForEmbedding(filePath, workingContent, fileType);
      const maxEmbedChars = 32000;
      const textForEmbedding =
        denseContent.length > maxEmbedChars ? denseContent.substring(0, maxEmbedChars) : denseContent;

      const { embedding, model, dimensions } = await embeddingService.generateEmbedding(textForEmbedding);

      const { data: existingEmbed } = await supabase
        .from('cb_file_embeddings')
        .select('cb_file_id')
        .eq('cb_file_id', cbFileId)
        .single();

      if (!existingEmbed) {
        const { error: embedError } = await supabase.from('cb_file_embeddings').insert({
          cb_file_id: cbFileId,
          project_id: projectId,
          path_hint: filePath,
          embedding,
          embedding_model: model,
          embedding_dimensions: dimensions,
          status: 'success',
        });

        if (embedError) {
          console.error(`${tag} Failed to create cb_file_embeddings for ${filePath}:`, embedError);
        }
      } else {
        const { error: embedUpdateError } = await supabase
          .from('cb_file_embeddings')
          .update({
            path_hint: filePath,
            embedding,
            embedding_model: model,
            embedding_dimensions: dimensions,
            status: 'success',
            last_attempted_at: new Date().toISOString(),
          })
          .eq('cb_file_id', cbFileId);

        if (embedUpdateError) {
          console.error(`${tag} Failed to update cb_file_embeddings for ${filePath}:`, embedUpdateError);
        }
      }
    } catch (embedErr: any) {
      console.error(`${tag} File embedding failed for ${filePath}:`, embedErr?.message);
      // Don't throw — chunks were already saved
    }
  }

  console.log(`${tag} ✅ ${filePath} (${chunksToInsert.length} chunks + dual-write)`);
  return true;
}

// ────────────────────────────────────────────────────────────────
// syncPush — incremental sync from webhook push event
// ────────────────────────────────────────────────────────────────

interface PushCommit {
  added: string[];
  modified: string[];
  removed: string[];
}

export async function syncPush(
  numericInstallationId: number,
  repoFullName: string,
  branch: string,
  headSha: string,
  commits: PushCommit[],
): Promise<void> {
  const tag = '[github-sync:push]';
  const [owner, repoName] = repoFullName.split('/');

  if (!owner || !repoName) {
    console.warn(`${tag} Invalid repo full_name: ${repoFullName}`);
    return;
  }

  // 1. Find matching cb_github_repos rows (currently one, future: multiple)
  const { data: repoRows, error: repoErr } = await supabase
    .from('cb_github_repos')
    .select('id, source_id, owner, name, selected_branch, cb_github_installations!inner(installation_id)')
    .eq('owner', owner)
    .eq('name', repoName)
    .eq('selected_branch', branch);

  if (repoErr) {
    console.error(`${tag} Query error:`, repoErr);
    return;
  }

  if (!repoRows || repoRows.length === 0) {
    console.log(`${tag} No tracked repos for ${repoFullName}@${branch} — ignoring push`);
    return;
  }

  // 2. Get installation token
  const token = await getInstallationToken(numericInstallationId);

  // 3. Deduplicate file paths across commits
  const addedOrModified = new Set<string>();
  const removed = new Set<string>();

  for (const commit of commits) {
    for (const f of commit.added) addedOrModified.add(f);
    for (const f of commit.modified) addedOrModified.add(f);
    for (const f of commit.removed) removed.add(f);
  }

  // If a file was removed then re-added in the same push, treat it as modified
  for (const f of addedOrModified) {
    removed.delete(f);
  }

  // Filter to valid file paths
  const filesToIngest = [...addedOrModified].filter(isValidFilePath);
  const filesToRemove = [...removed].filter(isValidFilePath);

  console.log(
    `${tag} ${repoFullName}@${branch}: ${filesToIngest.length} to ingest, ${filesToRemove.length} to remove ` +
      `(across ${commits.length} commits, ${repoRows.length} linked repos)`,
  );

  // 4. Process each linked repo row
  for (const row of repoRows) {
    const repoRow = row as unknown as RepoRow;
    const sourceId = repoRow.source_id;

    // Derive project_id from cb_sources
    const { data: sourceRow, error: srcErr } = await supabase
      .from('cb_sources')
      .select('id, project_id')
      .eq('id', sourceId)
      .single();

    if (srcErr || !sourceRow) {
      console.error(`${tag} cb_sources not found for source_id=${sourceId}`);
      continue;
    }

    const projectId: string = sourceRow.project_id;

    // ── Ingest added/modified files ──
    let ingested = 0;
    let skipped = 0;
    let errors = 0;

    for (const filePath of filesToIngest) {
      try {
        const processed = await ingestFile({
          owner,
          repoName,
          branch,
          filePath,
          token,
          projectId,
          sourceId,
        });
        if (processed) ingested++;
        else skipped++;
      } catch (err: any) {
        errors++;
        console.error(`${tag} Error ingesting ${filePath}:`, err?.message || err);
      }
    }

    // ── Hard-delete removed files ──
    let deleted = 0;

    for (const filePath of filesToRemove) {
      try {
        // Delete cb_chunks via artifact
        const { data: artifact } = await supabase
          .from('cb_artifacts')
          .select('id')
          .eq('source_id', sourceId)
          .eq('key', filePath)
          .single();

        if (artifact) {
          await supabase.from('cb_chunks').delete().eq('artifact_id', artifact.id);
          await supabase.from('cb_artifacts').delete().eq('id', artifact.id);
        }

        // Delete cb_file_embeddings + cb_files
        const { data: fileRow } = await supabase
          .from('cb_files')
          .select('id')
          .eq('project_id', projectId)
          .eq('file_name', filePath)
          .single();

        if (fileRow) {
          await supabase.from('cb_file_embeddings').delete().eq('cb_file_id', fileRow.id);
          await supabase.from('cb_files').delete().eq('id', fileRow.id);
        }

        deleted++;
        console.log(`${tag} 🗑️ Removed ${filePath}`);
      } catch (err: any) {
        errors++;
        console.error(`${tag} Error removing ${filePath}:`, err?.message || err);
      }
    }

    // ── Update tracking ──
    const { error: trackErr } = await supabase
      .from('cb_github_repos')
      .update({
        last_synced_at: new Date().toISOString(),
        last_synced_sha: headSha,
        last_sync_status: errors === 0 ? 'success' : 'partial',
      })
      .eq('id', repoRow.id);

    if (trackErr) {
      console.error(`${tag} Failed to update tracking:`, trackErr);
    }

    console.log(
      `${tag} Done: ${repoFullName}@${branch} project=${projectId} — ` +
        `ingested=${ingested} skipped=${skipped} deleted=${deleted} errors=${errors}`,
    );
  }
}