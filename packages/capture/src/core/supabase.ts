import { createClient } from '@supabase/supabase-js';
import { sha } from './normalizer.js';
import type { NormalizedThread, CaptureTarget } from './types.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { config } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1) Load a monorepo root .env explicitly (fallback to local .env)
const tryPaths = [
  path.resolve(process.cwd(), '.env'),                       // CWD .env
  path.resolve(__dirname, '../../../.env'),                  // repo root .env (monorepo)
  path.resolve(__dirname, '../../.env'),                     // package-level .env
];
for (const p of tryPaths) {
  if (fs.existsSync(p)) { config({ path: p }); break; }
}

// 2) Read envs, allow both names for service key
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY || ''; // accept legacy name

const mask = (s: string) => (s ? s.slice(0, 8) + '…' + s.slice(-6) : '(empty)');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('[supabase cfg] url=', SUPABASE_URL, ' key=', mask(SUPABASE_SERVICE_ROLE));
  throw new Error('Missing Supabase environment variables (SUPABASE_URL / SERVICE_ROLE_KEY)');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  global: {
    fetch: (input, init) =>
      fetchWithRetry(input, init, {
        retries: 6,
        baseDelayMs: 250,
        maxDelayMs: 5000,
        timeoutMs: 9000,
      }),
    headers: { Accept: 'application/json' },
  },
  auth: { persistSession: false },
});

