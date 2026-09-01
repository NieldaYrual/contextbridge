// Load .env from monorepo root (fallbacks to CWD)
import { config } from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tryPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../../.env'),
  path.resolve(__dirname, '../../.env'),
];
for (const p of tryPaths) {
  if (fs.existsSync(p)) { config({ path: p }); break; }
}

import { createClient } from '@supabase/supabase-js';
import { embedBatch, EMBEDDING_MODEL_NAME, EMBEDDING_DIMENSIONS } from "../services/embedding.service";

/* =========================
   ENV + CONSTANTS
   ========================= */
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''; // accept both
const PROJECT_ID =
  process.env.PROJECT_ID ||
  process.env.CB_PROJECT_ID || ''; // accept alternate name


const BATCH_SIZE = Math.max(1, parseInt(process.env.BATCH_SIZE ?? '100', 10));
const INPUT_TRUNCATE_CHARS = Math.max(100, parseInt(process.env.INPUT_TRUNCATE_CHARS ?? '8000', 10));

/* Optional overrides */
const OV = {
  convTable: process.env.CONVERSATIONS_TABLE,
  convIdCol: process.env.CONVERSATIONS_ID_COL,
  convProjectCol: process.env.CONVERSATIONS_PROJECT_COL,
  convCreatedCol: process.env.CONVERSATIONS_CREATED_COL,
  convTitleCol: process.env.CONVERSATIONS_TITLE_COL,
  convSummaryCol: process.env.CONVERSATIONS_SUMMARY_COL,

  msgTable: process.env.MESSAGES_TABLE,
  msgIdCol: process.env.MESSAGES_ID_COL,
  msgConvIdCol: process.env.MESSAGES_CONV_ID_COL,
  msgContentCol: process.env.MESSAGES_CONTENT_COL,
  msgCreatedCol: process.env.MESSAGES_CREATED_COL,
  msgProjectCol: process.env.MESSAGES_PROJECT_COL,

  fileTable: process.env.FILES_TABLE,
  fileIdCol: process.env.FILES_ID_COL,
  fileConvIdCol: process.env.FILES_CONV_ID_COL,
  fileTextCol: process.env.FILES_TEXT_COL,
  fileCreatedCol: process.env.FILES_CREATED_COL,
  fileProjectCol: process.env.FILES_PROJECT_COL,
};

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !PROJECT_ID) {
  console.error('[env] Missing one of: SUPABASE_URL, SUPABASE_SERVICE_KEY/SUPABASE_SERVICE_ROLE_KEY, PROJECT_ID/CB_PROJECT_ID.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

/* =========================
   UTILITIES
   ========================= */
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
const chunk = <T,>(arr: T[], n: number) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const sanitizeText = (t?: string | null) => (t ?? '').slice(0, INPUT_TRUNCATE_CHARS);

async function listPublicTables(): Promise<string[]> {
  const { data, error } = await supabase
    .from('information_schema.tables' as any)
    .select('table_name')
    .eq('table_schema', 'public');
  if (error) return [];
  return (data as any[]).map(r => r.table_name);
}

async function listColumns(table: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('information_schema.columns' as any)
    .select('column_name')
    .eq('table_schema', 'public')
    .eq('table_name', table);
  if (error) return new Set();
  return new Set((data as any[]).map(r => r.column_name));
}

function hasAll(cols: Set<string>, req: string[]) {
  return req.every(c => cols.has(c));
}

async function countFor(table: string, projectId: string) {
  const { count, error } = await supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId);
  if (error) throw error;
  return count ?? 0;
}

/* =========================
   SCHEMA DISCOVERY (robust + overrides)
   ========================= */
type Discovered = {
  // conversations (optional)
  convTable: string | null;
  convIdCol?: string;
  convProjectCol?: string;
  convCreatedCol?: string;
  convTitleCol?: string;
  convSummaryCol?: string;
  // messages (required to process messages)
  msgTable?: string;
  msgIdCol?: string;
  msgConvIdCol?: string;
  msgContentCol?: string;
  msgCreatedCol?: string;
  msgProjectCol?: string; // optional
  // files (required to process files)
  fileTable?: string;
  fileIdCol?: string;
  fileConvIdCol?: string;
  fileTextCol?: string;
  fileCreatedCol?: string;
  fileProjectCol?: string; // optional
};

async function discover(): Promise<Discovered> {
  // Prefer explicit overrides if provided, otherwise use our cb_* defaults.
  const convTable = OV.convTable ?? 'cb_conversations';
  const convIdCol = OV.convIdCol ?? 'id';
  const convProjectCol = OV.convProjectCol ?? 'project_id';
  const convCreatedCol = OV.convCreatedCol ?? 'created_at';
  const convTitleCol = OV.convTitleCol ?? 'title';
  const convSummaryCol = OV.convSummaryCol ?? 'summary';

  const msgTable = OV.msgTable ?? 'cb_messages';
  const msgIdCol = OV.msgIdCol ?? 'id';
  const msgConvIdCol = OV.msgConvIdCol ?? 'conversation_id';
  const msgContentCol = OV.msgContentCol ?? 'content';
  const msgCreatedCol = OV.msgCreatedCol ?? 'created_at';
  const msgProjectCol = OV.msgProjectCol ?? 'project_id'; // optional but present in your schema

  const fileTable = OV.fileTable ?? 'cb_files';
  const fileIdCol = OV.fileIdCol ?? 'id';
  const fileConvIdCol = OV.fileConvIdCol ?? 'conversation_id';
  const fileTextCol = OV.fileTextCol ?? 'content';
  const fileCreatedCol = OV.fileCreatedCol ?? 'created_at';
  const fileProjectCol = OV.fileProjectCol ?? 'project_id'; // optional but present

  return {
    convTable,
    convIdCol,
    convProjectCol,
    convCreatedCol,
    convTitleCol,
    convSummaryCol,

    msgTable,
    msgIdCol,
    msgConvIdCol,
    msgContentCol,
    msgCreatedCol,
    msgProjectCol,

    fileTable,
    fileIdCol,
    fileConvIdCol,
    fileTextCol,
    fileCreatedCol,
    fileProjectCol,
  };
}

/* =========================
   BACKFILL SECTIONS
   ========================= */
async function getConversationIdsForProject(d: Discovered, projectId: string): Promise<string[]> {
  if (!d.convTable || !d.convIdCol || !d.convProjectCol) return [];
  const { data, error } = await supabase
    .from(d.convTable)
    .select(d.convIdCol)
    .eq(d.convProjectCol, projectId)
    .limit(100000);
  if (error) throw error;
  return (data ?? []).map((r: any) => r[d.convIdCol!]);
}

// put near other helpers
async function upsertChunked<T>(
  table: string,
  rows: T[],
  onConflict: string,
  chunkSize = 50,
  ignoreDuplicates = true // default: skip existing rows
) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from(table).upsert(slice as any, {
      onConflict,
      ignoreDuplicates,
    });
    if (error) throw error;
  }
}

