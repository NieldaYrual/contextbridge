// packages/backend/src/routes/codex.routes.ts
// Express routes for handling Codex code file upserts, deletions, renames, and searches.
import express from 'express';
import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SemanticChunker } from '../services/semantic-chunker/semantic-chunker.service.js';
import { isFilenameDenied, scanAndRedact } from '../services/secret-guard.service';
const chunker = new SemanticChunker();

type UpsertFilePayload = {
  projectId: string;
  origin: 'vscode' | 'github';
  repoExternalId: string;  // workspace path or git remote
  repoName: string;
  filePath: string;        // "src/api/scheduler.ts"
  language?: string;
  content: string;
  contentHash: string;
  lastModified: string;    // ISO string
};

type DeleteFilePayload = {
  projectId: string;
  repoExternalId: string;
  filePath: string;
};

type RenameFilePayload = {
  projectId: string;
  repoExternalId: string;
  oldPath: string;
  newPath: string;
};

type CodeChunk = {
  text: string;
  startLine: number;
  endLine: number;
};

function chunkCode(content: string, chunkSize = 120, overlap = 20): CodeChunk[] {
  const lines = content.split('\n');
  const chunks: CodeChunk[] = [];
  let start = 0;

  while (start < lines.length) {
    const end = Math.min(lines.length, start + chunkSize);
    const text = lines.slice(start, end).join('\n');
    chunks.push({ text, startLine: start + 1, endLine: end });

    if (end === lines.length) break;
    start = end - overlap;
  }

  return chunks;
}

