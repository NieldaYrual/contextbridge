#!/usr/bin/env node
// ingest-codex.ts
// ContextBridge Code Sync CLI
// Interactive project selection with local storage

import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import fetch from 'node-fetch';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG_DIR = path.join(os.homedir(), '.ctxbridge');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_API_URL = 'https://api.ctxbridge.io';

interface LocalConfig {
  projectId?: string;
  projectName?: string;
  apiUrl?: string;
  lastSyncDir?: string;
}

interface SyncOptions {
  projectId: string;
  apiUrl: string;
  rootDir: string;
  ignoreDirs: string[];
  allowedExtensions: string[];
}

// ============================================================================
// CLI HELPERS
// ============================================================================

function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function confirm(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await prompt(rl, `${question} ${hint}: `);
  
  if (answer === '') return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

function printBanner() {
  console.log('');
  console.log('🔗 ContextBridge Code Sync');
  console.log('==========================');
  console.log('');
}

function printHelp() {
  console.log(`
Usage: npx ts-node ingest-codex.ts [options]

Options:
  --project=<id>      Use specific project ID (skips prompt)
  --api-url=<url>     Override API URL (default: ${DEFAULT_API_URL})
  --root=<path>       Root directory to scan (default: current directory)
  --reset             Clear saved config and re-prompt
  --help              Show this help

Examples:
  npx ts-node ingest-codex.ts                    # Interactive mode
  npx ts-node ingest-codex.ts --project=abc123   # Direct sync
  npx ts-node ingest-codex.ts --reset            # Reset saved project
`);
}

// ============================================================================
// CONFIG MANAGEMENT
// ============================================================================

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadConfig(): LocalConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.warn('⚠️  Failed to load config, starting fresh');
  }
  return {};
}

function saveConfig(config: LocalConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function clearConfig(): void {
  if (fs.existsSync(CONFIG_FILE)) {
    fs.unlinkSync(CONFIG_FILE);
    console.log('🗑️  Cleared saved configuration');
  }
}

// ============================================================================
// CLI ARGUMENT PARSING
// ============================================================================

interface CliArgs {
  projectId?: string;
  apiUrl?: string;
  rootDir?: string;
  reset: boolean;
  help: boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = { reset: false, help: false };
  
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--project=')) {
      args.projectId = arg.split('=')[1];
    } else if (arg.startsWith('--api-url=')) {
      args.apiUrl = arg.split('=')[1];
    } else if (arg.startsWith('--root=')) {
      args.rootDir = arg.split('=')[1];
    } else if (arg === '--reset' || arg === '-r') {
      args.reset = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }
  
  return args;
}

// ============================================================================
// PROJECT SELECTION
// ============================================================================

async function selectProject(rl: readline.Interface, config: LocalConfig): Promise<{ projectId: string; projectName: string }> {
  // Check if we have a saved project
  if (config.projectId) {
    const displayName = config.projectName || config.projectId.substring(0, 8) + '...';
    console.log(`📋 Saved project: ${displayName}`);
    console.log(`   ID: ${config.projectId}`);
    console.log('');
    
    const useSaved = await confirm(rl, 'Use this project?', true);
    
    if (useSaved) {
      return { projectId: config.projectId, projectName: config.projectName || '' };
    }
    
    console.log('');
  }
  
  // Prompt for new project
  console.log('📋 Enter your Project ID');
  console.log('   (Find this in your ContextBridge dashboard)');
  console.log('');
  
  let projectId = '';
  while (!projectId) {
    projectId = await prompt(rl, 'Project ID: ');
    
    if (!projectId) {
      console.log('❌ Project ID is required');
    } else if (!/^[a-f0-9-]{36}$/i.test(projectId) && projectId.length < 8) {
      console.log('⚠️  That doesn\'t look like a valid project ID (expected UUID format)');
      const proceed = await confirm(rl, 'Use it anyway?', false);
      if (!proceed) {
        projectId = '';
      }
    }
  }
  
  // Optional: Get a friendly name
  const projectName = await prompt(rl, 'Project name (optional, for display): ');
  
  console.log('');
  
  // Offer to save
  const shouldSave = await confirm(rl, '💾 Remember this project for future syncs?', true);
  
  if (shouldSave) {
    const newConfig: LocalConfig = {
      ...config,
      projectId,
      projectName: projectName || undefined,
    };
    saveConfig(newConfig);
    console.log(`✅ Saved to ${CONFIG_FILE}`);
  }
  
  console.log('');
  
  return { projectId, projectName };
}

// ============================================================================
// FILE DISCOVERY
// ============================================================================

const DEFAULT_IGNORE_DIRS = [
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode',
  'target', 'bin', 'obj', '.gradle', '.m2',
  'chrome-profile',      // Browser profile data
  'test-profile',        // Test browser profiles
  'playwright-data',     // Playwright browser data
  'downloads',           // Downloaded files
  'logs',                // Log files
  'tmp', 'temp',         // Temporary files
  'captures',            // Conversation capture JSON files
];

const DEFAULT_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.go', '.rs', '.java', '.cs', '.kt', '.scala',
  '.php', '.rb', '.swift',
  '.c', '.cpp', '.cc', '.h', '.hpp',
  '.html', '.css', '.scss', '.sass', '.less',
  '.sql', '.graphql', '.gql',
  '.json', '.yaml', '.yml', '.toml', '.xml',
  '.md', '.mdx', '.txt', '.rst',
  '.sh', '.bash', '.zsh', '.ps1', '.bat',
  '.dockerfile', '.tf', '.hcl',
];

