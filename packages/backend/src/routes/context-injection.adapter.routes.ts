// packages/backend/src/routes/context-injection.adapter.routes.ts
import type { Express, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

interface InjectCard {
  id: string;
  kind: 'message';
  title: string;
  snippet: string;
  pasteText: string;
  scores: {
    semantic: number | null;
    keyword: number | null;
    entity: number | null;
    overall: number | null;
  };
  source: {
    conversation_id: string | null;
    message_id: string | null;
    file_id: string | null;
    block_id: string | null;
    url: string | null;
  };
}

const estTokens = (s: string) => Math.max(1, Math.ceil((s || '').length / 4));

function splitSentences(text: string): string[] {
  try {
    // @ts-ignore
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      // @ts-ignore
      const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
      return Array.from(seg.segment(text), (x: any) => String(x.segment || '').trim()).filter(Boolean);
    }
  } catch {}
  return (text || '')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'\(])/)
    .map(s => s.trim())
    .filter(Boolean);
}

function termsFromQuery(q: string): string[] {
  return (String(q).toLowerCase().match(/[a-z0-9_]+/g) || [])
    .filter(w => !['the','and','or','to','of','for','a','an','in','on','with','by','is','are'].includes(w));
}

function snippetFromMessage(full: string, q: string, windowSentences = 2): string {
  const sentences = splitSentences(full);
  const terms = termsFromQuery(q);
  for (let i = 0; i < sentences.length; i++) {
    const sent = sentences[i].toLowerCase();
    if (terms.some(t => sent.includes(t))) {
      const start = Math.max(0, i - windowSentences);
      const end = Math.min(sentences.length, i + windowSentences + 1);
      return sentences.slice(start, end).join(' ').trim();
    }
  }
  // fall back to first 3 sentences
  return sentences.slice(0, Math.min(3, sentences.length)).join(' ').trim();
}

function findLineMatch(text: string, q: string): number {
  const terms = termsFromQuery(q);
  const lines = (text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (terms.some(t => l.includes(t))) return i;
  }
  return 0;
}

function linesAround(text: string, lineIdx: number, radius = 4) {
  const lines = (text || '').split(/\r?\n/);
  const start = Math.max(0, lineIdx - radius);
  const end = Math.min(lines.length, lineIdx + radius + 1);
  return { snippet: lines.slice(start, end).join('\n'), start, end, total: lines.length };
}

function looksLikeIdentifier(q: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(q).trim());
}

function findFunctionRegion(text: string, ident: string): string | null {
  const re = new RegExp(`(^|\\n).*${ident}.*\\{`, 'i');
  const m = text.match(re);
  if (!m) return null;
  const startIdx = m.index ?? 0;
  let i = text.indexOf('{', startIdx);
  if (i === -1) return null;
  let depth = 1;
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth === 0) return text.slice(startIdx, j + 1);
  }
  return null;
}

// ---------------------- endpoint ----------------------

