import { Router, type Request, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';

type MsgRow = {
  id: string;
  conversation_id: string;
  project_id: string;
  content: string | null;
  created_at: string | null;
};

const FENCE_RE = /```(\w+)?\s*?\n([\s\S]*?)\n```/g;
const FILE_HINT_RE = /(file|path|source)\s*:\s*([^\s]+content-simple\.js|[^\s]+?\.[a-z0-9]+)\b/i;

function guessFileName(msg: string, lang?: string) {
  const hint = FILE_HINT_RE.exec(msg);
  if (hint?.[2]) return hint[2].replace(/^["'<]+|["'>]+$/g, '');
  // fallback synthetic name when no hint
  const ext = langExt(lang);
  return `msg_block_${Date.now()}.${ext}`;
}

function langExt(lang?: string) {
  const m = (lang || '').toLowerCase();
  if (m === 'ts' || m === 'typescript') return 'ts';
  if (m === 'js' || m === 'javascript') return 'js';
  if (m === 'json') return 'json';
  if (m === 'py' || m === 'python') return 'py';
  if (m === 'css') return 'css';
  if (m === 'html') return 'html';
  if (m === 'sql') return 'sql';
  return 'txt';
}

export function createBackfillRoutes(supabase: SupabaseClient) {
  const router = Router();

  // POST /api/tools/backfill/files-from-messages
  router.post('/tools/backfill/files-from-messages', async (req: Request, res: Response) => {
    try {
      const projectId: string = req.body?.projectId;
      if (!projectId) return res.status(400).json({ error: 'projectId required' });

      // 1) Pull candidate messages that likely include code fences
      const { data: msgs, error } = await supabase
        .from('cb_messages')
        .select('id, conversation_id, project_id, content, created_at')
        .eq('project_id', projectId)
        .ilike('content', '%```%')
        .limit(5000); // cap to be safe

      if (error) throw error;
      const rows = (msgs ?? []) as MsgRow[];
      let inserted = 0, skipped = 0;

      // 2) Parse & upsert
      for (const m of rows) {
        const text = m.content || '';
        if (!text.includes('```')) { skipped++; continue; }

        FENCE_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = FENCE_RE.exec(text)) !== null) {
          const lang = (match[1] || '').trim();
          const code = match[2] || '';
          if (!code.trim()) continue;

          const fileName = guessFileName(text, lang);
          const fileType = ['js','ts','py','java','cpp','c','cs','go','rs','html','css','json','yml','yaml','sql'].includes(langExt(lang))
            ? 'code'
            : 'text';

          const sha = crypto.createHash('sha256').update(code).digest('hex');
          const tokens = Math.ceil(code.length / 4);

          const { error: upErr } = await supabase.from('cb_files').upsert({
            conversation_id: m.conversation_id,
            project_id: m.project_id,
            file_name: fileName,                   // if the hint contained a full path, keep it
            file_type: fileType,
            file_extension: langExt(lang),
            language: lang || null,
            content: code,
            content_sha: sha,
            content_tokens: tokens,
            created_at: m.created_at || new Date().toISOString(),
          }, { onConflict: 'conversation_id,content_sha' });

          if (upErr) {
            // continue; don’t break the whole job
            console.warn('[backfill] upsert error for', fileName, upErr.message);
            skipped++;
          } else {
            inserted++;
          }
        }
      }

      return res.json({ ok: true, scanned: rows.length, inserted, skipped });
    } catch (e: any) {
      console.error('[backfill] error:', e);
      return res.status(500).json({ error: e?.message || 'backfill failed' });
    }
  });

  return router;
}