export function createCodexRoutes(supabase: SupabaseClient) {
  const router = express.Router();

  // POST /api/codex/upsert-file
  router.post('/codex/upsert-file', async (req: Request, res: Response) => {
    console.log('[codex] ====== UPSERT-FILE HIT ======', req.body?.filePath);
    try {
      const payload = req.body as UpsertFilePayload;

      console.log('[codex] upsert-file hit', {
        projectId: payload.projectId,
        filePath: payload.filePath,
        origin: payload.origin,
      });

      const {
        projectId,
        origin,
        repoExternalId,
        repoName,
        filePath,
        language,
        content,
        contentHash,
        lastModified,
      } = payload;

      if (!projectId || !repoExternalId || !filePath || !content) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // ================================================================
      // SECRET GUARD — Layer 1: filename denylist (whole-file refusal)
      // ================================================================
      const denyCheck = isFilenameDenied(filePath);
      if (denyCheck.denied) {
        console.warn(`[codex] Skipped secret-bearing filename: ${filePath} (pattern: ${denyCheck.matchedPattern})`);
        return res.status(200).json({
          success: false,
          skipped: true,
          reason: 'secret_filename_blocked',
          filePath,
          pattern: denyCheck.matchedPattern,
          message: 'This filename is on the secret-denylist and was not indexed. Remove sensitive data or rename the file to sync it.',
        });
      }

      // ================================================================
      // SECRET GUARD — Layer 2: content scan + line-level redaction
      // ================================================================
      let workingContent: string = content;
      let workingContentHash: string = contentHash;
      let redactionSummary: { redacted: boolean; findings: Array<{ ruleId: string; line: number; message: string }> } = {
        redacted: false,
        findings: [],
      };
      try {
        const scanResult = await scanAndRedact(filePath, content);
        if (scanResult.status === 'redacted') {
          workingContent = scanResult.redactedContent;
          // Recompute hash so the change-detection path below reflects the redacted content.
          const { createHash } = await import('crypto');
          workingContentHash = createHash('sha256').update(workingContent).digest('hex').substring(0, 32);
          redactionSummary = { redacted: true, findings: scanResult.findings };
          console.warn(
            `[codex] Redacted ${scanResult.findings.length} secret(s) in ${filePath}: ` +
            scanResult.findings.map(f => `line ${f.line} (${f.ruleId})`).join(', ')
          );
        }
      } catch (scanErr: any) {
        // Fail-closed: skip the file rather than risk leaking.
        console.error(`[codex] Secret scan failed for ${filePath} — skipping file:`, scanErr?.message || scanErr);
        return res.status(200).json({
          success: false,
          skipped: true,
          reason: 'secret_scan_error',
          filePath,
          message: 'Secret scan failed; file was not indexed out of an abundance of caution.',
        });
      }

      // 1) Get or create source (repo)
      const { data: existingSource, error: sourceError } = await supabase
        .from('cb_sources')
        .select('*')
        .eq('project_id', projectId)
        .eq('provider', 'codex')
        .eq('source_kind', 'repo')
        .eq('external_id', repoExternalId)
        .maybeSingle();

      if (sourceError) {
        console.error('[codex] sourceError', sourceError);
        return res.status(500).json({ error: 'Failed to fetch source' });
      }

      let source = existingSource;
      if (!source) {
        const { data: insertedSource, error: insertSourceError } = await supabase
          .from('cb_sources')
          .insert({
            project_id: projectId,
            provider: 'codex',
            source_kind: 'repo',
            name: `Codex: ${repoName}`,
            external_id: repoExternalId,
            metadata: { origin },
          })
          .select()
          .single();

        if (insertSourceError || !insertedSource) {
          console.error('[codex] insertSourceError', insertSourceError);
          return res.status(500).json({ error: 'Failed to create source' });
        }
        source = insertedSource;
      }

      // 2) Get or create artifact (file)
      const { data: existingArtifact, error: artifactError } = await supabase
        .from('cb_artifacts')
        .select('*')
        .eq('source_id', source.id)
        .eq('key', filePath)
        .maybeSingle();

      if (artifactError) {
        console.error('[codex] artifactError', artifactError);
        return res.status(500).json({ error: 'Failed to fetch artifact' });
      }

      const artifactMetadata = {
        origin,
        language,
        content_hash: workingContentHash,
        last_modified: lastModified,
      };

      let artifact = existingArtifact as any;
      let contentChanged = true;

      if (!artifact) {
        const { data: insertedArtifact, error: insertArtifactError } = await supabase
          .from('cb_artifacts')
          .insert({
            project_id: projectId,
            source_id: source.id,
            artifact_kind: 'file',
            title: filePath,
            key: filePath,
            metadata: artifactMetadata,
          })
          .select()
          .single();

        if (insertArtifactError || !insertedArtifact) {
          console.error('[codex] insertArtifactError', insertArtifactError);
          return res.status(500).json({ error: 'Failed to create artifact' });
        }
        artifact = insertedArtifact;
      } else {
        const previousHash = (artifact.metadata && artifact.metadata.content_hash) || null;
        contentChanged = previousHash !== workingContentHash;

        const { data: updatedArtifact, error: updateArtifactError } = await supabase
          .from('cb_artifacts')
          .update({
            metadata: artifactMetadata,
            deleted_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', artifact.id)
          .select()
          .single();

        if (updateArtifactError || !updatedArtifact) {
          console.error('[codex] updateArtifactError', updateArtifactError);
          return res.status(500).json({ error: 'Failed to update artifact' });
        }
        artifact = updatedArtifact;
      }

      if (!contentChanged) {
        return res.status(200).json({
          status: 'no_change',
          sourceId: source.id,
          artifactId: artifact.id,
        });
      }

      // 3) Chunk file content (Semantic!)
      let chunks: { text: string; startLine: number; endLine: number; type?: string; parentName?: string; name?: string }[] = [];
      try {
        chunks = await chunker.chunkFile(filePath, workingContent);
      } catch (e) {
        console.warn(`[codex] Semantic chunking failed for ${filePath}, using line fallback.`, e);
      }

      // Safety net: never accept 0 chunks for a non-empty file
      if (chunks.length === 0 && workingContent.trim().length > 0) {
        console.warn(`[codex] Zero chunks for ${filePath}, applying line-based fallback`);
        chunks = chunkCode(content).map(c => ({ ...c, type: 'block' as const }));
      }

      console.log(`[Chunker] Split ${filePath} into ${chunks.length} chunks`);

      // 4) Delete existing chunks
      const { error: deleteChunksError } = await supabase
        .from('cb_chunks')
        .delete()
        .eq('artifact_id', artifact.id);

      if (deleteChunksError) {
        console.error('[codex] deleteChunksError', deleteChunksError);
        return res.status(500).json({ error: 'Failed to delete existing chunks' });
      }

      // 5) Insert new chunks with embeddings
      if (chunks.length > 0) {
          // Batch-embed all chunks in one (or a few) OpenAI requests
          const { embedBatch } = await import('../services/embedding.service.js');

          const chunkTexts = chunks.map(c => c.text || '');
          let embeddings: number[][] = [];
          try {
            embeddings = await embedBatch(chunkTexts);
          } catch (embErr: any) {
            console.warn(`[codex] embedBatch failed for ${filePath}:`, embErr.message);
            // Fall back to null embeddings — backfill can recover these
            embeddings = chunkTexts.map(() => []);
          }

          const chunksToInsert = chunks.map((chunk, i) => {
            const emb = embeddings[i];
            const embeddingVector = emb && emb.length > 0 ? `[${emb.join(',')}]` : null;
            return {
              project_id: projectId,
              source_id: source.id,
              artifact_id: artifact.id,
              provider: 'codex',
              chunk_kind: 'code',
              text: chunk.name && chunk.name !== 'anonymous'
                ? `// Function: ${chunk.name}\n${chunk.text}`
                : chunk.text,
              raw: {
                file_path: filePath,
                language,
                origin,
                type: chunk.type,
                parent: chunk.parentName,
                name: chunk.name
              },
              start_line: chunk.startLine,
              end_line: chunk.endLine,
              metadata: {
                file_path: filePath,
                language,
                origin,
                type: chunk.type,
                parent: chunk.parentName,
                name: chunk.name
              },
              embedding: embeddingVector,
            };
          });

          console.log(`[codex] Generated embeddings for ${chunksToInsert.filter(c => c.embedding).length}/${chunksToInsert.length} chunks`);

          // Single DB call for all chunks
          const { error: insertChunkError } = await supabase
            .from('cb_chunks')
            .insert(chunksToInsert);

          if (insertChunkError) {
            console.error('[codex] insertChunkError', insertChunkError);
            return res.status(500).json({ error: 'Failed to insert chunks' });
          }
      }

      return res.status(200).json({
        status: 'ok',
        sourceId: source.id,
        artifactId: artifact.id,
        chunksInserted: chunks.length,
        redaction: redactionSummary,
      });
    } catch (err) {
      console.error('[codex] upsert-file exception', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/codex/file
  router.delete('/codex/file', async (req: Request, res: Response) => {
    try {
      const payload = req.body as DeleteFilePayload;
      const { projectId, repoExternalId, filePath } = payload;

      if (!projectId || !repoExternalId || !filePath) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const { data: source, error: sourceError } = await supabase
        .from('cb_sources')
        .select('id')
        .eq('project_id', projectId)
        .eq('provider', 'codex')
        .eq('source_kind', 'repo')
        .eq('external_id', repoExternalId)
        .maybeSingle();

      if (sourceError) {
        console.error('[codex] sourceError', sourceError);
        return res.status(500).json({ error: 'Failed to fetch source' });
      }

      if (!source) {
        return res.status(200).json({ status: 'noop' });
      }

      const { data: artifact, error: artifactError } = await supabase
        .from('cb_artifacts')
        .select('id')
        .eq('source_id', source.id)
        .eq('key', filePath)
        .maybeSingle();

      if (artifactError) {
        console.error('[codex] artifactError', artifactError);
        return res.status(500).json({ error: 'Failed to fetch artifact' });
      }

      if (!artifact) {
        return res.status(200).json({ status: 'noop' });
      }

      const now = new Date().toISOString();

      const { error: updateArtifactError } = await supabase
        .from('cb_artifacts')
        .update({
          deleted_at: now,
          updated_at: now,
        })
        .eq('id', artifact.id);

      if (updateArtifactError) {
        console.error('[codex] updateArtifactError', updateArtifactError);
        return res.status(500).json({ error: 'Failed to update artifact' });
      }

      const { error: deleteChunksError } = await supabase
        .from('cb_chunks')
        .delete()
        .eq('artifact_id', artifact.id);

      if (deleteChunksError) {
        console.error('[codex] deleteChunksError', deleteChunksError);
        return res.status(500).json({ error: 'Failed to delete chunks' });
      }

      return res.status(200).json({ status: 'deleted' });
    } catch (err) {
      console.error('[codex] delete-file exception', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/codex/rename-file
  router.patch('/codex/rename-file', async (req: Request, res: Response) => {
    try {
      const payload = req.body as RenameFilePayload;
      const { projectId, repoExternalId, oldPath, newPath } = payload;

      if (!projectId || !repoExternalId || !oldPath || !newPath) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const { data: source, error: sourceError } = await supabase
        .from('cb_sources')
        .select('id')
        .eq('project_id', projectId)
        .eq('provider', 'codex')
        .eq('source_kind', 'repo')
        .eq('external_id', repoExternalId)
        .maybeSingle();

      if (sourceError) {
        console.error('[codex] sourceError', sourceError);
        return res.status(500).json({ error: 'Failed to fetch source' });
      }

      if (!source) {
        return res.status(200).json({ status: 'noop' });
      }

      const { data: artifact, error: artifactError } = await supabase
        .from('cb_artifacts')
        .select('id, metadata')
        .eq('source_id', source.id)
        .eq('key', oldPath)
        .maybeSingle();

      if (artifactError) {
        console.error('[codex] artifactError', artifactError);
        return res.status(500).json({ error: 'Failed to fetch artifact' });
      }

      if (!artifact) {
        return res.status(200).json({ status: 'noop' });
      }

      const now = new Date().toISOString();
      const newMetadata = {
        ...(artifact.metadata || {}),
        file_path: newPath,
      };

      const { error: updateArtifactError } = await supabase
        .from('cb_artifacts')
        .update({
          title: newPath,
          key: newPath,
          metadata: newMetadata,
          updated_at: now,
        })
        .eq('id', artifact.id);

      if (updateArtifactError) {
        console.error('[codex] updateArtifactError', updateArtifactError);
        return res.status(500).json({ error: 'Failed to update artifact' });
      }

      const { error: updateChunksError } = await supabase
        .from('cb_chunks')
        .update({
          metadata: newMetadata,
          raw: {
            file_path: newPath,
          },
        })
        .eq('artifact_id', artifact.id);

      if (updateChunksError) {
        console.error('[codex] updateChunksError', updateChunksError);
        return res.status(500).json({ error: 'Failed to update chunks' });
      }

      return res.status(200).json({ status: 'renamed' });
    } catch (err) {
      console.error('[codex] rename-file exception', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

    // GET /api/codex/search?projectId=...&q=...&limit=...
  router.get('/codex/search', async (req: Request, res: Response) => {
    try {
      const projectId = req.query.projectId as string | undefined;
      const q = (req.query.q as string | undefined) ?? '';
      const limit = req.query.limit ? Number(req.query.limit) : 20;

      if (!projectId) {
        return res.status(400).json({ error: 'Missing projectId' });
      }
      if (!q.trim()) {
        return res.status(400).json({ error: 'Missing q (query string)' });
      }

      const { data, error } = await supabase.rpc('cb_search_codex_text', {
        p_project_id: projectId,
        p_query: q,
        p_limit: limit,
      });

      if (error) {
        console.error('[codex] search error', error);
        return res.status(500).json({ error: 'Failed to search codex code' });
      }

      return res.status(200).json({
        status: 'ok',
        query: q,
        results: data ?? [],
      });
    } catch (err) {
      console.error('[codex] search exception', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/codex/files?projectId=...&repoExternalId=...
  router.get('/codex/files', async (req: Request, res: Response) => {
    try {
      const projectId = req.query.projectId as string | undefined;
      const repoExternalId = req.query.repoExternalId as string | undefined;

      if (!projectId || !repoExternalId) {
        return res.status(400).json({ error: 'Missing projectId or repoExternalId' });
      }

      // Find the source
      const { data: source, error: sourceError } = await supabase
        .from('cb_sources')
        .select('id')
        .eq('project_id', projectId)
        .eq('provider', 'codex')
        .eq('source_kind', 'repo')
        .eq('external_id', repoExternalId)
        .maybeSingle();

      if (sourceError) {
        console.error('[codex] files sourceError', sourceError);
        return res.status(500).json({ error: 'Failed to fetch source' });
      }

      if (!source) {
        // No source yet = no files synced
        return res.status(200).json({ files: [] });
      }

      // Get all non-deleted artifacts for this source
      const { data: artifacts, error: artifactsError } = await supabase
        .from('cb_artifacts')
        .select('key, metadata')
        .eq('source_id', source.id)
        .is('deleted_at', null);

      if (artifactsError) {
        console.error('[codex] files artifactsError', artifactsError);
        return res.status(500).json({ error: 'Failed to fetch artifacts' });
      }

      // Map to { filePath: contentHash }
      const files = (artifacts || []).map((a: any) => ({
        filePath: a.key,
        contentHash: a.metadata?.content_hash || null
      }));

      return res.status(200).json({ files });

    } catch (err) {
      console.error('[codex] files exception', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/codex/artifact/:artifactId/content
  router.get('/codex/artifact/:artifactId/content', async (req: Request, res: Response) => {
    try {
      const { artifactId } = req.params;
      const { startLine, endLine } = req.query;

      if (!artifactId) {
        return res.status(400).json({ error: 'Missing artifactId' });
      }

      // Get artifact metadata
      const { data: artifact, error: artifactError } = await supabase
        .from('cb_artifacts')
        .select('id, key, title, metadata, source_id')
        .eq('id', artifactId)
        .maybeSingle();

      if (artifactError) {
        console.error('[codex] artifact fetch error', artifactError);
        return res.status(500).json({ error: 'Failed to fetch artifact' });
      }

      if (!artifact) {
        return res.status(404).json({ error: 'Artifact not found' });
      }

      // Get all chunks for this artifact, ordered by line number
      const { data: chunks, error: chunksError } = await supabase
        .from('cb_chunks')
        .select('text, start_line, end_line')
        .eq('artifact_id', artifactId)
        .order('start_line', { ascending: true });

      if (chunksError) {
        console.error('[codex] chunks fetch error', chunksError);
        return res.status(500).json({ error: 'Failed to fetch chunks' });
      }

      if (!chunks || chunks.length === 0) {
        return res.status(404).json({ error: 'No content found for artifact' });
      }

      // Reconstruct full file from chunks (handle overlaps)
      const lines: string[] = [];
      let lastEndLine = 0;

      for (const chunk of chunks) {
        const chunkLines = chunk.text.split('\n');
        const startIdx = chunk.start_line;
        
        // Skip overlapping lines we already have
        const skipLines = Math.max(0, lastEndLine - startIdx + 1);
        
        for (let i = skipLines; i < chunkLines.length; i++) {
          const lineNum = startIdx + i;
          lines[lineNum - 1] = chunkLines[i]; // 1-indexed to 0-indexed
        }
        
        lastEndLine = Math.max(lastEndLine, chunk.end_line);
      }

      // Filter to requested line range if specified
      let content = lines.join('\n');
      let actualStartLine = 1;
      let actualEndLine = lines.length;

      if (startLine && endLine) {
        const start = parseInt(startLine as string, 10);
        const end = parseInt(endLine as string, 10);
        if (!isNaN(start) && !isNaN(end) && start > 0 && end >= start) {
          const selectedLines = lines.slice(start - 1, end);
          content = selectedLines.join('\n');
          actualStartLine = start;
          actualEndLine = Math.min(end, lines.length);
        }
      }

      return res.status(200).json({
        artifactId: artifact.id,
        filePath: artifact.key,
        language: artifact.metadata?.language || 'plaintext',
        content,
        startLine: actualStartLine,
        endLine: actualEndLine,
        totalLines: lines.length
      });

    } catch (err) {
      console.error('[codex] artifact content exception', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/codex/file-content?projectId=...&filePath=...&startLine=...&endLine=...
  router.get('/codex/file-content', async (req: Request, res: Response) => {
    try {
      const { projectId, filePath, startLine, endLine } = req.query;

      if (!projectId || !filePath) {
        return res.status(400).json({ error: 'Missing projectId or filePath' });
      }

      // Find the artifact by file path
      const { data: artifact, error: artifactError } = await supabase
        .from('cb_artifacts')
        .select('id, key, metadata')
        .eq('project_id', projectId)
        .eq('key', filePath)
        .is('deleted_at', null)
        .maybeSingle();

      if (artifactError) {
        console.error('[codex] file-content artifact error', artifactError);
        return res.status(500).json({ error: 'Failed to fetch artifact' });
      }

      if (!artifact) {
        return res.status(404).json({ error: 'File not found in index' });
      }

      // Get all chunks for this artifact, ordered by line number
      const { data: chunks, error: chunksError } = await supabase
        .from('cb_chunks')
        .select('text, start_line, end_line')
        .eq('artifact_id', artifact.id)
        .order('start_line', { ascending: true });

      if (chunksError) {
        console.error('[codex] file-content chunks error', chunksError);
        return res.status(500).json({ error: 'Failed to fetch chunks' });
      }

      if (!chunks || chunks.length === 0) {
        return res.status(404).json({ error: 'No content found for file' });
      }

      // Reconstruct full file from chunks (handle overlaps)
      const lines: string[] = [];
      let lastEndLine = 0;

      for (const chunk of chunks) {
        const chunkLines = chunk.text.split('\n');
        const startIdx = chunk.start_line;
        
        // Skip overlapping lines we already have
        const skipLines = Math.max(0, lastEndLine - startIdx + 1);
        
        for (let i = skipLines; i < chunkLines.length; i++) {
          const lineNum = startIdx + i;
          lines[lineNum - 1] = chunkLines[i]; // 1-indexed to 0-indexed
        }
        
        lastEndLine = Math.max(lastEndLine, chunk.end_line);
      }

      // Filter to requested line range if specified
      let content = lines.join('\n');
      let actualStartLine = 1;
      let actualEndLine = lines.length;

      if (startLine && endLine) {
        const start = parseInt(startLine as string, 10);
        const end = parseInt(endLine as string, 10);
        if (!isNaN(start) && !isNaN(end) && start > 0 && end >= start) {
          const selectedLines = lines.slice(start - 1, end);
          content = selectedLines.join('\n');
          actualStartLine = start;
          actualEndLine = Math.min(end, lines.length);
        }
      }

      return res.status(200).json({
        filePath: artifact.key,
        language: artifact.metadata?.language || 'plaintext',
        content,
        startLine: actualStartLine,
        endLine: actualEndLine,
        totalLines: lines.length
      });

    } catch (err) {
      console.error('[codex] file-content exception', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/codex/backfill/embeddings
  // Backfill embeddings for chunks that don't have them
  router.post('/codex/backfill/embeddings', async (req: Request, res: Response) => {
    try {
      const { projectId, limit = 100 } = req.body;

      if (!projectId) {
        return res.status(400).json({ error: 'projectId required' });
      }

      // 1) Fetch chunks without embeddings
      const { data: chunks, error: fetchError } = await supabase
        .from('cb_chunks')
        .select('id, text')
        .eq('project_id', projectId)
        .is('embedding', null)
        .limit(limit);

      if (fetchError) {
        console.error('[codex-backfill] fetch error:', fetchError);
        return res.status(500).json({ error: 'Failed to fetch chunks' });
      }

      if (!chunks || chunks.length === 0) {
        return res.status(200).json({ 
          status: 'done', 
          processed: 0, 
          remaining: 0,
          message: 'No chunks need embeddings' 
        });
      }

      console.log(`[codex-backfill] Processing ${chunks.length} chunks for project ${projectId}`);

      // 2) Import embedding service dynamically to avoid circular deps
      const { getEmbeddingService } = await import('../services/embedding.service.js');
      const embeddingService = getEmbeddingService();

      let processed = 0;
      let failed = 0;

      // 3) Generate embeddings and update chunks
      for (const chunk of chunks) {
        try {
          if (!chunk.text || chunk.text.trim().length === 0) {
            failed++;
            continue;
          }

          const { embedding } = await embeddingService.generateEmbedding(chunk.text);
          const vectorString = `[${embedding.join(',')}]`;

          const { error: updateError } = await supabase
            .from('cb_chunks')
            .update({ embedding: vectorString })
            .eq('id', chunk.id);

          if (updateError) {
            console.error(`[codex-backfill] update error for chunk ${chunk.id}:`, updateError);
            failed++;
          } else {
            processed++;
          }
        } catch (embErr: any) {
          console.error(`[codex-backfill] embedding error for chunk ${chunk.id}:`, embErr.message);
          failed++;
        }
      }

      // 4) Check remaining
      const { count: remaining } = await supabase
        .from('cb_chunks')
        .select('*', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .is('embedding', null);

      console.log(`[codex-backfill] Processed: ${processed}, Failed: ${failed}, Remaining: ${remaining}`);

      return res.status(200).json({
        status: remaining === 0 ? 'done' : 'partial',
        processed,
        failed,
        remaining: remaining || 0,
        modelUsed: 'text-embedding-3-small'
      });

    } catch (err: any) {
      console.error('[codex-backfill] exception:', err);
      return res.status(500).json({ error: err.message || 'Backfill failed' });
    }
  });

  // GET /api/codex/embedding-status
  // Check how many chunks need embeddings
  router.get('/codex/embedding-status', async (req: Request, res: Response) => {
    try {
      const projectId = req.query.projectId as string;

      if (!projectId) {
        return res.status(400).json({ error: 'projectId required' });
      }

      const [totalRes, pendingRes] = await Promise.all([
        supabase
          .from('cb_chunks')
          .select('*', { count: 'exact', head: true })
          .eq('project_id', projectId),
        supabase
          .from('cb_chunks')
          .select('*', { count: 'exact', head: true })
          .eq('project_id', projectId)
          .is('embedding', null)
      ]);

      const total = totalRes.count || 0;
      const pending = pendingRes.count || 0;
      const complete = total - pending;
      const percent = total > 0 ? Math.round((complete / total) * 100) : 100;

      return res.status(200).json({
        projectId,
        total,
        pending,
        complete,
        percent
      });

    } catch (err: any) {
      console.error('[codex] embedding-status error:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}