export function registerContextInjectionRoutes_Prepare(app: Express) {
  app.post('/api/context/inject/prepare', async (req: Request, res: Response) => {
    console.log('[prepare] content-type:', req.headers['content-type'], 'body=', req.body);
    try {
      const {
        projectId,
        q,
        limit = 50,               // cap on candidates we’ll examine
        overridePrefs = null      // optional override object from the client
      } = req.body || {};

      if (!projectId || !q) {
        return res.status(400).json({ error: 'projectId and q are required' });
      }

      // 1) Read per-project prefs (Step 6 table); fall back to defaults
      const db: any = req.app.get('db');
      let prefs: any = {
        maxTokens: 800,
        msgWindowSentences: 2,
        fileWindowLines: 4,
        snippetFullThreshold: 0.85,
        fileFullThreshold: 0.90,
        multiSnippetMax: 3,
        sort: 'recency_then_score',
        badgeThresholds: { high: 0.80, medium: 0.50 },
        astExtraction: true,
        mdSectionExtraction: true,
        jsonCsvContext: true
      };
      if (db?.query) {
        const { rows } = await db.query(
          'select settings from public.cb_injection_prefs where project_id = $1',
          [projectId]
        );
        if (rows?.[0]?.settings) prefs = { ...prefs, ...rows[0].settings };
      }
      if (overridePrefs && typeof overridePrefs === 'object') {
        prefs = { ...prefs, ...overridePrefs };
      }

      // 2) Call your hybrid search (same as dashboard)
      const analyzeUrl = `${req.protocol}://${req.get('host')}/api/context/analyze-v2`;
      const r = await fetch(analyzeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ message: q, projectId })
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        return res.status(502).json({ error: 'analyze-v2 failed', detail });
      }
      const data = await r.json() as { results?: Array<any>; searchMethods?: any };

      // 3) Flatten candidates
      type Cand = { kind:'message'|'file'|'block'; id:string; conversation_id:string|null; title:string;
        created_at:string|null; content:string; score:number|null };

      const candidates: Cand[] = [];
      const nowIso = new Date().toISOString();
      const firstLine = (s: string) => String(s || '').split(/\r?\n/).find(Boolean) || '';

      if (Array.isArray(data?.results)) {
        for (const conv of data.results) {
          const convId = conv.conversation_id ?? null;
          for (const m of (conv.items || [])) {
            const title =
              conv.title ||
              conv.conversation_title ||
              conv.name ||
              conv.summary ||
              firstLine(m?.content) ||    // <-- use message content as last resort
              'Untitled';

            candidates.push({
              kind: 'message',
              id: String(m.id),
              conversation_id: convId,
              title,
              created_at: m.created_at ?? nowIso,
              content: m.content || '',
              score: typeof m.score === 'number' ? m.score : null
            });
          }
        }
      }

      // 4) Sort: recency → score (to match dashboard expectations)
      candidates.sort((a, b) => {
        if (prefs.sort === 'recency_then_score') {
          const ta = a.created_at ? Date.parse(a.created_at) : 0;
          const tb = b.created_at ? Date.parse(b.created_at) : 0;
          if (tb !== ta) return tb - ta;
          return (b.score ?? 0) - (a.score ?? 0);
        } else {
          const ds = (b.score ?? 0) - (a.score ?? 0);
          if (ds !== 0) return ds;
          const ta = a.created_at ? Date.parse(a.created_at) : 0;
          const tb = b.created_at ? Date.parse(b.created_at) : 0;
          return tb - ta;
        }
      });

      // 5) Build snippets under token budget
      const MAX_TOKENS: number = Number(prefs.maxTokens) || 800;
      let budget = MAX_TOKENS;
      const items: any[] = [];
      const ident = looksLikeIdentifier(q) ? q.trim() : '';

      for (const c of candidates.slice(0, limit)) {
        let unit: 'snippet'|'full'|'multisnippet' = 'snippet';
        let text = '';
        const score = c.score ?? 0;

        if (c.kind === 'message') {
          const isShort = estTokens(c.content) <= 120;
          const isHigh = score >= Number(prefs.snippetFullThreshold || 0.85);
          if (isShort || isHigh) {
            unit = 'full';
            text = String(c.content || '').trim();
          } else {
            text = snippetFromMessage(String(c.content || ''), q, Number(prefs.msgWindowSentences || 2));
          }
        } else if (c.kind === 'file' || c.kind === 'block') {
          const t = String(c.content || '');
          if (ident) {
            const region = findFunctionRegion(t, ident);
            if (region) text = region.trim();
          }
          if (!text) {
            const li = findLineMatch(t, q);
            const around = linesAround(t, li, Number(prefs.fileWindowLines || 4));
            text = around.snippet.trim();
          }
        }

        let tokenEstimate = estTokens(text);
        if (!text || tokenEstimate > budget) continue;

        budget -= tokenEstimate;
        items.push({
          id: c.id,
          kind: c.kind,
          conversation_id: c.conversation_id,
          title: c.title,
          created_at: c.created_at,
          score: c.score,
          unit,
          snippet: text,
          tokenEstimate
        });

        if (budget <= 0) break;
      }

      // 6) Build final paste block with scannable headers + attribution
      const pasteParts: string[] = [];
      for (const p of items) {
        const when = p.created_at ? new Date(p.created_at).toISOString().replace('T',' ').slice(0,16) : '';
        pasteParts.push(
          `📎 ${p.title} · ${when} · ${p.kind}/${p.id}`,
          p.snippet.trim(),
          `— source: ${p.kind}/${p.id}`,
          ``
        );
      }
      const pasteBlock = pasteParts.join('\n');

      res.json({
        q,
        prefs: {
          maxTokens: MAX_TOKENS,
          msgWindowSentences: prefs.msgWindowSentences,
          fileWindowLines: prefs.fileWindowLines,
          thresholds: {
            snippetFull: prefs.snippetFullThreshold,
            fileFull: prefs.fileFullThreshold
          }
        },
        totalCandidates: candidates.length,
        selectedCount: items.length,
        items,
        pasteBlock,
        tokenEstimate: estTokens(pasteBlock),
        searchMethods: data?.searchMethods ?? null   // optional: carry through for UI counters
      });
    } catch (err: any) {
      res.status(500).json({ error: 'prepare error', detail: err?.message || String(err) });
    }
  });
}

/**
 * Lightweight adapter that proxies to analyze-v2 and normalizes to "cards".
 * No DB writes; purely transforms for the extension panel.
 */
