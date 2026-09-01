// Fast, batched entity + mention extraction (project-scoped) with bulk UPSERTs
// and an inline progress bar (no extra deps).

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env
dotenv.config({ path: path.join(__dirname, '../../../.env') });

// Supabase (service role recommended; UI clients should not run this job)
const supabase = createClient(
  process.env.SB_URL || process.env.SUPABASE_URL,
  process.env.SB_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY
);

// -------------------------------
// Patterns (extend as you like)
// -------------------------------
const PATTERNS = [
  // technologies
  { regex: /\b(React|Vue|Angular|Next\.js|Node\.js|Python|JavaScript|TypeScript|PostgreSQL|Supabase|Docker|AWS|Claude|GPT-4)\b/gi, type: 'technology' },
  // files
  { regex: /\b([a-zA-Z0-9_.-]+\.(tsx?|jsx?|py|json|md|yaml|yml|sql|csv|ipynb))\b/g, type: 'file' },
  // tasks/issues (Jira / GitHub)
  { regex: /\b([A-Z][A-Z0-9]+-\d{1,6})\b/g, type: 'task_or_issue' },
  { regex: /\b#(\d{1,6})\b/g, type: 'task_or_issue' },
  // versions (semver-ish, CUDA, Python, Chrome)
  { regex: /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g, type: 'version_or_release' },
  { regex: /\bCUDA\s*(\d+(?:\.\d+)*)\b/gi, type: 'version_or_release' },
  { regex: /\bPython\s*(\d+(?:\.\d+)*)\b/gi, type: 'version_or_release' },
  { regex: /\bChrome\s*(\d+(?:\.\d+)*)\b/gi, type: 'version_or_release' },
];

// -------------------------------
// Tunables
// -------------------------------
const PROJECT_CONCURRENCY     = Number(process.env.KG_PROJECT_CONCURRENCY || 6);
const MESSAGE_BATCH_SIZE      = Number(process.env.KG_MESSAGE_BATCH_SIZE  || 5000);
const MENTIONS_INSERT_CHUNK   = Number(process.env.KG_MENTIONS_INSERT_CHUNK || 5000);
const PROGRESS_WIDTH          = Number(process.env.KG_PROGRESS_WIDTH || 28);
const LOG_EVERY_PROJECT_STATS = process.env.KG_LOG_PROJECT_STATS !== '0';

// Optional: limit to a single project via CLI arg or env PROJECT_ID
// Usage: node fix-entity-extraction.js <projectId>
const SINGLE_PROJECT_ID = process.argv[2] || process.env.PROJECT_ID || null;

// -------------------------------
// Tiny progress bar
// -------------------------------
function renderBar(current, total, width = PROGRESS_WIDTH) {
  const pct = total ? Math.min(1, current / total) : 0;
  const filled = Math.round(pct * width);
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
  const pctStr = (pct * 100).toFixed(1).padStart(5);
  return `[${bar}] ${pctStr}%`;
}
function logProgress(prefix, current, total) {
  process.stdout.write(`\r${prefix} ${renderBar(current, total)}`);
  if (current >= total) process.stdout.write('\n');
}

// -------------------------------
// Helpers
// -------------------------------
function canon(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function dedupeByKey(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = keyFn(it);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

async function loadEntityMap(projectId) {
  const { data, error } = await supabase
    .from('entities')
    .select('id, canonical_name, entity_type')
    .eq('project_id', projectId);

  if (error) throw error;
  const map = new Map(); // key: `${canonical}::${type}` -> id
  for (const e of data || []) {
    map.set(`${e.canonical_name}::${e.entity_type}`, e.id);
  }
  return map;
}

async function countMessages(projectId) {
  const { count, error } = await supabase
    .from('cb_messages')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId);
  if (error) throw error;
  return count || 0;
}

async function fetchMessagesInBatches(projectId, pageSize = MESSAGE_BATCH_SIZE, onBatch) {
  // Use 1000 as max page size due to Supabase limit
  const effectivePageSize = Math.min(pageSize, 1000);
  let offset = 0;
  let fetched = 0;
  const all = [];
  
  while (true) {
    const { data, error } = await supabase
      .from('cb_messages')
      .select('id, content, conversation_id')
      .eq('project_id', projectId)
      .order('id', { ascending: true })
      .range(offset, offset + effectivePageSize - 1);
      
    if (error) throw error;
    
    const batch = data || [];
    all.push(...batch);
    fetched += batch.length;
    
    if (typeof onBatch === 'function') onBatch(fetched, batch.length);
    
    // Stop only when we get NO rows (not just less than requested)
    if (batch.length === 0) break;
    
    offset += effectivePageSize;
  }
  
  return all;
}

async function bulkUpsertEntities(projectId, rows) {
  if (!rows.length) return [];
  // Requires unique index on (project_id, canonical_name, entity_type)
  const { data, error } = await supabase
    .from('entities')
    .upsert(rows, {
      onConflict: 'project_id,canonical_name,entity_type',
      ignoreDuplicates: true,
    })
    .select('id, canonical_name, entity_type');

  if (error) throw error;
  return data || [];
}

async function bulkInsertMentions(mentions, onChunk) {
  for (let i = 0; i < mentions.length; i += MENTIONS_INSERT_CHUNK) {
    const chunk = mentions.slice(i, i + MENTIONS_INSERT_CHUNK);
    const { error } = await supabase.from('entity_mentions').insert(chunk);
    if (error) throw error;
    if (typeof onChunk === 'function') onChunk(Math.min(i + chunk.length, mentions.length), mentions.length);
  }
}

// -------------------------------
// Core per-project job
// -------------------------------
async function processProject(projectId) {
  console.log(`\n→ Project ${projectId}: starting extraction`);
  const totalMsgs = await countMessages(projectId);

  console.log(`→ Project ${projectId}: loading entity map…`);
  const entityMap = await loadEntityMap(projectId);

  console.log(`→ Project ${projectId}: fetching ${totalMsgs} message(s) in batches…`);
  let fetchedSoFar = 0;
  const msgs = await fetchMessagesInBatches(projectId, MESSAGE_BATCH_SIZE, (fetched, delta) => {
    fetchedSoFar = fetched;
    logProgress('   Fetch messages ', fetchedSoFar, totalMsgs || 1);
  });

  console.log(`→ Project ${projectId}: scanning ${msgs.length} messages for entities…`);
  const newEntityCandidates = new Map(); // key -> {canonical, type}
  const mentions = [];

  // First pass: collect *new* entities
  let scannedSoFar = 0;
  for (const m of msgs) {
    const content = m.content || '';
    if (!content) { scannedSoFar++; continue; }

    for (const { regex, type } of PATTERNS) {
      const flags = Array.from(new Set((regex.flags + 'g').split(''))).join('');
      const re = new RegExp(regex.source, flags);
      for (const match of content.matchAll(re)) {
        const text = match[1] || match[0];
        if (!text) continue;
        const key = `${canon(text)}::${type}`;
        if (!entityMap.has(key) && !newEntityCandidates.has(key)) {
          newEntityCandidates.set(key, { canonical: key.split('::')[0], type });
        }
      }
    }
    scannedSoFar++;
    if (totalMsgs) logProgress('   Scan messages  ', scannedSoFar, totalMsgs);
  }
  if (totalMsgs) logProgress('   Scan messages  ', totalMsgs, totalMsgs);

  // Upsert new entities (if any)
  const newEntitiesRows = Array.from(newEntityCandidates.values()).map(v => ({
    project_id: projectId,
    canonical_name: v.canonical,
    entity_type: v.type,
    source: 'extraction',
  }));

  if (newEntitiesRows.length) {
    console.log(`→ Project ${projectId}: upserting ${newEntitiesRows.length} new entities…`);
    const upserted = await bulkUpsertEntities(projectId, newEntitiesRows);
    for (const e of upserted) {
      entityMap.set(`${e.canonical_name}::${e.entity_type}`, e.id);
    }
  } else {
    console.log(`→ Project ${projectId}: no new entities to upsert.`);
  }

  // Second pass: build mentions (resolve entity_id from map; no DB reads)
  console.log(`→ Project ${projectId}: building mentions…`);
  let builtSoFar = 0;
  for (const m of msgs) {
    const content = m.content || '';
    if (!content) { builtSoFar++; continue; }

    for (const { regex, type } of PATTERNS) {
      const flags = Array.from(new Set((regex.flags + 'g').split(''))).join('');
      const re = new RegExp(regex.source, flags);
      for (const match of content.matchAll(re)) {
        const text = match[1] || match[0];
        if (!text) continue;
        const key = `${canon(text)}::${type}`;
        const entityId = entityMap.get(key);
        if (!entityId || match.index == null) continue;

        mentions.push({
          project_id: projectId,
          entity_id: entityId,
          message_id: m.id,
          start_idx: match.index,
          end_idx: match.index + text.length,
          surface_form: text,
          confidence: 0.8,
        });
      }
    }
    builtSoFar++;
    if (totalMsgs) logProgress('   Build mentions ', builtSoFar, totalMsgs);
  }
  if (totalMsgs) logProgress('   Build mentions ', totalMsgs, totalMsgs);

  // De-duplicate mentions
  const deduped = dedupeByKey(
    mentions,
    (r) => `${r.entity_id}:${r.message_id}:${r.start_idx}:${r.end_idx}`
  );

  // Bulk insert mentions in chunks with progress
  console.log(`→ Project ${projectId}: inserting ${deduped.length} mentions…`);
  let insertedSoFar = 0;
  await bulkInsertMentions(deduped, (done, total) => {
    insertedSoFar = done;
    logProgress('   Insert mentions', insertedSoFar, total);
  });
  if (deduped.length) logProgress('   Insert mentions', deduped.length, deduped.length);

  if (LOG_EVERY_PROJECT_STATS) {
    const [{ count: entityCount }, { count: mentionCount }] = await Promise.all([
      supabase.from('entities').select('*', { count: 'exact', head: true }).eq('project_id', projectId),
      supabase.from('entity_mentions').select('*', { count: 'exact', head: true }).eq('project_id', projectId),
    ]);
    console.log(`✅ Project ${projectId}: done. Entities now=${entityCount ?? '—'}, mentions now=${mentionCount ?? '—'}`);
  } else {
    console.log(`✅ Project ${projectId}: done.`);
  }
}

// -------------------------------
// Main
// -------------------------------
async function main() {
  console.log('Starting fast entity extraction (with UPSERT + progress)…');

  // Optional: single project mode
  if (SINGLE_PROJECT_ID) {
    await processProject(SINGLE_PROJECT_ID);
    console.log('\nAll done (single project).');
    return;
  }

  const { data: projects, error } = await supabase
    .from('projects')
    .select('id');

  if (error) throw error;

  const ids = (projects || []).map(p => p.id);
  if (!ids.length) {
    console.log('No projects found.');
    return;
  }

  console.log(`Found ${ids.length} project(s). Running with concurrency=${PROJECT_CONCURRENCY}…`);
  const limit = pLimit(PROJECT_CONCURRENCY);
  await Promise.all(ids.map(pid => limit(() => processProject(pid))));

  // Quick global verification (optional)
  const [{ count: entityCount }, { count: mentionCount }] = await Promise.all([
    supabase.from('entities').select('*', { count: 'exact', head: true }),
    supabase.from('entity_mentions').select('*', { count: 'exact', head: true }),
  ]);

  console.log('\n=== Extraction Complete ===');
  console.log(`Total entities:  ${entityCount ?? 0}`);
  console.log(`Total mentions:  ${mentionCount ?? 0}`);
}

main().catch((err) => {
  console.error('❌ Extraction failed:', err);
  process.exit(1);
});
