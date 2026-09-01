// packages/backend/src/routes/auto-context.routes.ts
import { Router, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

function buildFileTree(paths: string[]): string {
  const lines: string[] = [];
  const sorted = paths.sort();

  for (const path of sorted) {
    const parts = path.split('/');
    const depth = parts.length - 1;
    const indent = '  '.repeat(depth);
    const name = parts[parts.length - 1];
    lines.push(`${indent}${name}`);
  }

  return lines.join('\n');
}

export function createAutoContextRoutes(supabase: SupabaseClient) {
  const router = Router();

  /**
   * POST /api/agent/auto-context
   * Detects questions/context needs in an AI message, searches ContextBridge
   * for answers, and returns a structured Q&A block for injection.
   * Body: { messageText: string, projectId: string }
   */
  router.post('/agent/auto-context', async (req: Request, res: Response) => {
    try {
      const { messageText, projectId, projectIds: projectIdsRaw, platformProjectId } = req.body;

      let projectIds: string[] = projectIdsRaw?.length
        ? projectIdsRaw
        : projectId ? [projectId] : [];

      // If a platform project ID was sent, resolve it to the ContextBridge project ID
      if (platformProjectId) {
        const { data: matched } = await supabase
          .from('cb_projects')
          .select('id')
          .eq('provider_project_id', platformProjectId)
          .limit(1)
          .single();
        if (matched?.id) {
          console.log(`[auto-context] Resolved platformProjectId ${platformProjectId} → ${matched.id}`);
          projectIds = [matched.id];
        } else {
          console.log(`[auto-context] platformProjectId ${platformProjectId} not found in cb_projects — using stored projectIds`);
        }
      }

      if (!messageText || !projectIds.length) {
        return res.status(400).json({ error: 'messageText and projectId/projectIds are required' });
      }

      console.log(`\n🤖 Auto-context: analyzing message for projects ${projectIds.join(', ')}`);

      // ── Step 1: Use Claude to detect & extract questions/context needs ──
      const detectionPrompt = `You are an assistant that analyzes AI responses to detect requests for information from the user.

Analyze the following AI message and extract EVERY instance where the AI is asking for, requesting, or expressing a need for information from the user — whether phrased as a direct question, an imperative, or a declarative need statement ("What I need is...", "To continue I need...", "Please send...").

For each item found, classify its intent as one of these four types:

- "context": answerable from a knowledge base of past conversations and codebase files. Examples:
  - "Which file handles X?" → the file exists in the codebase
  - "Does the VS Code extension have token refresh logic?" → code exists to check
  - "What does function X do?" → answerable from code or past conversations

- "situational": about the user's CURRENT runtime state, environment, or a problem they are actively experiencing RIGHT NOW. These CANNOT be answered from any knowledge base. Examples:
  - "What exactly fails when you run X?"
  - "When did it last work?"
  - "Which API URL is the extension currently pointing to?"
  - "Does the sign-in command succeed or fail?"
  - "What error message do you see?"
  - "Are you testing against production or localhost?"

- "preference": requires the user's personal opinion or a new decision not yet recorded. Examples:
  - "Which approach do you prefer?"
  - "Do you want to use X or Y?"

- "clarification": genuinely ambiguous — could be answered from context OR could be situational

- "file_request": the AI is explicitly requesting the contents of a specific named file. Examples:
  - "Can you paste the content of package.json?"
  - "Share the main entry file"
  - "What's in extension.ts?"
  - "Paste your tsconfig.json"
  - - "What I need is: \`package.json\`, \`train.py\`"
  - "The next step requires seeing \`loop.py\`"
  - "If you send \`student.yaml\` I can..."
  - "To continue I need the following files:"
  - "If you send \`student.yaml\` I can..."
  Rephrase as just the filename or partial path (e.g. "package.json", "extension.ts", "vscode-extension/package.json")

- "directory_listing": the AI is asking for a directory structure, file tree, or list of files in the project or a subfolder. Examples:
  - "Run Get-ChildItem and paste the output"
  - "Show me the folder structure"
  - "What files are in packages/vscode-extension?"
  - "Give me a tree of the project"
  - "What files are in the chrome extension source folder?" → packages/chrome-extension
  - "Show me the VS Code extension files" → packages/vscode-extension
  - "What's in the backend routes?" → packages/backend/src/routes
  For "conversational_query": rephrase as a plain question.
  For "technical_identifiers": output the actual monorepo folder path (e.g. "packages/chrome-extension", "packages/backend/src/routes"), or "all" if the whole project is requested. Never output natural language — only a path.

- "schema_query": the AI is asking about database table structure, row counts, or whether a specific file/record exists. Examples:
  - "What columns does cb_sources have?"
  - "Show me the cb_artifacts table schema"
  - "How many chunks are in the database?"
  - "Does packages/backend/src/routes/codex.routes.ts exist in the index?"
  Rephrase as one of: "schema:[tablename]", "count:[tablename]", or "exists:[filepath]"

Rules:
- Be conservative — if there is ANY chance the question is about current runtime behavior, errors, or live environment state, classify as "situational"
- Only classify as "context" if the answer plausibly exists in a codebase or past conversation
- Rephrase each "context" item as a concise search query (5-15 words) optimized for knowledge base search
- For "situational", "preference", and "clarification" items, rephrase as a plain question
- If there are no requests at all, return hasQuestions: false
- For "file_request", if the request targets a specific section (e.g. "the save loop", "the auth handler", "around line X"), populate "anchor" with the most distinctive text fragment from that section that would appear verbatim in the file
- Return ONLY valid JSON, no preamble or markdown

Return this exact JSON structure:
{
  "hasQuestions": true | false,
  "queries": [
    {
      "conversational_query": "natural language question optimized for semantic search",
      "technical_identifiers": "exact identifiers function names file paths keywords",
      "intent": "context" | "situational" | "preference" | "clarification" | "file_request" | "directory_listing" | "schema_query",
      "anchor": "exact text fragment identifying the requested section (only for file_request when a specific section is asked for, otherwise omit)"
    }
  ]
}

For "conversational_query": preserve natural language intent and question structure.
For "technical_identifiers": extract only exact-match tokens — CamelCase/snake_case identifiers, file names, extensions, paths, error codes. Strip all stop words and conversational filler. Leave empty string if no hard identifiers exist.

AI message to analyze:
<message>
${messageText}
</message>`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const detectionResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 500,
          messages: [{ role: 'user', content: detectionPrompt }]
        })
      });

      clearTimeout(timeout);

      if (!detectionResponse.ok) {
        const errText = await detectionResponse.text().catch(() => '');
        return res.status(502).json({ error: 'Claude detection API error', detail: errText });
      }

      const detectionData = await detectionResponse.json() as {
        content?: Array<{ type: string; text: string }>
      };

      const rawText = detectionData.content?.find(b => b.type === 'text')?.text || '';

      let parsed: { hasQuestions: boolean; queries: Array<{ conversational_query: string; technical_identifiers: string; intent: string; anchor?: string }> };
      try {
        const clean = rawText.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(clean);
      } catch {
        console.warn('[auto-context] Failed to parse detection response:', rawText);
        return res.json({ ok: true, hasQuestions: false, qaBlock: '', questions: [], answers: [] });
      }

      if (!parsed.hasQuestions || !parsed.queries?.length) {
        console.log('[auto-context] No questions detected');
        return res.json({ ok: true, hasQuestions: false, qaBlock: '', questions: [], answers: [] });
      }

      // Filter to only context/clarification questions
      const searchableQueries = parsed.queries.filter(
        q => q.intent === 'context' 
          || q.intent === 'clarification' 
          || q.intent === 'file_request'
          || q.intent === 'directory_listing'
          || q.intent === 'schema_query'
      );
      console.log(`[auto-context] Detected ${parsed.queries.length} queries, ${searchableQueries.length} searchable`);
      console.log(`[auto-context] Intents:`, parsed.queries.map(q => `${q.intent}: ${q.conversational_query} | identifiers: "${q.technical_identifiers}"`));

      if (!searchableQueries.length) {
        console.log('[auto-context] All questions are preference-type, skipping');
        return res.json({ ok: true, hasQuestions: false, qaBlock: '', questions: [], answers: [] });
      }

      // ── Step 2: Search ContextBridge for each searchable query ──
      const base = `http://localhost:${process.env.PORT || 3001}`;
      const searchUrl = `${base}/api/agent/search-tiered`;

      const qaItems: Array<{ question: string; answer: string }> = [];

      const results = await Promise.all(searchableQueries.map(async (item) => {
        try {
          // ── File request fast-path: fetch directly from Codex by filename ──
          if (item.intent === 'file_request') {
            const { data: artifacts, error: artifactError } = await supabase
              .from('cb_artifacts')
              .select('id, key, project_id')
              .in('project_id', projectIds)
              .ilike('key', `%${item.technical_identifiers || item.conversational_query}%`)
              .is('deleted_at', null)
              .limit(3);

            if (!artifactError && artifacts?.length) {
              const artifact = artifacts[0];
              const fileUrl = `${base}/api/codex/file-content?projectId=${encodeURIComponent(artifact.project_id)}&filePath=${encodeURIComponent(artifact.key)}`;

              const fileController = new AbortController();
              const fileTimeout = setTimeout(() => fileController.abort(), 10000);

              const fileResponse = await fetch(fileUrl, {
                signal: fileController.signal,
                headers: { 'Authorization': req.headers['authorization'] || '' }
              });
              clearTimeout(fileTimeout);

              if (fileResponse.ok) {
                const fileData = await fileResponse.json() as { content?: string; filePath?: string };
                if (fileData.content && fileData.content.length > 0) {
                  const MAX_FILE_CHARS = 300000;
                  const truncated = fileData.content.length > MAX_FILE_CHARS
                    ? fileData.content.slice(0, MAX_FILE_CHARS) + '\n\n[... file truncated — remaining content available on request]'
                    : fileData.content;
                  console.log(`[auto-context] ✅ File fast-path: ${fileData.filePath}`);

                  // If anchor provided, extract ±30 lines around it
                  if (item.anchor && item.anchor.length > 0) {
                    const lines = fileData.content!.split('\n');
                    const anchorIdx = lines.findIndex(l => l.includes(item.anchor!));
                    if (anchorIdx !== -1) {
                      const start = Math.max(0, anchorIdx - 30);
                      const end = Math.min(lines.length, anchorIdx + 31);
                      const section = lines.slice(start, end).join('\n');
                      const safeSection = section.replace(/```/g, '``\u200B`');
                      console.log(`[auto-context] ✅ Anchor found at line ${anchorIdx}, returning lines ${start}-${end}`);
                      return {
                        question: item.technical_identifiers || item.conversational_query,
                        answer: `Here is the relevant section of \`${fileData.filePath}\` (lines ${start + 1}–${end}):\n\`\`\`\n${safeSection}\n\`\`\`\n\n*Auto-Context extracted ~61 lines around \`${item.anchor}\`. Do you need to see more?*`
                      };
                    }
                    console.log(`[auto-context] Anchor not found in file, returning full file`);
                  }

                  return {
                    question: item.technical_identifiers || item.conversational_query,
                    answer: `Here is the content of \`${fileData.filePath}\`:\n\`\`\`\n${truncated}\n\`\`\``
                  };
                }
              }
            }
            // If file not found in Codex, fall through to normal search
          }

          // ── Directory listing fast-path ──
          if (item.intent === 'directory_listing') {
            const lookupValue = item.technical_identifiers || item.conversational_query;
            const prefix = lookupValue === 'all' ? '' : lookupValue;

            const { data: artifacts, error } = await supabase
              .from('cb_artifacts')
              .select('key')
              .in('project_id', projectIds)
              .is('deleted_at', null)
              .ilike('key', prefix ? `${prefix}%` : '%')
              .order('key', { ascending: true })
              .limit(500);

            if (!error && artifacts?.length) {
              const tree = buildFileTree(artifacts.map((a: any) => a.key));
              console.log(`[auto-context] ✅ Directory listing: ${artifacts.length} files`);
              return {
                question: item.technical_identifiers || item.conversational_query,
                answer: `Project file structure${prefix ? ` (${prefix})` : ''}:\n\`\`\`\n${tree}\n\`\`\``
              };
            }
          }

          // ── Schema query fast-path ──
          if (item.intent === 'schema_query') {
            const KNOWN_TABLES = ['cb_sources', 'cb_artifacts', 'cb_chunks', 'cb_embeddings', 'cb_messages', 'cb_projects'];
            let answer = '';

            if (item.conversational_query.startsWith('schema:')) {
              const tableName = (item.technical_identifiers || item.conversational_query.replace('schema:', '')).trim();
              if (KNOWN_TABLES.includes(tableName)) {
                const { data, error } = await supabase
                  .from('information_schema.columns' as any)
                  .select('column_name, data_type, is_nullable')
                  .eq('table_name', tableName)
                  .order('ordinal_position' as any, { ascending: true });
                if (!error && data?.length) {
                  const cols = (data as any[]).map((c: any) => `  ${c.column_name} (${c.data_type}, ${c.is_nullable === 'YES' ? 'nullable' : 'required'})`).join('\n');
                  answer = `Schema for \`${tableName}\`:\n\`\`\`\n${cols}\n\`\`\``;
                }
              }
            } else if (item.conversational_query.startsWith('count:')) {
              const tableName = (item.technical_identifiers || item.conversational_query.replace('count:', '')).trim();
              if (KNOWN_TABLES.includes(tableName)) {
                const { count, error } = await supabase
                  .from(tableName)
                  .select('*', { count: 'exact', head: true })
                  .in('project_id', projectIds);
                if (!error) {
                  answer = `Row count for \`${tableName}\` in this project: ${count ?? 0}`;
                }
              }
            } else if (item.conversational_query.startsWith('exists:')) {
              const filePath = (item.technical_identifiers || item.conversational_query.replace('exists:', '')).trim();
              const { data, error } = await supabase
                .from('cb_artifacts')
                .select('key, updated_at')
                .in('project_id', projectIds)
                .ilike('key', `%${filePath}%`)
                .is('deleted_at', null)
                .limit(3);
              if (!error) {
                answer = data?.length
                  ? `Found in Codex index:\n${(data as any[]).map((a: any) => `- ${a.key} (updated ${a.updated_at})`).join('\n')}`
                  : `No file matching \`${filePath}\` found in the Codex index.`;
              }
            }

            if (answer) {
              console.log(`[auto-context] ✅ Schema query: ${item.conversational_query}`);
              return { question: item.conversational_query, answer };
            }
          }

          const searchController = new AbortController();
          const searchTimeout = setTimeout(() => searchController.abort(), 35000);

          const searchResponse = await fetch(searchUrl, {
            method: 'POST',
            redirect: 'manual',
            signal: searchController.signal,
            headers: {
              'Content-Type': 'application/json',
              'Authorization': req.headers['authorization'] || ''
            },
            body: JSON.stringify({ 
              query: item.technical_identifiers || item.conversational_query,
              projectId: projectIds[0],
              projectIds,
              includeCodex: true
            })
          });

          clearTimeout(searchTimeout);

          if (!searchResponse.ok) {
            console.warn(`[auto-context] Search failed for "${item.conversational_query}": ${searchResponse.status}`);
            return null;
          }

          const searchData = await searchResponse.json() as {
            ok?: boolean;
            intent?: string;
            artifacts?: { files?: Array<{ path: string; filename: string | null; similarity: number; startLine?: number; endLine?: number }> };
            memory?: { messages?: Array<{ preview: string; similarity: number; conversationId: string; title?: string }> };
          };

          const rankedFiles = searchData.artifacts?.files || [];
          const rankedMessages = searchData.memory?.messages || [];

          console.log(`[auto-context] Search response: intent=${searchData.intent}, files=${rankedFiles.length}, messages=${rankedMessages.length}`);
          if (rankedFiles.length) {
            console.log(`[auto-context] Top files:`, rankedFiles.slice(0, 3).map(f => `${f.filename} (${Math.round(f.similarity * 100)}%)`));
          }

          // Fetch content for top-ranked files from Codex
          if (rankedFiles.length > 0) {
            const snippets: string[] = [];
            for (const file of rankedFiles.slice(0, 3)) {
              try {
                const fileUrl = `${base}/api/codex/file-content?projectId=${encodeURIComponent(projectIds[0])}&filePath=${encodeURIComponent(file.path)}`;
                const fileResp = await fetch(fileUrl, {
                  headers: { 'Authorization': req.headers['authorization'] || '' }
                });
                if (fileResp.ok) {
                  const fileData = await fileResp.json() as { content?: string; filePath?: string };
                  if (fileData.content && fileData.content.length > 0) {
                    const lines = fileData.content.split('\n');
                    let extracted = fileData.content;

                    // If we have span info from ranking, use it
                    if (file.startLine && file.endLine) {
                      const start = Math.max(0, file.startLine - 5);
                      const end = Math.min(lines.length, file.endLine + 5);
                      extracted = lines.slice(start, end).join('\n');
                    }
                    // Otherwise, try to find the identifier in the file
                    else if (item.technical_identifiers) {
                      const identifiers = item.technical_identifiers.split(/\s+/).filter((t: string) => t.length > 3);
                      for (const ident of identifiers) {
                        const idx = lines.findIndex(l => l.includes(ident));
                        if (idx !== -1) {
                          const start = Math.max(0, idx - 10);
                          const end = Math.min(lines.length, idx + 60);
                          extracted = lines.slice(start, end).join('\n');
                          break;
                        }
                      }
                    }

                    // Final truncation safety net
                    const maxChars = 5000;
                    const truncated = extracted.length > maxChars
                      ? extracted.slice(0, maxChars) + '\n// ... (truncated)'
                      : extracted;
                    snippets.push(`// ${file.path}\n${truncated}`);
                  }
                }
              } catch { /* skip failed file fetches */ }
            }

            if (snippets.length > 0) {
              const combined = snippets.join('\n\n');
              const totalLines = combined.split('\n').length;
              return {
                question: item.conversational_query,
                answer: `\`\`\`\n${combined}\n\`\`\`\n\n*Auto-Context extracted ~${totalLines} lines. Do you need to see more?*`
              };
            }
          }

          // Fallback: conversation results
          if (rankedMessages.length > 0) {
            const topMessages = rankedMessages.slice(0, 3);
            const combined = topMessages.map(m => {
              const title = m.title || `Conversation ${m.conversationId?.slice(0, 8) || ''}`;
              return `### ${title}\n- message: "${m.preview?.slice(0, 300) || ''}"`;
            }).join('\n\n');
            
            return {
              question: item.conversational_query,
              answer: combined.length > 2000 ? combined.slice(0, 2000) + '\n\n*Auto-Context extracted ~2,000 characters. Do you need to see more?*' : combined
            };
          }

          return null;

        } catch (e: any) {
          console.warn(`[auto-context] Search error for "${item.conversational_query}":`, e.message);
          return null;
        }
      }));

      qaItems.push(...results.filter((r): r is { question: string; answer: string } => r !== null));

      if (!qaItems.length) {
        console.log('[auto-context] No answerable questions with context found');
        return res.json({ ok: true, hasQuestions: false, qaBlock: '', questions: [], answers: [] });
      }

      // ── Step 5: Assemble Q&A block ──
      const qaBlock = qaItems.map(item => `Q: ${item.question}\nA: ${item.answer}`).join('\n\n');

      console.log(`[auto-context] ✅ Returning ${qaItems.length} Q&A pairs`);

      return res.json({
        ok: true,
        hasQuestions: true,
        qaBlock,
        questions: qaItems.map(i => i.question),
        answers: qaItems.map(i => i.answer)
      });

    } catch (err: any) {
      if (err.name === 'AbortError') {
        return res.status(504).json({ error: 'Detection timed out' });
      }
      console.error('[auto-context] Error:', err);
      return res.status(500).json({ error: err?.message ?? 'Internal error' });
    }
  });

  return router;
}