// packages/backend/src/link-conversations.js
// Link conversations for a SINGLE project selected by NAME (case-insensitive).

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env (.env at repo root)
dotenv.config({ path: path.join(__dirname, '../../../.env') });

// Supabase (use service role key for server jobs)
const supabase = createClient(
  process.env.SB_URL || process.env.SUPABASE_URL,
  process.env.SB_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY
);

// --- tiny CLI args (no deps) ---
// Usage examples:
//   node link-conversations.js --project "ContextBridge" --min 2 --refresh
//   node link-conversations.js -p MaterialLab -m 3
function parseArgs(argv) {
  const args = { project: null, min: 2, refresh: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project' || a === '-p') args.project = argv[++i];
    else if (a === '--min' || a === '-m') args.min = Number(argv[++i] || 2);
    else if (a === '--refresh' || a === '-r') args.refresh = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`
Link conversations for a single project by NAME.

Usage:
  node packages/backend/src/link-conversations.js --project "<Project Name>" [--min 2] [--refresh]

Options:
  -p, --project   Project name (case-insensitive, required)
  -m, --min       Minimum shared entities to link (default: 2)
  -r, --refresh   Refresh the materialized view before linking (default: false)
  -h, --help      Show this help
`);
}

async function getProjectByName(name) {
  // 1) try exact (case-insensitive)
  let { data, error } = await supabase
    .from('projects')
    .select('id, name, created_at')
    .ilike('name', name); // exact ci

  if (error) throw error;

  // 2) if none, try partial match (%name%)
  if (!data || data.length === 0) {
    const { data: partial, error: err2 } = await supabase
      .from('projects')
      .select('id, name, created_at')
      .ilike('name', `%${name}%`);
    if (err2) throw err2;
    data = partial || [];
  }

  if (data.length === 0) {
    throw new Error(`No project found matching "${name}". Tip: try quotes if it has spaces.`);
  }

  // prefer exact (case-insensitive)
  const exact = data.filter(p => p.name.toLowerCase() === name.toLowerCase());
  const matches = exact.length ? exact : data;

  if (matches.length > 1) {
    // If you prefer "most recent", replace this error with an order-by pick:
    // matches.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
    // return matches[0];
    const list = matches.map(p => `- ${p.name} (id=${p.id})`).join('\n');
    throw new Error(`Multiple projects matched "${name}". Candidates:\n${list}`);
  }

  return matches[0];
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.project) {
    printHelp();
    process.exit(args.project ? 0 : 1);
  }

  console.log(`Resolving project by name: "${args.project}"…`);
  const project = await getProjectByName(args.project);
  console.log(`→ Using project: ${project.name} (id=${project.id})`);

  console.log(
    `Calling RPC link_conversations(p_min_overlap=${args.min}, p_project_id=${project.id}, p_do_refresh=${!!args.refresh})…`
);

  const { data: inserted, error } = await supabase.rpc('link_conversations', {
    p_min_overlap: args.min,           // e.g., 2 or 3
    p_project_id: project.id,          // the UUID you looked up by name
    p_do_refresh: !!args.refresh       // true/false
    });

  if (error) {
    throw new Error(`RPC failed: ${error.message}`);
  }

  console.log(`✅ Inserted ${inserted} new conversation link(s) for project "${project.name}".`);
}

main().catch(err => {
  console.error('❌ Error:', err.message || err);
  process.exit(1);
});