// Simple retry fetch implementation
async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: { retries: number; baseDelayMs: number; maxDelayMs: number; timeoutMs: number } = {
    retries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    timeoutMs: 5000
  }
): Promise<Response> {
  let lastError: Error;
  
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
      
      const response = await fetch(input, {
        ...init,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      lastError = error as Error;
      
      if (attempt < options.retries) {
        const delay = Math.min(
          options.baseDelayMs * Math.pow(2, attempt),
          options.maxDelayMs
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError!;
}

// Generic typed RPC wrapper
export async function callRpc<T = any>(
  fn: string,
  params?: Record<string, any>
): Promise<T> {
  const { data, error } = await supabase.rpc(fn, params);

  if (error) {
    // Optionally log here
    throw new Error(`Supabase RPC ${fn} failed: ${error.message}`);
  }

  return data as T;
}

export async function listDueTargets(now = new Date()): Promise<CaptureTarget[]> {
  const { data, error } = await supabase.rpc('cb_list_due_targets', { now_ts: now.toISOString() });
  if (error) throw error;
  return data as CaptureTarget[];
}

export async function startCaptureRow(targetId:string, provider:string){
  const { data, error } = await supabase.from('cb_captures').insert({
    target_id: targetId, provider, status: 'running'
  }).select().single();
  if (error) throw error;
  return data;
}

export async function finishCaptureRow(captureId:string, ok:boolean, message?:string){
  const { error } = await supabase.from('cb_captures')
    .update({ status: ok ? 'success':'error', finished_at: new Date().toISOString(), message })
    .eq('id', captureId);
  if (error) throw error;
}

export async function touchTarget(targetId:string){
  const { error } = await supabase.from('cb_capture_targets')
    .update({ last_captured_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', targetId);
  if (error) throw error;
}

export async function markTargetNeedsVerification(targetId: string, needs: boolean) {
  const { error } = await supabase
    .from('cb_capture_targets')
    .update({ human_verification_required: needs, updated_at: new Date().toISOString() })
    .eq('id', targetId);
  if (error) throw error;
}

export async function flagCaptureNeedsVerification(captureId: string, needs: boolean) {
  const { error } = await supabase
    .from('cb_captures')
    .update({ needs_verification: needs })
    .eq('id', captureId);
  if (error) throw error;
}

type UpsertThreadOptions = {
  /** Stable external id/slug for this project (from the extension/dashboard) */
  providerProjectId: string;
  /** Human name to show in the dashboard (optional; defaults to "Captured Project") */
  projectName?: string;
};

/**
 * Upsert a project → conversation → messages (+ blocks)
 * `NormalizedThread` stays unchanged; project identity comes from `opts`.
 */
export async function upsertThread(
  provider: string,
  t: NormalizedThread,
  opts: UpsertThreadOptions
) {
  const providerProjectId = opts.providerProjectId || 'N/A';
  const projectName = opts.projectName || providerProjectId.split('/').pop() || 'Unnamed Project';

  // 1) Project (unique on provider + provider_project_id)
  const { data: proj, error: projErr } = await supabase
    .from('cb_projects')
    .upsert(
      { provider, provider_project_id: providerProjectId, name: projectName },
      { onConflict: 'provider,provider_project_id' }
    )
    .select()
    .single();

  if (projErr) throw projErr;
  if (!proj) throw new Error('Project upsert returned no row');

  // 2) Conversation (unique on project_id + provider_conversation_id)
  const { data: conv, error: convErr } = await supabase
    .from('cb_conversations')
    .upsert(
      {
        project_id: proj.id,
        provider,
        provider_conversation_id: t.providerConversationId,
        title: t.title || '(untitled)',
        started_at: t.startedAt || new Date().toISOString(),
        last_activity_at: t.lastActivityAt || t.startedAt || new Date().toISOString(),
      },
      { onConflict: 'project_id,provider_conversation_id' }
    )
    .select()
    .single();

  if (convErr) throw convErr;
  if (!conv) throw new Error('Conversation upsert returned no row');

  // 3) Messages (ensure project_id is set)
  for (let i = 0; i < t.messages.length; i++) {
    const m = t.messages[i];
    if (!m) continue;

    const content = m.content ?? '';
    const contentSha = sha(content);

    const { data: msg, error: msgErr } = await supabase
      .from('cb_messages')
      .upsert(
        {
          conversation_id: conv.id,
          project_id: proj.id,
          provider,
          provider_message_id: m.providerMessageId || null,
          author_role: m.role || null,
          content,
          content_sha: contentSha,
          index_in_thread: i,
          created_at: m.timestamp || null,
        },
        { onConflict: 'conversation_id,content_sha,index_in_thread' }
      )
      .select()
      .single();

    if (msgErr) throw msgErr;
    if (!msg) continue; // Skip if no message was created

    // 4) Extract and insert code blocks from message content
    const codeBlocks = [];
    
    // Extract code blocks with ``` markers
    const codeBlockRegex = /```([a-zA-Z]*)\n?([\s\S]*?)```/g;
    let match;
    
    while ((match = codeBlockRegex.exec(content)) !== null) {
      if (match[2] && match[2].trim()) { // Only add non-empty blocks
        codeBlocks.push({
          message_id: msg.id,
          kind: 'code',
          language: match[1] || 'text',
          content: match[2].trim(),
          file_name: null
        });
      }
    }

    // Extract file references (optional - you can skip this if not needed)
    const fileRegex = /([a-zA-Z0-9_-]+\.(ts|tsx|js|jsx|py|html|css|json|sql|md))/g;
    const seenFiles = new Set<string>();
    
    while ((match = fileRegex.exec(content)) !== null) {
      if (match[1] && !seenFiles.has(match[1])) {
        seenFiles.add(match[1]);
        codeBlocks.push({
          message_id: msg.id,
          kind: 'file',
          language: match[2],
          content: null,
          file_name: match[1]
        });
      }
    }

    // Insert extracted blocks
    if (codeBlocks.length > 0) {
      const { error: blkErr } = await supabase.from('cb_blocks').upsert(codeBlocks);
      if (blkErr) console.warn('Block insert error:', blkErr);
    }

    // 5) Process blocks from the message if they exist (from extension's structured extraction)
    if (m.blocks?.length) {
      const rows = m.blocks.map(b => ({
        message_id: msg.id,
        kind: b.kind,
        language: b.language || null,
        file_name: b.fileName || null,
        content: b.content || null,
      }));
      const { error: blkErr } = await supabase.from('cb_blocks').upsert(rows);
      if (blkErr) console.warn('Structured block insert error:', blkErr);
    }
  }

  return { projectId: proj.id, conversationId: conv.id };
}