// Count rows from a view using PostgREST head-only counts
async function countPendingFromView(view: string, projectId: string): Promise<number> {
  const { count, error } = await supabase
    .from(view)
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId);
  if (error) {
    console.warn(`[count] ${view} count error:`, error.message);
    return 0;
  }
  return count ?? 0;
}

// Optional: one-shot snapshot using your RPC progress
async function snapshotProgress(projectId: string) {
  const { data, error } = await supabase.rpc('cb_embedding_progress', { p_project_id: projectId });
  if (error) {
    console.warn('[progress] rpc error:', error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  console.log(
    `[progress] totals: msgs=${row.msg_total}, files=${row.file_total}, blocks=${row.block_total} | ` +
    `pending: msgs=${row.msg_pending}, files=${row.file_pending}, blocks=${row.block_pending}`
  );
  return row;
}

async function backfillMessages(projectId: string, _d: Discovered, _convIds: string[]) {
  const willMsg = await countPendingFromView('v_cb_messages_needing_embeddings', projectId);
  console.log(`\n1) Processing messages… (will embed ~${willMsg})`);
  if (willMsg === 0) {
    console.log('   No more messages needing embeddings.');
    return;
  }

  const page = BATCH_SIZE;
  let total = 0;

  while (true) {
    // Only messages that still need embeddings
    const { data: ids, error: idErr } = await supabase
      .from('v_cb_messages_needing_embeddings')
      .select('message_id')
      .eq('project_id', projectId)
      .limit(page);

    if (idErr) { console.error('   Select message IDs error:', idErr); break; }
    if (!ids || ids.length === 0) {
      console.log('   No more messages needing embeddings.');
      break;
    }

    const msgIds = ids.map((r: any) => r.message_id);

    const { data: msgs, error: selErr } = await supabase
      .from('cb_messages')
      .select('id, content, conversation_id, created_at')
      .in('id', msgIds);

    if (selErr) { console.error('   Select messages error:', selErr); break; }
    if (!msgs || msgs.length === 0) continue;

    // Skip empty content defensively
    const filtered = msgs.filter((r: any) => (r.content ?? '').trim().length > 0);
    if (filtered.length === 0) continue;

    const inputs = filtered.map((r: any) => sanitizeText(r.content));
    const vectors = await embedBatch(inputs);

    const rows = filtered.map((r: any, i: number) => ({
      message_id: r.id,
      project_id: projectId,
      conversation_id: r.conversation_id,
      embedding: vectors[i],
      embedding_model: EMBEDDING_MODEL_NAME,
      embedding_dimensions: EMBEDDING_DIMENSIONS,
      created_at: r.created_at ?? new Date().toISOString(),
    }));

    try {
      // chunked + skip duplicates so reruns are fast and safe
      await upsertChunked('cb_message_embeddings', rows, 'message_id', 50, true);
      total += rows.length; // count what we actually attempted to embed, not the fetch page size
      console.log(`   +${rows.length} (total messages embedded: ${total})`);
    } catch (err) {
      console.error('   cb_message_embeddings upsert error:', err);
    }

    await sleep(50);
  }
}

async function backfillFiles(projectId: string, _d: Discovered, _convIds: string[]) {
  const willFiles = await countPendingFromView('v_cb_files_needing_embeddings', projectId);
  console.log(`\n2) Processing files… (will embed ~${willFiles})`);

  const page = BATCH_SIZE;
  let total = 0;

  while (true) {
    // only files that still need embeddings
    console.log(`[files] project=${projectId} using view=v_cb_files_needing_embeddings → cb_file_embeddings`);
    const { data: ids, error: idErr } = await supabase
      .from('v_cb_files_needing_embeddings')
      .select('cb_file_id')
      .eq('project_id', projectId)
      .limit(page);

    if (idErr) { console.error('   Select file IDs error:', idErr); break; }
    if (!ids || ids.length === 0) {
      console.log('   No more files needing embeddings.');
      break;
    }

    const fileIds = ids.map((r: any) => r.cb_file_id);

    const { data: files, error: fErr } = await supabase
      .from('cb_files')
      .select('id, content, conversation_id')
      .in('id', fileIds);

    if (fErr) { console.error('   Select files error:', fErr); break; }
    if (!files || files.length === 0) continue;

    const filtered = files.filter((r: any) => (r.content ?? '').trim().length > 0);
    if (filtered.length === 0) continue;

    const inputs = filtered.map((r: any) => sanitizeText(r.content));
    const vectors = await embedBatch(inputs);

    const now = new Date().toISOString();
    const rows = filtered.map((r: any, i: number) => ({
      cb_file_id: r.id,
      project_id: projectId,
      conversation_id: r.conversation_id,
      path_hint: null,
      embedding: vectors[i],
      created_at: now,
    }));

    try {
      await upsertChunked('cb_file_embeddings', rows, 'cb_file_id', 50, true); // skip duplicates
      total += rows.length;
      console.log(`   +${rows.length} (total files embedded: ${total})`);
    } catch (err) {
      console.error('   cb_file_embeddings upsert error:', err);
    }

    await sleep(50);
  }
}

async function backfillConversations(projectId: string, d: Discovered) {
  // Count up-front so logs tell you what to expect
  const willConvs = await countPendingFromView('v_cb_conversations_needing_embeddings', projectId);
  console.log(`\n4) Processing conversations… (will embed ~${willConvs})`);
  if (willConvs === 0) {
    console.log('   No more conversations needing embeddings.');
    return;
  }

  const page = BATCH_SIZE;
  let total = 0;

  while (true) {
    // Only conversations that still need embeddings
    const { data: ids, error: idErr } = await supabase
      .from('v_cb_conversations_needing_embeddings')
      .select('conversation_id, title, summary, created_at')
      .eq('project_id', projectId)
      .limit(page);

    if (idErr) { console.error('   Select conversation IDs error:', idErr); break; }
    if (!ids || ids.length === 0) {
      console.log('   No more conversations needing embeddings.');
      break;
    }

    const convIds = ids.map((r: any) => r.conversation_id);

    // If you need additional columns from cb_conversations, fetch here (optional).
    // We already have title/summary/created_at from the view, so we can embed directly.

    // Build input text (title + summary); ensure non-empty strings
    const inputs = ids.map((c: any) => {
      const t = (c.title ?? '').toString();
      const s = (c.summary ?? '').toString();
      const combined = [t, s].filter(Boolean).join('\n').trim();
      return sanitizeText(combined || `Conversation ${c.conversation_id}`);
    });

    const vectors = await embedBatch(inputs);

    const rows = ids.map((c: any, i: number) => ({
      conversation_id: c.conversation_id,
      project_id: projectId,
      summary: ((c.title ?? '') && (c.summary ?? ''))
        ? `${c.title}\n${c.summary}`.trim()
        : (c.title ?? c.summary ?? `Conversation ${c.conversation_id}`),
      embedding: vectors[i],
      embedding_model: EMBEDDING_MODEL_NAME,
      embedding_dimensions: EMBEDDING_DIMENSIONS,
      created_at: c.created_at ?? new Date().toISOString(),
    }));

    try {
      // conversations can evolve; keep ignoreDuplicates=false if you want updates to overwrite
      await upsertChunked('cb_conversation_embeddings', rows, 'conversation_id', 50, false);
      total += rows.length;
      console.log(`   +${rows.length} (total conversations embedded: ${total})`);
    } catch (err) {
      console.error('   cb_conversation_embeddings upsert error:', err);
    }

    await sleep(50);
  }
}

async function backfillBlocks(projectId: string) {
  const willBlocks = await countPendingFromView('v_cb_blocks_needing_embeddings', projectId);
  console.log(`\n3) Processing blocks… (will embed ~${willBlocks})`);
  if (willBlocks === 0) {
    console.log('   No more blocks needing embeddings.');
    return;
  }

  const page = BATCH_SIZE;
  let total = 0;

  while (true) {
    // ✅ only blocks that still need embeddings
    const { data: ids, error: idErr } = await supabase
      .from('v_cb_blocks_needing_embeddings')
      .select('block_id')
      .eq('project_id', projectId)
      .limit(page);

    if (idErr) { console.error('   Select block IDs error:', idErr); break; }
    if (!ids || ids.length === 0) {
      console.log('   No more blocks needing embeddings.');
      break;
    }

    const blockIds = ids.map((r: any) => r.block_id);

    const { data: blocks, error: selErr } = await supabase
      .from('cb_blocks')
      .select('id, content')
      .in('id', blockIds);

    if (selErr) { console.error('   Select blocks error:', selErr); break; }
    if (!blocks || blocks.length === 0) continue;

    // Skip empties defensively (view should already filter, but just in case)
    const filtered = blocks.filter((r: any) => (r.content ?? '').trim().length > 0);
    if (filtered.length === 0) continue;

    const inputs = filtered.map((r: any) => sanitizeText(r.content));
    const vectors = await embedBatch(inputs);

    const now = new Date().toISOString();
    const rows = filtered.map((r: any, i: number) => ({
      block_id: r.id,
      project_id: projectId,
      embedding: vectors[i],
      embedding_model: EMBEDDING_MODEL_NAME,
      embedding_dimensions: EMBEDDING_DIMENSIONS,
      created_at: now,
    }));

    try {
      await upsertChunked('cb_block_embeddings', rows, 'block_id', 50, true); // skip dups
      total += rows.length;
      console.log(`   +${rows.length} (total blocks embedded: ${total})`);
    } catch (err) {
      console.error('   cb_block_embeddings upsert error:', err);
    }

    await sleep(50);
  }
}

/* =========================
   MAIN
   ========================= */
async function main() {
  console.log('Starting embedding backfill…');
  console.log(`Project: ${PROJECT_ID}`);
  console.log(`Batch size: ${BATCH_SIZE}, Model: ${EMBEDDING_MODEL_NAME}`);

  await snapshotProgress(PROJECT_ID);

  // Longer statements (bulk upserts)
  await supabase.rpc('cb_set_statement_timeout', { ms: 120000 });

  // --- take project-scoped advisory lock (prevents concurrent runs) ---
  const { data: gotLock, error: lockErr } = await supabase.rpc('cb_try_project_lock', {
    p_project_id: PROJECT_ID,
  });
  if (lockErr) throw lockErr;
  if (!gotLock?.ok) {
    console.log(`[lock] another backfill is active for ${PROJECT_ID}; exiting.`);
    return; // do not throw; just exit gracefully
  }

  try {
    const d = await discover();

    // If we have a conversations table, we can always filter by project.
    // Otherwise, we need project_id columns on messages/files to proceed.
    const convIds = await getConversationIdsForProject(d, PROJECT_ID);

    await backfillMessages(PROJECT_ID, d, convIds);
    await backfillFiles(PROJECT_ID, d, convIds);
    await backfillBlocks(PROJECT_ID);              // ← include blocks here
    await backfillConversations(PROJECT_ID, d);    // conversations last (optional)

    const [m, f, c, b] = await Promise.all([
      countFor('cb_message_embeddings', PROJECT_ID),
      countFor('cb_file_embeddings', PROJECT_ID),
      countFor('cb_conversation_embeddings', PROJECT_ID),
      countFor('cb_block_embeddings', PROJECT_ID),
    ]);

    console.log('\nBackfill complete!');
    console.log('Final embedding counts (service):');
    console.log(`- Messages: ${m}`);
    console.log(`- Files: ${f}`);
    console.log(`- Blocks: ${b}`);
    console.log(`- Conversations: ${c}`);
  } finally {
    // --- always release the lock ---
    await supabase.rpc('cb_release_project_lock', { p_project_id: PROJECT_ID });
  }
}

// Script entry
main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});