export function registerContextInjectionSearch(app: Express) {
  app.get('/api/context/inject/search', async (req: Request, res: Response) => {
    try {
      // 1. Handle Multiple Projects (Array or String)
      // Supports ?projectId=A&projectId=B format from frontend
      let projectIds: string[] = [];
      const pParam = req.query.projectId;
      
      if (Array.isArray(pParam)) {
        projectIds = pParam.map(String);
      } else if (typeof pParam === 'string' && pParam) {
        projectIds = [pParam];
      }

      const q = String(req.query.q || '');
      const limit = Number(req.query.limit ?? 25);

      if (projectIds.length === 0 || !q) {
        return res.status(400).json({ error: 'projectId and q are required' });
      }

      // 2. Call analyze-v2
      const analyzeUrl = `${req.protocol}://${req.get('host')}/api/context/analyze-v2`;
      
      // Construct payload with projectIds
      const payload: any = { 
        message: q, 
        limit,
        projectIds: projectIds // analyze-v2 supports this
      };

      const r = await fetch(analyzeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        return res.status(502).json({ error: 'analyze-v2 failed', detail });
      }
      const data = await r.json() as {
        results?: Array<any>;
        codex?: Array<any>;
        searchMethods?: any;
      };

      // 3. Normalize Results
      const results: Array<any> = [];
      
      // A. Process Conversations
      if (Array.isArray(data?.results)) {
        const firstLine = (s: string) => String(s || '').split(/\r?\n/).find(Boolean) || '';

        for (const conv of data.results) {
          for (const m of (conv.items || [])) {
            const convTitle =
              conv.title ||
              conv.conversation_title ||
              conv.name ||
              conv.summary ||
              firstLine(m?.content) ||
              'Untitled';

            const card = {
              id: m.id || crypto.randomUUID(),
              kind: 'message',
              title: convTitle,
              snippet: String(m.content || '').slice(0, 1200),
              scores: {
                semantic: m.scores?.semantic ?? null,
                keyword:  m.scores?.keyword  ?? null,
                entity:   m.scores?.entity   ?? null,
                overall:  m.score ?? m.scores?.overall ?? null
              },
              source: {
                conversation_id: conv.conversation_id ?? null,
                message_id: m.id ?? null,
                file_id: null,
                block_id: null,
                url: conv.url ?? null
              }
            };
            results.push(card);
          }
        }
      }

      // B. Process Codex Results (NEW)
      if (Array.isArray(data?.codex)) {
        for (const c of data.codex) {
          // Map Codex item to Card
          const card = {
            id: c.chunkId || crypto.randomUUID(),
            kind: 'codex', // Explicit kind for UI distinction
            title: c.filePath || 'Unknown file',
            snippet: c.snippet || '',
            scores: {
              semantic: null,
              keyword: null,
              entity: null,
              // Fallback score if not provided
              overall: c.score ?? 0.85 
            },
            source: {
              conversation_id: null,
              message_id: null,
              file_id: c.sourceId || null,
              block_id: c.chunkId || null,
              url: null, // In future: vscode://...
              project_id: c.projectId // Pass project ID for UI context
            },
            metadata: {
              startLine: c.startLine,
              endLine: c.endLine,
              provider: c.provider
            }
          };
          results.push(card);
        }
      }

      // 4. Sort and Limit
      // Interleave results by score
      results.sort((a, b) => (b.scores.overall ?? 0) - (a.scores.overall ?? 0));

      res.json({
        q,
        count: Math.min(results.length, limit),
        results: results.slice(0, limit),
        searchMethods: data?.searchMethods ?? null
      });
    } catch (err: any) {
      res.status(500).json({ error: 'search adapter error', detail: err?.message || String(err) });
    }
  });
}

 export function registerContextInjectionLogging(app: Express, supabase: SupabaseClient) {
  app.post('/api/context/inject/log', async (req: Request, res: Response) => {
    try {
      const {
        projectId,
        targetProvider = 'claude',
        targetChatId = null,
        targetChatUrl = null,
        snippet,
        snippetType = 'message',
        source = {},           // { conversation_id, message_id, file_id, block_id, url? }
        sourceMethod = 'hybrid',
        sourceScore = null,
        events = []            // [{event_type, rating?, details?}]
      } = req.body || {};

      if (!projectId || !snippet) {
        return res.status(400).json({ error: 'projectId and snippet are required' });
      }

      // 1) Insert injection
      const insertPayload: any = {
        project_id: projectId,
        target_provider: targetProvider,
        target_chat_id: targetChatId,
        target_chat_url: targetChatUrl,
        snippet,
        snippet_type: snippetType,
        source_conversation_id: source.conversation_id ?? null,
        source_message_id:     source.message_id ?? null,
        source_file_id:        source.file_id ?? null,
        source_block_id:       source.block_id ?? null,
        source_method: sourceMethod,
        source_score: sourceScore,
        created_by: 'extension'
      };

      const { data: inj, error: injErr } = await supabase
        .from('cb_context_injections')
        .insert(insertPayload)
        .select('id')
        .single();

      if (injErr) {
        return res.status(500).json({ error: 'injection insert failed', detail: injErr.message });
      }
      const injectionId = inj?.id;

      // 2) Insert events (if any)
      if (Array.isArray(events) && events.length) {
        const evRows = events.map((ev: any) => ({
          injection_id: injectionId,
          event_type: ev.event_type,
          rating: ev.rating ?? null,
          details: ev.details ?? null
        }));

        const { error: evErr } = await supabase
          .from('cb_context_injection_events')
          .insert(evRows);

        if (evErr) {
          return res.status(500).json({ error: 'event insert failed', detail: evErr.message });
        }
      }

      res.json({ ok: true, injectionId });
    } catch (err: any) {
      console.error('❌ [Inject Log] Error details:', err);
      res.status(500).json({
        error: 'inject log error',
        detail: err?.message || String(err)
      });
    }
  });
}