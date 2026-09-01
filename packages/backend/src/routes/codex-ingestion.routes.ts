import { Router, Request, Response } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import { embedBatch, getEmbeddingService } from '../services/embedding.service';
import crypto from 'crypto';
import { isFilenameDenied, scanAndRedact } from '../services/secret-guard.service';
import { chunkText, detectFileType, isValidFilePath, generateContentHash, prepareContentForEmbedding } from '../services/codex-utils.js';

export function createCodexIngestionRoutes(supabase: SupabaseClient) {
  const router = Router();

  // POST /api/codex/sync
  // Body: { projectId, filePath, content, language }
  router.post('/codex/sync', async (req: Request, res: Response) => {
    try {
      const { projectId, filePath, content, language: providedLanguage } = req.body;

      // --- Path validity gate (existing) ---
      if (!isValidFilePath(filePath)) {
        console.warn(`[Codex] Skipped invalid path: ${filePath}`);
        return res.status(200).json({ success: false, skipped: true, reason: 'invalid_path' });
      }

      if (!projectId || !filePath || content === undefined) {
        return res.status(400).json({ error: 'Missing projectId, filePath, or content' });
      }

      console.log(`[Codex] Syncing file: ${filePath}`);

      // ================================================================
      // SECRET GUARD — Layer 1: filename denylist (whole-file refusal)
      // ================================================================
      const denyCheck = isFilenameDenied(filePath);
      if (denyCheck.denied) {
        console.warn(`[Codex] Skipped secret-bearing filename: ${filePath} (pattern: ${denyCheck.matchedPattern})`);
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
      let redactionSummary: { redacted: boolean; findings: Array<{ ruleId: string; line: number; message: string }> } = {
        redacted: false,
        findings: [],
      };
      try {
        const scanResult = await scanAndRedact(filePath, content);
        if (scanResult.status === 'redacted') {
          workingContent = scanResult.redactedContent;
          redactionSummary = { redacted: true, findings: scanResult.findings };
          console.warn(
            `[Codex] Redacted ${scanResult.findings.length} secret(s) in ${filePath}: ` +
            scanResult.findings.map(f => `line ${f.line} (${f.ruleId})`).join(', ')
          );
        }
      } catch (scanErr: any) {
        // Fail-closed: if the scanner errors, skip the file rather than risk leaking.
        console.error(`[Codex] Secret scan failed for ${filePath} — skipping file:`, scanErr?.message || scanErr);
        return res.status(200).json({
          success: false,
          skipped: true,
          reason: 'secret_scan_error',
          filePath,
          message: 'Secret scan failed; file was not indexed out of an abundance of caution.',
        });
      }

      // Detect file metadata
      const { fileType, extension, language } = detectFileType(filePath);
      const finalLanguage = providedLanguage || language;
      const contentHash = generateContentHash(workingContent);
      const fileName = filePath.split('/').pop() || filePath;

      // ================================================================
      // PART 1: Original cb_sources → cb_artifacts → cb_chunks pipeline
      // ================================================================

      // 1. Find/Create Source (VS Code / Local) for this project
      const sourceExternalId = `vscode-local-${projectId}`;
      
      let { data: source } = await supabase
        .from('cb_sources')
        .select('id')
        .eq('project_id', projectId)
        .eq('external_id', sourceExternalId)
        .single();

      if (!source) {
        const { data: newSource, error: sourceError } = await supabase
          .from('cb_sources')
          .insert({
            project_id: projectId,
            provider: 'codex',
            source_kind: 'repo',
            name: 'VS Code / Local',
            external_id: sourceExternalId,
            metadata: { origin: 'vscode-extension' }
          })
          .select()
          .single();
        
        if (sourceError) throw new Error(`Failed to create source: ${sourceError.message}`);
        source = newSource;
      }

      // 2. Find/Create Artifact (The File)
      let { data: artifact } = await supabase
        .from('cb_artifacts')
        .select('id')
        .eq('source_id', source!.id)
        .eq('key', filePath)
        .single();

      if (!artifact) {
        const { data: newArtifact, error: artError } = await supabase
          .from('cb_artifacts')
          .insert({
            project_id: projectId,
            source_id: source!.id,
            artifact_kind: 'file',
            title: fileName,
            key: filePath,
            metadata: { language: finalLanguage, file_path: filePath }
          })
          .select()
          .single();

        if (artError) throw new Error(`Failed to create artifact: ${artError.message}`);
        artifact = newArtifact;
      } else {
        await supabase
          .from('cb_artifacts')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', artifact.id);
      }

      // 3. Chunk, Batch-Embed, and prepare for insert
      const textChunks = chunkText(workingContent);
      const chunksToInsert = [];

      if (!artifact) {
        throw new Error('Artifact not found or created');
      }

      // Delete existing chunks for this artifact
      await supabase.from('cb_chunks').delete().eq('artifact_id', artifact.id);

      // Batch-embed all chunks in one (or a few) OpenAI requests
      const chunkTexts = textChunks.map(c => c.text);
      let embeddings: number[][] = [];
      try {
        embeddings = await embedBatch(chunkTexts);
      } catch (embErr: any) {
        console.warn(`[codex-ingestion] embedBatch failed for ${filePath}:`, embErr.message);
        embeddings = chunkTexts.map(() => []);
      }

      for (let i = 0; i < textChunks.length; i++) {
        const chunk = textChunks[i];
        const emb = embeddings[i];
        chunksToInsert.push({
          project_id: projectId,
          source_id: source!.id,
          artifact_id: artifact.id,
          provider: 'codex',
          chunk_kind: 'code',
          text: chunk.text,
          start_line: chunk.startLine,
          end_line: chunk.endLine,
          metadata: {
            file_path: filePath,
            language: finalLanguage
          },
          embedding: emb && emb.length > 0 ? emb : null
        });
      }

      // 4. Batch Insert Chunks
      if (chunksToInsert.length > 0) {
        const { error: chunkError } = await supabase
          .from('cb_chunks')
          .insert(chunksToInsert);
        
        if (chunkError) throw new Error(`Failed to insert chunks: ${chunkError.message}`);
      }

      // ================================================================
      // PART 2: DUAL-WRITE to cb_files → cb_file_embeddings
      // This makes Codex files visible to the semantic retriever!
      // ================================================================

      console.log(`[Codex] Dual-write to cb_files: ${filePath}`);

      // 5. Find or Create cb_files record
      // Use filePath as unique key (via content_sha for deduplication)
      let { data: existingFile } = await supabase
        .from('cb_files')
        .select('id, content_sha')
        .eq('project_id', projectId)
        .eq('file_name', filePath)
        .single();

      let cbFileId: string;

      if (!existingFile) {
        // Create new cb_files record
        const { data: newFile, error: fileError } = await supabase
          .from('cb_files')
          .insert({
            project_id: projectId,
            file_name: filePath,  // Use full path as file_name for uniqueness
            file_type: fileType,
            file_extension: extension,
            language: finalLanguage,
            content: workingContent,
            content_sha: contentHash,
            content_tokens: Math.ceil(workingContent.length / 4), // Rough estimate
            importance_score: 0.7, // Default importance for source files
          })
          .select('id')
          .single();

        if (fileError) {
          console.error(`[Codex] Failed to create cb_files record:`, fileError);
          // Don't throw - cb_chunks was already saved, this is enhancement
        } else {
          cbFileId = newFile!.id;
          console.log(`[Codex] Created cb_files record: ${cbFileId}`);
        }
      } else if (existingFile.content_sha !== contentHash) {
        // Content changed - update existing record
        const { error: updateError } = await supabase
          .from('cb_files')
          .update({
            content: workingContent,
            content_sha: contentHash,
            content_tokens: Math.ceil(workingContent.length / 4),
            // Note: This will trigger tsvector update via DB trigger if you have one
          })
          .eq('id', existingFile.id);

        if (updateError) {
          console.error(`[Codex] Failed to update cb_files record:`, updateError);
        } else {
          console.log(`[Codex] Updated cb_files record: ${existingFile.id}`);
        }
        cbFileId = existingFile.id;
      } else {
        // Content unchanged
        console.log(`[Codex] cb_files record unchanged: ${existingFile.id}`);
        cbFileId = existingFile.id;
      }

      // 6. Create/Update cb_file_embeddings record
      // Generate a FULL-FILE embedding (different from chunk embeddings)
      if (cbFileId!) {
        try {
          const embeddingService = getEmbeddingService();
          // ============================================================
          // DENSIFICATION: Prepare content for better semantic signal
          // - Code files: Strip imports, licenses, boilerplate
          // - Document files: Preserve text, add metadata header
          // ============================================================
          const denseContent = prepareContentForEmbedding(filePath, workingContent, fileType);
          
          // Truncate AFTER densification (more meaningful content fits)
          const maxEmbedChars = 32000; // ~8k tokens
          const textForEmbedding = denseContent.length > maxEmbedChars 
            ? denseContent.substring(0, maxEmbedChars) 
            : denseContent;

          console.log(`[Codex] Densified ${filePath}: ${workingContent.length} → ${denseContent.length} chars (${Math.round((1 - denseContent.length/workingContent.length) * 100)}% reduction)`);

          const { embedding, model, dimensions } = await embeddingService.generateEmbedding(textForEmbedding);

          // Check if embedding already exists
          const { data: existingEmbed } = await supabase
            .from('cb_file_embeddings')
            .select('cb_file_id')
            .eq('cb_file_id', cbFileId)
            .single();

          if (!existingEmbed) {
            // Insert new embedding
            const { error: embedError } = await supabase
              .from('cb_file_embeddings')
              .insert({
                cb_file_id: cbFileId,
                project_id: projectId,
                path_hint: filePath,  // Store the full path!
                embedding: embedding,
                embedding_model: model,
                embedding_dimensions: dimensions,
                status: 'success',
              });

            if (embedError) {
              console.error(`[Codex] Failed to create cb_file_embeddings:`, embedError);
            } else {
              console.log(`[Codex] Created embedding for: ${filePath}`);
            }
          } else {
            // Update existing embedding
            const { error: embedUpdateError } = await supabase
              .from('cb_file_embeddings')
              .update({
                path_hint: filePath,
                embedding: embedding,
                embedding_model: model,
                embedding_dimensions: dimensions,
                status: 'success',
                last_attempted_at: new Date().toISOString(),
              })
              .eq('cb_file_id', cbFileId);

            if (embedUpdateError) {
              console.error(`[Codex] Failed to update cb_file_embeddings:`, embedUpdateError);
            } else {
              console.log(`[Codex] Updated embedding for: ${filePath}`);
            }
          }
        } catch (embedErr) {
          console.error(`[Codex] Embedding generation failed for cb_files:`, embedErr);
          // Don't throw - main sync succeeded
        }
      }

      console.log(`[Codex] ✅ Synced ${filePath} (${chunksToInsert.length} chunks + cb_files dual-write)`);
      
      return res.json({ 
        success: true, 
        file: filePath, 
        chunks: chunksToInsert.length,
        dualWrite: !!cbFileId!,
        redaction: redactionSummary,
      });

    } catch (error: any) {
      console.error('[Codex] Sync error:', error);
      return res.status(500).json({ error: error.message });
    }
  });

  return router;
}