function walkDirectory(
  dir: string,
  ignoreDirs: string[],
  allowedExtensions: string[],
  files: string[] = []
): string[] {
  let entries: string[];
  
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    console.warn(`⚠️  Cannot read directory: ${dir}`);
    return files;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    
    try {
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        // Skip ignored directories and hidden directories
        if (!ignoreDirs.includes(entry) && !entry.startsWith('.')) {
          walkDirectory(fullPath, ignoreDirs, allowedExtensions, files);
        }
      } else {
        const ext = path.extname(entry).toLowerCase();
        // Handle extensionless files like Dockerfile, Makefile
        const basename = path.basename(entry).toLowerCase();
        const specialFiles = ['dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile'];
        
        if (allowedExtensions.includes(ext) || specialFiles.includes(basename)) {
          files.push(fullPath);
        }
      }
    } catch (err) {
      // Skip files we can't access
    }
  }

  return files;
}

// ============================================================================
// FILE SYNC
// ============================================================================

async function syncFile(
  options: SyncOptions,
  filePath: string
): Promise<boolean> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(options.rootDir, filePath).replace(/\\/g, '/');
    const ext = path.extname(filePath).substring(1) || 'plaintext';

    const response = await fetch(`${options.apiUrl}/api/codex/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId: options.projectId,
        filePath: relativePath,
        content: content,
        language: ext,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`❌ ${relativePath}: ${err.substring(0, 100)}`);
      return false;
    }
    
    const result = await response.json() as { chunks?: number; dualWrite?: boolean };
    const chunks = result.chunks || 0;
    const dualWrite = result.dualWrite ? ' ✓' : '';
    console.log(`✅ ${relativePath} (${chunks} chunks${dualWrite})`);
    return true;
    
  } catch (error: any) {
    const relativePath = path.relative(options.rootDir, filePath);
    console.error(`❌ ${relativePath}: ${error.message}`);
    return false;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = parseArgs();
  
  // Help
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  
  printBanner();
  
  // Reset config if requested
  if (args.reset) {
    clearConfig();
  }
  
  // Load existing config
  let config = loadConfig();
  
  // Determine project ID
  let projectId: string;
  let projectName: string = '';
  
  if (args.projectId) {
    // CLI argument takes precedence
    projectId = args.projectId;
    console.log(`📋 Using project from CLI: ${projectId}`);
    console.log('');
  } else {
    // Interactive selection
    const rl = createReadline();
    try {
      const selection = await selectProject(rl, config);
      projectId = selection.projectId;
      projectName = selection.projectName;
    } finally {
      rl.close();
    }
  }
  
  // Determine other options
  const apiUrl = args.apiUrl || config.apiUrl || DEFAULT_API_URL;
  const rootDir = path.resolve(args.rootDir || process.cwd());
  
  // Update config with last sync directory
  config = loadConfig();
  config.lastSyncDir = rootDir;
  config.apiUrl = apiUrl;
  saveConfig(config);
  
  // Print summary
  console.log('📁 Sync Configuration');
  console.log('─────────────────────');
  console.log(`   Project:    ${projectName || projectId.substring(0, 8) + '...'}`);
  console.log(`   Root:       ${rootDir}`);
  console.log(`   API:        ${apiUrl}`);
  console.log('');
  
  // Discover files
  console.log('🔍 Scanning for files...');
  const files = walkDirectory(rootDir, DEFAULT_IGNORE_DIRS, DEFAULT_EXTENSIONS);
  console.log(`📁 Found ${files.length} files`);
  console.log('');
  
  if (files.length === 0) {
    console.log('⚠️  No files found to sync.');
    console.log('   Check that you\'re in the right directory.');
    process.exit(0);
  }
  
  // Confirm before syncing many files
  if (files.length > 100) {
    const rl = createReadline();
    try {
      const proceed = await confirm(rl, `Sync ${files.length} files?`, true);
      if (!proceed) {
        console.log('Cancelled.');
        process.exit(0);
      }
    } finally {
      rl.close();
    }
    console.log('');
  }
  
  // Sync files
  console.log('🚀 Starting sync...');
  console.log('');
  
  const options: SyncOptions = {
    projectId,
    apiUrl,
    rootDir,
    ignoreDirs: DEFAULT_IGNORE_DIRS,
    allowedExtensions: DEFAULT_EXTENSIONS,
  };
  
  let successCount = 0;
  let failCount = 0;
  const startTime = Date.now();
  
  for (const file of files) {
    const success = await syncFile(options, file);
    if (success) {
      successCount++;
    } else {
      failCount++;
    }
  }
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  // Summary
  console.log('');
  console.log('==========================');
  console.log(`✅ Synced:  ${successCount} files`);
  if (failCount > 0) {
    console.log(`❌ Failed:  ${failCount} files`);
  }
  console.log(`⏱️  Time:    ${elapsed}s`);
  console.log('');
  console.log('🎉 Sync complete!');
  console.log('');
  console.log('Your files are now searchable in ContextBridge.');
  console.log(`Run again anytime with: npx ts-node ingest-codex.ts`);
}

main().catch((err) => {
  console.error('');
  console.error('💥 Fatal error:', err.message || err);
  console.error('');
  console.error('If this persists, try:');
  console.error('  1. Check your internet connection');
  console.error('  2. Verify the API URL is correct');
  console.error('  3. Run with --reset to clear saved config');
  process.exit(1);
});