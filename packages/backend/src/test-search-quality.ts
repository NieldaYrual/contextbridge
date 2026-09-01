#!/usr/bin/env node
/**
 * Search Quality Test Harness
 * 
 * Runs test queries against /api/agent/search-tiered in 4 configurations:
 *   1. Claude + OpenAI + Codex
 *   2. Claude + OpenAI (no Codex)
 *   3. Claude only
 *   4. Codex only
 * 
 * Compares results against golden expectations and previous runs.
 * 
 * Usage:
 *   npx ts-node test-search-quality.ts                    # Run all queries
 *   npx ts-node test-search-quality.ts --compare prev.json # Compare with previous
 *   npx ts-node test-search-quality.ts --query "myQuery"   # Run single query
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── CONFIG ──────────────────────────────────────────────────────────────────

interface GoldenExpectation {
  topFile: string | null;
  mustInclude: string[];
  mustExclude: string[];
  topConversation: string | null;
}

interface TestQuery {
  query: string;
  projectGroup?: string;
  note?: string;
  golden?: GoldenExpectation;
}

interface ProjectGroup {
  claude: string;
  openai: string;
}

interface TestConfig {
  projectGroups: Record<string, ProjectGroup>;
  apiBase: string;
  queries: TestQuery[];
}

interface FileResult {
  name: string;
  path: string;
  score: number;
  rank: number;
}

interface ConversationResult {
  title: string;
  score: number;
  rank: number;
  preview: string;
}

interface ConfigResult {
  configName: string;
  files: FileResult[];
  conversations: ConversationResult[];
  searchTimeMs: number;
  intent: string;
}

interface QueryResult {
  query: string;
  note?: string;
  golden?: GoldenExpectation;
  configs: ConfigResult[];
  goldenPass: boolean;
  goldenFailures: string[];
  goldenPositions: string[];
  qualityPass: boolean;
  qualityFailures: QualityIssue[];
  qualityWarnings: QualityIssue[];
}

interface QualityIssue {
  checkId: string;
  message: string;
  rank?: number;
  fileName?: string;
  filePath?: string;
}

interface TestRun {
  timestamp: string;
  runId: string;
  results: QueryResult[];
  summary: {
    totalQueries: number;
    goldenPassed: number;
    goldenFailed: number;
    avgSearchTimeMs: number;
    qualityPassed: number;
    qualityFailed: number;
    qualityFailuresByType: Record<string, number>;
    qualityWarningsByType: Record<string, number>;
  };
}

// ── AUTH ─────────────────────────────────────────────────────────────────────

const TOKEN_FILE = path.join(__dirname, '.cb-test-token');

async function getAuthToken(): Promise<string> {
  // Try .cb-test-token file first
  if (fs.existsSync(TOKEN_FILE)) {
    const token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
    if (token) return token;
  }

  // Prompt user
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const token = await new Promise<string>((resolve) => {
    console.log('\n📋 Paste your JWT access token (from Chrome extension Service Worker):');
    console.log('   chrome.storage.sync.get(["accessToken"], (d) => console.log(d.accessToken))\n');
    rl.question('Token: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  // Save for future runs
  fs.writeFileSync(TOKEN_FILE, token);
  console.log(`✅ Token saved to ${TOKEN_FILE}\n`);
  return token;
}

// ── API CALLS ───────────────────────────────────────────────────────────────

async function searchTiered(
  apiBase: string,
  token: string,
  query: string,
  projectId: string,
  projectIds: string[],
  includeCodex: boolean
): Promise<ConfigResult> {
  const startTime = Date.now();

  const payload = {
    query,
    projectId,
    projectIds,
    includeCodex,
  };

  const resp = await fetch(`${apiBase}/api/agent/search-tiered`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token.replace(/[^\x20-\x7E]/g, '').trim()}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${errText}`);
  }

  const data = await resp.json() as any;
  const elapsed = Date.now() - startTime;

  // Extract file results
  const files: FileResult[] = (data.artifacts?.files || []).map((f: any, i: number) => ({
    name: f.filename || f.path?.split('/').pop() || 'unknown',
    path: f.path || '',
    score: Math.round((f.similarity || 0) * 100),
    rank: i + 1,
  }));

  // Extract conversation results
  const conversations: ConversationResult[] = (data.memory?.messages || []).map((m: any, i: number) => ({
    title: (m as any).title || m.conversationId || 'untitled',
    score: Math.round((m.similarity || 0) * 100),
    rank: i + 1,
    preview: (m.preview || m.content || '').substring(0, 80),
  }));

  return {
    configName: '',
    files,
    conversations,
    searchTimeMs: data.meta?.searchTimeMs || elapsed,
    intent: data.intent || 'unknown',
  };
}

// ── GOLDEN EVALUATION ───────────────────────────────────────────────────────

function evaluateGolden(result: ConfigResult, golden: GoldenExpectation): { pass: boolean; failures: string[]; positions: string[] } {
  const failures: string[] = [];
  const positions: string[] = [];
  const fileNames = result.files.map(f => f.name.toLowerCase());

  // Check topFile
  if (golden.topFile) {
    const topName = result.files[0]?.name?.toLowerCase() || '';
    if (!topName.includes(golden.topFile.toLowerCase())) {
      failures.push(`❌ Top file: expected "${golden.topFile}", got "${result.files[0]?.name || 'none'}" (${result.files[0]?.score || 0}%)`);
      // Still report where the expected file actually landed
      const found = result.files.find(f => f.name.toLowerCase().includes(golden.topFile!.toLowerCase()));
      if (found) {
        positions.push(`⚠️  topFile "${golden.topFile}" → rank #${found.rank} (${found.score}%) [expected #1]`);
      } else {
        positions.push(`⚠️  topFile "${golden.topFile}" → NOT FOUND`);
      }
    } else {
      positions.push(`✅ topFile "${golden.topFile}" → rank #1 (${result.files[0]?.score || 0}%)`);
    }
  }

  // Check mustInclude
  for (const must of golden.mustInclude) {
    const found = result.files.find(f => f.name.toLowerCase().includes(must.toLowerCase()));
    if (!found) {
      failures.push(`❌ Missing: "${must}" not in results`);
      positions.push(`❌ mustInclude "${must}" → NOT FOUND`);
    } else {
      positions.push(`✅ mustInclude "${must}" → rank #${found.rank} (${found.score}%)`);
    }
  }

  // Check mustExclude
  for (const exclude of golden.mustExclude) {
    const found = result.files.find(f => f.name.toLowerCase().includes(exclude.toLowerCase()));
    if (found) {
      failures.push(`❌ Unwanted: "${exclude}" at rank ${found.rank} (${found.score}%)`);
      positions.push(`❌ mustExclude "${exclude}" → rank #${found.rank} (${found.score}%)`);
    }
  }

  // Check topConversation
  if (golden.topConversation) {
    const topTitle = result.conversations[0]?.title?.toLowerCase() || '';
    if (!topTitle.includes(golden.topConversation.toLowerCase())) {
      failures.push(`❌ Top conversation: expected "${golden.topConversation}", got "${result.conversations[0]?.title || 'none'}"`);
    } else {
      positions.push(`✅ topConversation → rank #1`);
    }
  }

  return { pass: failures.length === 0, failures, positions };
}

function evaluateQuality(
  result: ConfigResult,
  query: string
): { failures: QualityIssue[]; warnings: QualityIssue[] } {
  const failures: QualityIssue[] = [];
  const warnings: QualityIssue[] = [];

  // ── File result checks ──────────────────────────────────────
  for (const f of result.files) {
    const p = f.path;
    const n = f.name;

    // A. garbage_path_template
    if (p.includes('${')) {
      failures.push({
        checkId: 'garbage_path_template',
        message: `Path contains template literal: "${p}"`,
        rank: f.rank, fileName: n, filePath: p,
      });
    }

    // B. garbage_path_expression (narrow: ?. OR brackets+parens)
    if (p.includes('?.')) {
      failures.push({
        checkId: 'garbage_path_expression',
        message: `Path contains optional chaining: "${p}"`,
        rank: f.rank, fileName: n, filePath: p,
      });
    } else if (/\w+\[[^\]]*\]/.test(p) && /[()]/.test(p)) {
      failures.push({
        checkId: 'garbage_path_expression',
        message: `Path looks like JS expression: "${p}"`,
        rank: f.rank, fileName: n, filePath: p,
      });
    }

    // C. garbage_path_double_slash
    if (p.startsWith('//') || p.startsWith('\\\\')) {
      failures.push({
        checkId: 'garbage_path_double_slash',
        message: `Path starts with // or \\\\: "${p}"`,
        rank: f.rank, fileName: n, filePath: p,
      });
    }

    // D1. garbage_path_bare_token (no / and no . and short)
    if (!p.includes('/') && !p.includes('.') && p.length < 40) {
      failures.push({
        checkId: 'garbage_path_bare_token',
        message: `Path has no structure (bare token): "${p}"`,
        rank: f.rank, fileName: n, filePath: p,
      });
    }

    // D2. garbage_path_js_access (array bracket access)
    if (/\w+\[[0-9]+\]\./.test(p) || /\w+\[[^\]]+\]/.test(p)) {
      // Avoid double-flagging if already caught by expression check
      if (!p.includes('?.') && !(/[()]/.test(p))) {
        failures.push({
          checkId: 'garbage_path_js_access',
          message: `Path contains array access pattern: "${p}"`,
          rank: f.rank, fileName: n, filePath: p,
        });
      }
    }

    // E. garbage_name_template
    if (n.includes('${') || n.includes('?.')) {
      failures.push({
        checkId: 'garbage_name_template',
        message: `Filename contains code fragment: "${n}"`,
        rank: f.rank, fileName: n, filePath: p,
      });
    }
  }

  // F. suspicious_extension_for_code_top1
  if (result.intent === 'code_seeking' && result.files.length > 0) {
    const top = result.files[0];
    const ext = (top.name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
    const binaryBlocklist = ['pdf', 'docx', 'png', 'jpg', 'jpeg', 'mp4', 'gif', 'xlsx'];
    const softList = ['json', 'md', 'html'];
    const queryLower = query.toLowerCase();
    const softExemptHints = ['config', 'deploy', 'schema', 'migration', 'hosted', 'website', 'dashboard', 'template'];

    if (binaryBlocklist.includes(ext)) {
      failures.push({
        checkId: 'suspicious_extension_for_code_top1',
        message: `Top code result has binary extension .${ext}: "${top.name}"`,
        rank: 1, fileName: top.name, filePath: top.path,
      });
    } else if (softList.includes(ext) && !softExemptHints.some(h => queryLower.includes(h))) {
      warnings.push({
        checkId: 'soft_extension_for_code_top1',
        message: `Top code result has non-code extension .${ext}: "${top.name}"`,
        rank: 1, fileName: top.name, filePath: top.path,
      });
    }
  }

  // ── Conversation checks ─────────────────────────────────────
  for (const c of result.conversations) {
    if (c.title === 'null' || c.title === null) {
      warnings.push({
        checkId: 'null_conversation_title',
        message: `Conversation at rank ${c.rank} has null title`,
      });
    }
  }

  return { failures, warnings };
}

// ── COMPARISON ──────────────────────────────────────────────────────────────

function compareRuns(current: TestRun, previous: TestRun): string {
  let md = `\n## 📊 Comparison with Previous Run (${previous.runId})\n\n`;

  for (const currQ of current.results) {
    const prevQ = previous.results.find(p => p.query === currQ.query);
    if (!prevQ) {
      md += `### 🆕 "${currQ.query}" (new query)\n\n`;
      continue;
    }

    // Compare config 1 (Claude + OpenAI + Codex) as the primary
    const currConfig = currQ.configs[0];
    const prevConfig = prevQ.configs[0];
    if (!currConfig || !prevConfig) continue;

    const changes: string[] = [];

    // File rank changes
    for (const cf of currConfig.files) {
      const pf = prevConfig.files.find(p => p.name === cf.name);
      if (!pf) {
        changes.push(`  🆕 ${cf.name}: NEW at #${cf.rank} (${cf.score}%)`);
      } else if (cf.rank !== pf.rank || Math.abs(cf.score - pf.score) > 2) {
        const arrow = cf.rank < pf.rank ? '⬆️' : cf.rank > pf.rank ? '⬇️' : '➡️';
        changes.push(`  ${arrow} ${cf.name}: #${pf.rank}→#${cf.rank} (${pf.score}%→${cf.score}%)`);
      }
    }

    // Dropped files
    for (const pf of prevConfig.files) {
      if (!currConfig.files.find(cf => cf.name === pf.name)) {
        changes.push(`  🗑️ ${pf.name}: DROPPED (was #${pf.rank} ${pf.score}%)`);
      }
    }

    if (changes.length > 0) {
      md += `### "${currQ.query}"\n`;
      md += changes.join('\n') + '\n\n';
    }
  }

  return md;
}

// ── MARKDOWN REPORT ─────────────────────────────────────────────────────────

function generateReport(run: TestRun, previousRun?: TestRun): string {
  let md = `# Search Quality Test Report\n\n`;
  md += `**Run ID:** ${run.runId}\n`;
  md += `**Timestamp:** ${run.timestamp}\n`;
  md += `**Queries:** ${run.summary.totalQueries}\n`;
  md += `**Golden Passed:** ${run.summary.goldenPassed}/${run.summary.totalQueries}\n`;
  md += `**Avg Search Time:** ${run.summary.avgSearchTimeMs}ms\n\n`;
  md += `---\n\n`;

  const configLabels = [
    '🔷 Claude + OpenAI + Codex',
    '🔶 Claude + OpenAI',
    '🟣 Claude only',
    '🟢 Codex only',
  ];

  for (const qr of run.results) {
    md += `## Query: "${qr.query}"\n`;
    if (qr.note) md += `*${qr.note}*\n`;
    md += `\n`;

    // Golden results
    if (qr.golden) {
      if (qr.goldenPass) {
        md += `✅ **Golden: PASS**\n\n`;
      } else {
        md += `⚠️ **Golden: FAIL**\n`;
        for (const f of qr.goldenFailures) {
          md += `  ${f}\n`;
        }
        md += `\n`;
      }
    }

    // Results table per config
    for (let i = 0; i < qr.configs.length; i++) {
      const cfg = qr.configs[i];
      md += `### ${configLabels[i]}\n`;
      md += `*Intent: ${cfg.intent} | Time: ${cfg.searchTimeMs}ms*\n\n`;

      if (cfg.files.length > 0) {
        md += `| # | Code File | Score |\n`;
        md += `|---|-----------|-------|\n`;
        for (const f of cfg.files) {
          md += `| ${f.rank} | ${f.name} | ${f.score}% |\n`;
        }
        md += `\n`;
      } else {
        md += `*No code files*\n\n`;
      }

      if (cfg.conversations.length > 0) {
        md += `| # | Conversation | Score |\n`;
        md += `|---|-------------|-------|\n`;
        for (const c of cfg.conversations.slice(0, 3)) {
          md += `| ${c.rank} | ${c.title} | ${c.score}% |\n`;
        }
        if (cfg.conversations.length > 3) {
          md += `| ... | *(${cfg.conversations.length - 3} more)* | |\n`;
        }
        md += `\n`;
      }
    }

    md += `---\n\n`;
  }

  // Comparison with previous run
  if (previousRun) {
    md += compareRuns(run, previousRun);
  }

  return md;
}

// ── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const compareFile = args.find((a, i) => args[i - 1] === '--compare') || null;
  const singleQuery = args.find((a, i) => args[i - 1] === '--query') || null;

  // Load config
  const configPath = path.join(__dirname, 'test-queries.json');
  if (!fs.existsSync(configPath)) {
    console.error('❌ Missing test-queries.json');
    process.exit(1);
  }
  const config: TestConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Filter queries if --query flag
  let queries = config.queries;
  if (singleQuery) {
    queries = queries.filter(q => q.query.toLowerCase().includes(singleQuery.toLowerCase()));
    if (queries.length === 0) {
      console.error(`❌ No query matching "${singleQuery}"`);
      process.exit(1);
    }
  }

  // Auth
  const token = await getAuthToken();

  // Verify token works
  console.log('🔐 Verifying authentication...');
  try {
    const firstGroup = Object.values(config.projectGroups)[0];
    await searchTiered(config.apiBase, token, 'test', firstGroup.claude, [firstGroup.claude], false);
    console.log('✅ Auth OK\n');
  } catch (e: any) {
    if (e.message.includes('401') || e.message.includes('403')) {
      console.error('❌ Token expired. Delete .cb-test-token and re-run.');
      if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
      process.exit(1);
    }
    // Other errors might be OK (e.g. 500 from bad query)
    console.log('⚠️ Auth check returned error but may still work:', e.message.substring(0, 80));
  }

  // Build 4 configurations dynamically per query's project group
  function getConfigs(group: ProjectGroup) {
    return [
      {
        name: 'Claude + OpenAI + Codex',
        projectId: group.claude,
        projectIds: [group.claude, group.openai],
        includeCodex: true,
      },
      {
        name: 'Claude + OpenAI',
        projectId: group.claude,
        projectIds: [group.claude, group.openai],
        includeCodex: false,
      },
      {
        name: 'Claude only',
        projectId: group.claude,
        projectIds: [group.claude],
        includeCodex: false,
      },
      {
        name: 'Codex only',
        projectId: group.claude,
        projectIds: [],
        includeCodex: true,
      },
    ];
  }

  // Run tests
  const results: QueryResult[] = [];
  let totalSearchTime = 0;

  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    console.log(`\n🔍 [${qi + 1}/${queries.length}] "${q.query}"`);

    const groupName = q.projectGroup || 'contextbridge';
    const group = config.projectGroups[groupName];
    if (!group) {
      console.log(`   ⚠️ Unknown project group "${groupName}", skipping`);
      continue;
    }
    const configurations = getConfigs(group);
    const configs: ConfigResult[] = [];

    for (let ci = 0; ci < configurations.length; ci++) {
      const cfg = configurations[ci];
      process.stdout.write(`   ${ci + 1}/4 ${cfg.name}...`);

      try {
        const result = await searchTiered(
          config.apiBase,
          token,
          q.query,
          cfg.projectId,
          cfg.projectIds,
          cfg.includeCodex
        );
        result.configName = cfg.name;
        configs.push(result);
        totalSearchTime += result.searchTimeMs;
        process.stdout.write(` ${result.files.length} files, ${result.conversations.length} msgs (${result.searchTimeMs}ms)\n`);
      } catch (e: any) {
        console.log(` ❌ ${e.message.substring(0, 60)}`);
        configs.push({
          configName: cfg.name,
          files: [],
          conversations: [],
          searchTimeMs: 0,
          intent: 'error',
        });
      }

      // Small delay to avoid overwhelming the API
      await new Promise(r => setTimeout(r, 500));
    }

    // Evaluate golden expectations (against config 1: all sources)
    let goldenPass = true;
    let goldenFailures: string[] = [];
    let goldenPositions: string[] = [];
    if (q.golden && configs[0]) {
      const evaluation = evaluateGolden(configs[0], q.golden);
      goldenPass = evaluation.pass;
      goldenFailures = evaluation.failures;
      goldenPositions = evaluation.positions;
    }

    // Evaluate quality lint (against config 1: all sources)
    let qualityFailures: QualityIssue[] = [];
    let qualityWarnings: QualityIssue[] = [];
    if (configs[0]) {
      const qEval = evaluateQuality(configs[0], q.query);
      qualityFailures = qEval.failures;
      qualityWarnings = qEval.warnings;
    }

    results.push({
      query: q.query,
      note: q.note,
      golden: q.golden,
      configs,
      goldenPass,
      goldenFailures,
      goldenPositions,
      qualityPass: qualityFailures.length === 0,
      qualityFailures,
      qualityWarnings,
    });
  }

  // Build run object
  const now = new Date();
  const runId = now.toISOString().replace(/[:.]/g, '-').substring(0, 19);

  // Tally quality stats
  const qualityFailuresByType: Record<string, number> = {};
  const qualityWarningsByType: Record<string, number> = {};
  for (const r of results) {
    for (const f of r.qualityFailures) {
      qualityFailuresByType[f.checkId] = (qualityFailuresByType[f.checkId] || 0) + 1;
    }
    for (const w of r.qualityWarnings) {
      qualityWarningsByType[w.checkId] = (qualityWarningsByType[w.checkId] || 0) + 1;
    }
  }

  const run: TestRun = {
    timestamp: now.toISOString(),
    runId,
    results,
    summary: {
      totalQueries: results.length,
      goldenPassed: results.filter(r => r.goldenPass).length,
      goldenFailed: results.filter(r => !r.goldenPass).length,
      avgSearchTimeMs: Math.round(totalSearchTime / (results.length * 4)),
      qualityPassed: results.filter(r => r.qualityPass).length,
      qualityFailed: results.filter(r => !r.qualityPass).length,
      qualityFailuresByType,
      qualityWarningsByType,
    },
  };

  // Load previous run for comparison
  let previousRun: TestRun | undefined;
  if (compareFile && fs.existsSync(compareFile)) {
    previousRun = JSON.parse(fs.readFileSync(compareFile, 'utf-8'));
  } else {
    // Auto-find most recent previous run
    const resultsDir = path.join(__dirname, 'results');
    if (fs.existsSync(resultsDir)) {
      const prevFiles = fs.readdirSync(resultsDir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();
      if (prevFiles.length > 0) {
        previousRun = JSON.parse(fs.readFileSync(path.join(resultsDir, prevFiles[0]), 'utf-8'));
        console.log(`\n📊 Comparing with previous run: ${prevFiles[0]}`);
      }
    }
  }

  // Generate report
  const report = generateReport(run, previousRun);

  // Save files
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  const jsonPath = path.join(resultsDir, `search-test-${runId}.json`);
  const mdPath = path.join(resultsDir, `search-test-${runId}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(run, null, 2));
  fs.writeFileSync(mdPath, report);

  // Print summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📋 SUMMARY`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`Queries: ${run.summary.totalQueries}`);
  console.log(`Golden:  ${run.summary.goldenPassed} passed, ${run.summary.goldenFailed} failed`);
  console.log(`Quality: ${run.summary.qualityPassed} passed, ${run.summary.qualityFailed} failed`);
  console.log(`Avg time: ${run.summary.avgSearchTimeMs}ms per search`);
  console.log(`\nResults saved:`);
  console.log(`  📄 ${mdPath}`);
  console.log(`  📊 ${jsonPath}`);

  // Show golden failures
  const failures = results.filter(r => !r.goldenPass);
  if (failures.length > 0) {
    console.log(`\n⚠️  Golden Failures:`);
    for (const f of failures) {
      console.log(`  "${f.query}":`);
      for (const fail of f.goldenFailures) {
        console.log(`    ${fail}`);
      }
    }
  }

  // Show golden positions for ALL queries with golden expectations
  const withGolden = results.filter(r => r.golden && r.goldenPositions.length > 0);
  if (withGolden.length > 0) {
    console.log(`\n📍 Golden Positions:`);
    for (const r of withGolden) {
      const icon = r.goldenPass ? '✅' : '❌';
      console.log(`  ${icon} "${r.query}":`);
      for (const pos of r.goldenPositions) {
        console.log(`      ${pos}`);
      }
    }
  }

  // Show quality failures
  const qualityFails = results.filter(r => !r.qualityPass);
  if (qualityFails.length > 0) {
    console.log(`\n🧹 Quality Failures (${qualityFails.length} queries):`);
    for (const qf of qualityFails) {
      console.log(`  "${qf.query}":`);
      for (const issue of qf.qualityFailures) {
        console.log(`    ⚠️  [${issue.checkId}] ${issue.message}`);
      }
    }
    console.log(`\n  Breakdown by type:`);
    for (const [type, count] of Object.entries(qualityFailuresByType)) {
      console.log(`    ${type}: ${count}`);
    }
  }

  // Show quality warnings summary
  const totalWarnings = Object.values(qualityWarningsByType).reduce((a, b) => a + b, 0);
  if (totalWarnings > 0) {
    console.log(`\n📋 Quality Warnings (${totalWarnings} total):`);
    for (const [type, count] of Object.entries(qualityWarningsByType)) {
      console.log(`    ${type}: ${count}`);
    }
  }
}

main().catch(console.error);