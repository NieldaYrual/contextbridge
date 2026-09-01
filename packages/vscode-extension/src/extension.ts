// packages/vscode-extension/src/extension.ts

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';

const outputChannel = vscode.window.createOutputChannel("ContextBridge Codex");

// Auth token storage
let authTokens: { accessToken: string | null; refreshToken: string | null } = {
    accessToken: null,
    refreshToken: null
};

// Collector for batching secret-guard notifications during bulk syncs.
// When present, syncDocument suppresses per-file toasts and pushes events here instead.
type GuardEventCollector = {
    denylistSkips: Array<{ path: string; pattern?: string }>;
    scanErrors: Array<{ path: string }>;
    redactions: Array<{ path: string; findings: Array<{ ruleId: string; line: number; message: string }> }>;
};

// Secret storage reference (set during activation)
let secretStorage: vscode.SecretStorage;

// Load tokens from secure storage
async function loadAuthTokens(): Promise<void> {
    try {
        const accessToken = await secretStorage.get('contextbridge.accessToken');
        const refreshToken = await secretStorage.get('contextbridge.refreshToken');
        
        if (accessToken) {
            authTokens.accessToken = accessToken;
            authTokens.refreshToken = refreshToken || null;
            outputChannel.appendLine('🔐 Auth tokens loaded');
        }
    } catch (error) {
        outputChannel.appendLine(`Failed to load auth tokens: ${error}`);
    }
}

// Save tokens to secure storage
async function saveAuthTokens(accessToken: string, refreshToken: string): Promise<void> {
    try {
        await secretStorage.store('contextbridge.accessToken', accessToken);
        await secretStorage.store('contextbridge.refreshToken', refreshToken);
        authTokens.accessToken = accessToken;
        authTokens.refreshToken = refreshToken;
        outputChannel.appendLine('🔐 Auth tokens saved');
    } catch (error) {
        outputChannel.appendLine(`Failed to save auth tokens: ${error}`);
    }
}

// Clear tokens (logout)
async function clearAuthTokens(): Promise<void> {
    try {
        await secretStorage.delete('contextbridge.accessToken');
        await secretStorage.delete('contextbridge.refreshToken');
        authTokens.accessToken = null;
        authTokens.refreshToken = null;
        outputChannel.appendLine('🔐 Auth tokens cleared');
    } catch (error) {
        outputChannel.appendLine(`Failed to clear auth tokens: ${error}`);
    }
}

// Get API base URL from config
function getApiBaseUrl(): string {
    const config = vscode.workspace.getConfiguration('contextbridge');
    const apiUrl = config.get<string>('apiUrl') || 'https://api.ctxbridge.io/api/codex/upsert-file';
    return apiUrl.replace(/\/api\/codex\/upsert-file\/?$/, '');
}

// Refresh tokens
async function refreshAuthTokens(): Promise<boolean> {
    if (!authTokens.refreshToken) return false;
    
    const apiBaseUrl = getApiBaseUrl();
    
    try {
        const response = await fetch(`${apiBaseUrl}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: authTokens.refreshToken })
        });
        
        if (response.ok) {
            const data = await response.json() as { 
                tokens: { accessToken: string; refreshToken: string } 
            };
            await saveAuthTokens(data.tokens.accessToken, data.tokens.refreshToken);
            outputChannel.appendLine('🔐 Tokens refreshed successfully');
            return true;
        }
    } catch (error) {
        outputChannel.appendLine(`🔐 Token refresh failed: ${error}`);
    }
    return false;
}

// Authenticated fetch wrapper
async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
    // Add auth header if we have a token
    if (authTokens.accessToken) {
        options.headers = {
            ...options.headers,
            'Authorization': `Bearer ${authTokens.accessToken}`
        };
    }
    
    let response = await fetch(url, options);
    
    // If 401 and we have a refresh token, try to refresh and retry
    if (response.status === 401 && authTokens.refreshToken) {
        const refreshed = await refreshAuthTokens();
        if (refreshed) {
            // Retry with new token
            options.headers = {
                ...options.headers,
                'Authorization': `Bearer ${authTokens.accessToken}`
            };
            response = await fetch(url, options);
        }
    }
    
    // If still 401, prompt user to sign in
    if (response.status === 401) {
        promptSignIn();
    }
    
    return response;
}

// Prompt user to sign in
function promptSignIn(): void {
    vscode.window.showErrorMessage(
        'ContextBridge: Please sign in to continue syncing.',
        'Sign In'
    ).then(selection => {
        if (selection === 'Sign In') {
            vscode.commands.executeCommand('contextbridge.login');
        }
    });
}

// Login command handler
async function handleLogin(): Promise<boolean> {
    outputChannel.appendLine('🔐 Starting login...');
    outputChannel.show();
    const apiBaseUrl = getApiBaseUrl();
    outputChannel.appendLine(`🔐 API URL: ${apiBaseUrl}`);
    
    const email = await vscode.window.showInputBox({
        prompt: 'Enter your ContextBridge email',
        placeHolder: 'you@example.com',
        ignoreFocusOut: true
    });
    
    if (!email) return false;
    
    const password = await vscode.window.showInputBox({
        prompt: 'Enter your password',
        password: true,
        ignoreFocusOut: true
    });
    
    if (!password) return false;
    
    try {
        const response = await fetch(`${apiBaseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        
        const data = await response.json() as {
            error?: string;
            code?: string;
            tokens?: { accessToken: string; refreshToken: string };
            user?: { id: string; email: string; name: string };
        };
        
        outputChannel.appendLine(`🔐 Login response status: ${response.status}`);
        
        if (response.ok && data.tokens) {
            await saveAuthTokens(data.tokens.accessToken, data.tokens.refreshToken);
            vscode.window.showInformationMessage(`✅ Signed in as ${data.user?.email || email}`);
            outputChannel.appendLine(`🔐 Logged in as ${data.user?.email}`);
            return true;
        } else {
            outputChannel.appendLine(`🔐 Login failed: ${JSON.stringify(data)}`);
            if (data.code === 'EMAIL_NOT_VERIFIED') {
                vscode.window.showErrorMessage('Please verify your email before signing in. Check your inbox.');
            } else {
                vscode.window.showErrorMessage(data.error || 'Login failed');
            }
            return false;
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Login failed: ${error.message}`);
        return false;
    }
}

// Select project from list
async function handleSelectProject() {
    if (!authTokens.accessToken) {
        const signIn = await vscode.window.showErrorMessage(
            'Please sign in to ContextBridge first.',
            'Sign In'
        );
        if (signIn === 'Sign In') {
            vscode.commands.executeCommand('contextbridge.login');
        }
        return;
    }

    outputChannel.appendLine('📂 Fetching projects...');
    const apiBaseUrl = getApiBaseUrl();

    try {
        const response = await authFetch(`${apiBaseUrl}/api/projects/list`);
        if (!response.ok) {
            throw new Error(`Failed to fetch projects: ${response.status}`);
        }

        const data = await response.json() as {
            success: boolean;
            projects: Array<{ id: string; name: string; conversation_count?: number; provider?: string }>;
        };

        if (!data.projects || data.projects.length === 0) {
            vscode.window.showInformationMessage('No projects found. Create a project in ContextBridge first.');
            return;
        }

        // Get currently selected project IDs
        const config = vscode.workspace.getConfiguration('contextbridge');
        const currentProjectIds: string[] = config.get('projectIds') || [];

        // Build quick pick items with checkboxes (multi-select)
        const items: vscode.QuickPickItem[] = data.projects.map(p => ({
            label: p.name,
            description: `${p.provider || 'unknown'} • ${p.conversation_count || 0} conversations`,
            detail: p.id,
            picked: currentProjectIds.includes(p.id)
        }));

        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: 'Select projects to sync with (multi-select)',
            title: 'ContextBridge: Select Projects'
        });

        if (selected && selected.length > 0) {
            const selectedIds = selected.map(item => item.detail as string);
            await config.update('projectIds', selectedIds, vscode.ConfigurationTarget.Workspace);
            
            const projectNames = selected.map(item => item.label).join(', ');
            vscode.window.showInformationMessage(`ContextBridge: Syncing to ${selected.length} project(s): ${projectNames}`);
            outputChannel.appendLine(`📂 Selected ${selected.length} projects: ${projectNames}`);
        } else if (selected && selected.length === 0) {
            await config.update('projectIds', [], vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage('ContextBridge: No projects selected. Sync disabled.');
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to load projects: ${error.message}`);
        outputChannel.appendLine(`❌ Error loading projects: ${error.message}`);
    }
}

/**
 * Optimized Delta Sync: Uses fs.readFileSync for speed/low-memory
 */
async function performDeltaSync(projectId: string, verbose: boolean) {
    // Check if logged in
    if (!authTokens.accessToken) {
        promptSignIn();
        return;
    }

    const config = vscode.workspace.getConfiguration('contextbridge');
    const includePatterns = config.get<string[]>('includedPatterns') || [
        'src/**/*',
        'packages/**/*',
        'packages/*/*.{ts,js,html,css,json}',
        'backend/**/*',
        'frontend/**/*',
        'frontend-*/**/*',
        'client/**/*',
        'web/**/*',
        'app/**/*',
        '*.{ts,js,py,go,rs,java,c,cpp,h,hpp,md,json}'
    ];
    const excludePatterns = config.get<string[]>('excludePatterns') || [
        '**/node_modules/**',
        '**/__pycache__/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/*.pyc',
        '**/*.pth',
        '**/*.pt',
        '**/*.pkl',
        '**/*.db',
        '**/*.min.js',
        '**/*.min.mjs',
        '**/*.min.css'
    ];
    const excludeBlob = `{${excludePatterns.join(',')}}`;
    const repoExternalId = `vscode-local-${projectId}`;
    const apiBaseUrl = getApiBaseUrl();

    const channel = verbose ? outputChannel : { appendLine: () => {} };
    if (verbose) outputChannel.show();
    channel.appendLine(`\n--- Starting Delta Sync ---`);

    try {
        // 1. Fetch remote file hashes
        channel.appendLine(`Fetching remote index...`);
        const response = await authFetch(
            `${apiBaseUrl}/api/codex/files?projectId=${projectId}&repoExternalId=${encodeURIComponent(repoExternalId)}`
        );

        if (!response.ok) {
            if (response.status === 401) return; // Auth handler already prompted
            throw new Error(`HTTP ${response.status}`);
        }

        const { files: remoteFiles } = await response.json() as { 
            files: Array<{ filePath: string; contentHash: string | null }> 
        };

        const remoteHashMap = new Map<string, string | null>();
        for (const f of remoteFiles) {
            remoteHashMap.set(f.filePath, f.contentHash);
        }
        
        // 2. Gather local files
        const allFiles = new Set<vscode.Uri>();
        for (const pattern of includePatterns) {
            const files = await vscode.workspace.findFiles(pattern, excludeBlob);
            files.forEach(f => allFiles.add(f));
        }
        channel.appendLine(`Checking ${allFiles.size} local files against ${remoteFiles.length} remote files...`);

        // 3. Compare and sync
        let synced = 0;
        let skipped = 0;
        let errors = 0;

        const guardCollector: GuardEventCollector = {
            denylistSkips: [],
            scanErrors: [],
            redactions: [],
        };

        await vscode.window.withProgress({
            location: verbose ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
            title: "ContextBridge: Syncing...",
            cancellable: false
        }, async (progress) => {
            
            const total = allFiles.size;
            let processed = 0;

            for (const uri of allFiles) {
                const relativePath = vscode.workspace.asRelativePath(uri);
                processed++;
                if (verbose) progress.report({ message: `${processed}/${total}`, increment: (1/total)*100 });

                if (relativePath.includes('node_modules') || relativePath.includes('.git') || relativePath.includes('dist')) continue;

                if (isBinaryFile(relativePath)) {
                    skipped++;
                    continue;
                }

                try {
                    const content = fs.readFileSync(uri.fsPath, 'utf-8');

                    if (content.length > 1024 * 1024) continue;

                    const localHash = crypto.createHash('md5').update(content).digest('hex');
                    const remoteHash = remoteHashMap.get(relativePath);

                    if (remoteHash === undefined || remoteHash === null || remoteHash !== localHash) {
                        const document = await vscode.workspace.openTextDocument(uri);
                        
                        if (isValidFile(document)) {
                            await syncDocument(document, verbose, guardCollector);
                            synced++;
                        }
                    } else {
                        skipped++;
                    }
                } catch (e: any) {
                    channel.appendLine(`Error checking ${relativePath}: ${e.message}`);
                    errors++;
                }
            }
        });

        const { denylistSkips, scanErrors, redactions } = guardCollector;
        const totalGuardEvents = denylistSkips.length + scanErrors.length + redactions.length;

        channel.appendLine(
            `--- Sync Complete: ${synced} sent, ${skipped} unchanged, ${errors} errors` +
            (totalGuardEvents > 0
                ? `, ${redactions.length} redacted, ${denylistSkips.length} secret-file(s) blocked, ${scanErrors.length} scan-error skip(s)`
                : '') +
            ` ---`
        );

        if (verbose) {
            if (totalGuardEvents === 0) {
                vscode.window.showInformationMessage(`ContextBridge: Sync complete. Updated ${synced} files.`);
            } else {
                // Build a single summary toast.
                const parts: string[] = [`Updated ${synced} files.`];
                if (redactions.length > 0) {
                    parts.push(`Redacted secrets in ${redactions.length} file(s).`);
                }
                if (denylistSkips.length > 0) {
                    parts.push(`Blocked ${denylistSkips.length} file(s) on the secret denylist.`);
                }
                if (scanErrors.length > 0) {
                    parts.push(`Skipped ${scanErrors.length} file(s) due to scan errors.`);
                }

                vscode.window.showWarningMessage(
                    `ContextBridge: ${parts.join(' ')}`,
                    'Show Details'
                ).then(choice => {
                    if (choice === 'Show Details') {
                        outputChannel.appendLine('');
                        outputChannel.appendLine('═══ Secret Guard Summary ═══');
                        if (redactions.length > 0) {
                            outputChannel.appendLine(`\nRedacted files (${redactions.length}):`);
                            for (const r of redactions) {
                                const lines = r.findings.map(f => `line ${f.line} (${f.ruleId})`).join(', ');
                                outputChannel.appendLine(`  • ${r.path} — ${lines}`);
                            }
                        }
                        if (denylistSkips.length > 0) {
                            outputChannel.appendLine(`\nBlocked by filename denylist (${denylistSkips.length}):`);
                            for (const s of denylistSkips) {
                                outputChannel.appendLine(`  • ${s.path}${s.pattern ? ` [pattern: ${s.pattern}]` : ''}`);
                            }
                        }
                        if (scanErrors.length > 0) {
                            outputChannel.appendLine(`\nSkipped due to scanner errors (${scanErrors.length}):`);
                            for (const e of scanErrors) {
                                outputChannel.appendLine(`  • ${e.path}`);
                            }
                        }
                        outputChannel.appendLine('═══════════════════════════');
                        outputChannel.show();
                    }
                });
            }
        }

    } catch (error: any) {
        outputChannel.appendLine(`❌ Delta sync failed: ${error.message}`);
        if (verbose) vscode.window.showErrorMessage(`Sync Failed: ${error.message}`);
    }
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel.appendLine('🚀 ContextBridge Codex is active!');
    
    // Initialize secret storage
    secretStorage = context.secrets;
    
    // Load auth tokens
    loadAuthTokens().then(() => {
        // 1. Startup Logic
        checkOnboarding(context).then((projectId) => {
            if (projectId && authTokens.accessToken) {
                performDeltaSync(projectId, false);
            }
        });
    });

    // Login command
    let loginCommand = vscode.commands.registerCommand('contextbridge.login', async () => {
        await handleLogin();
    });

    // Logout command
    let logoutCommand = vscode.commands.registerCommand('contextbridge.logout', async () => {
        await clearAuthTokens();
        vscode.window.showInformationMessage('Signed out of ContextBridge');
    });

    // Select project command
    let selectProjectCommand = vscode.commands.registerCommand('contextbridge.selectProject', async () => {
        await handleSelectProject();
    });

    // 3. Command: Sync Current File
    let syncCurrentFileCommand = vscode.commands.registerCommand('contextbridge.syncCurrentFile', async () => {
        if (!authTokens.accessToken) {
            promptSignIn();
            return;
        }
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            await syncDocument(editor.document, true);
        } else {
            vscode.window.showWarningMessage("No active file to sync.");
        }
    });

    // 4. Command: Smart Workspace Sync (syncs to all selected projects)
    let syncWorkspaceCommand = vscode.commands.registerCommand('contextbridge.syncWorkspace', async () => {
        const config = vscode.workspace.getConfiguration('contextbridge');
        const projectIds = config.get<string[]>('projectIds') || [];
        if (projectIds.length === 0) {
            vscode.window.showErrorMessage("Please select projects first using 'ContextBridge: Select Project'.");
            return;
        }
        outputChannel.appendLine(`🔄 Syncing to ${projectIds.length} project(s)...`);
        for (const projectId of projectIds) {
            await performDeltaSync(projectId, true);
        }
        outputChannel.appendLine(`✅ Sync complete for all ${projectIds.length} projects`);
    });

    // 5. Auto-Sync on Save
    let saveTimer: NodeJS.Timeout | undefined;

    const onSave = vscode.workspace.onDidSaveTextDocument((document) => {
        if (!authTokens.accessToken) return; // Skip if not logged in
        if (!isValidFile(document)) return;

        const relative = vscode.workspace.asRelativePath(document.uri);

        const isBackendFile =
            relative.startsWith('packages/backend/') ||
            relative.includes('/backend/') ||
            relative.includes('\\backend\\');

        const delayMs = isBackendFile ? 800 : 300;

        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            void syncDocument(document, true);
        }, delayMs);
    });

    // Track renamed paths to avoid delete-then-sync race
    const recentlyRenamedPaths = new Set<string>();

    // 6. File Rename Watcher
    const renameWatcher = vscode.workspace.onDidRenameFiles(async (e) => {
        if (!authTokens.accessToken) return;
        const config = vscode.workspace.getConfiguration('contextbridge');
        const projectIds = config.get<string[]>('projectIds') || [];
        if (projectIds.length === 0) return;
        const apiBaseUrl = getApiBaseUrl();
        
        for (const projectId of projectIds) {
            const repoExternalId = `vscode-local-${projectId}`;

        for (const file of e.files) {
            const oldPath = vscode.workspace.asRelativePath(file.oldUri);
            const newPath = vscode.workspace.asRelativePath(file.newUri);

            recentlyRenamedPaths.add(oldPath);
            setTimeout(() => recentlyRenamedPaths.delete(oldPath), 2000);

            if (oldPath.includes('node_modules') || oldPath.includes('.git')) continue;

            try {
                await authFetch(`${apiBaseUrl}/api/codex/rename-file`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectId, repoExternalId, oldPath, newPath })
                });
                outputChannel.appendLine(`✅ Renamed: ${oldPath} → ${newPath}`);
            } catch (e: any) {
                console.error(e);
            }
        }
        }
    });

    // 7. File Watcher for Deletions
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
    fileWatcher.onDidDelete(async (uri) => {
        if (!authTokens.accessToken) return;
        const config = vscode.workspace.getConfiguration('contextbridge');
        const projectIds = config.get<string[]>('projectIds') || [];
        if (projectIds.length === 0) return;
        
        const apiBaseUrl = getApiBaseUrl();
        const relativePath = vscode.workspace.asRelativePath(uri);
        
        if (recentlyRenamedPaths.has(relativePath)) return;
        if (relativePath.includes('node_modules') || relativePath.includes('.git')) return;

        for (const projectId of projectIds) {
            try {
                await authFetch(`${apiBaseUrl}/api/codex/file`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        projectId,
                        repoExternalId: `vscode-local-${projectId}`,
                        filePath: relativePath
                    })
                });
                outputChannel.appendLine(`🗑️ Deleted: ${relativePath} from project ${projectId}`);
            } catch (e: any) {
                console.error(e);
            }
        }
    });

    // Register all subscriptions
    context.subscriptions.push(loginCommand);
    context.subscriptions.push(logoutCommand);
    context.subscriptions.push(selectProjectCommand);
    context.subscriptions.push(syncCurrentFileCommand);
    context.subscriptions.push(syncWorkspaceCommand);
    context.subscriptions.push(onSave);
    context.subscriptions.push(renameWatcher);
    context.subscriptions.push(fileWatcher);
}

export function deactivate() {}

// --- Helpers ---
async function waitForBackendReady(apiBaseUrl: string, timeoutMs = 15000) {
    const start = Date.now();
    let attempt = 0;

    while (Date.now() - start < timeoutMs) {
        attempt++;
        try {
            const res = await fetch(`${apiBaseUrl}/health`, { method: 'GET' });
            if (res.ok) return;
        } catch {
            // server is down mid-restart
        }

        const backoff = Math.min(1200, 100 + attempt * 150) + Math.floor(Math.random() * 150);
        await new Promise(r => setTimeout(r, backoff));
    }

    throw new Error('Backend not ready (health timeout)');
}

async function checkOnboarding(context: vscode.ExtensionContext): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('contextbridge');
    const existingProjectId = config.get<string>('projectId');
    if (existingProjectId) return existingProjectId;

    const action = await vscode.window.showInformationMessage(
        '👋 Welcome to ContextBridge! Connect a project to start.',
        'Connect Project', 'Later'
    );

    if (action === 'Connect Project') {
        return undefined; 
    }
    return undefined;
}

function isValidFile(document: vscode.TextDocument): boolean {
    const filename = document.fileName;
    if (filename.includes('node_modules') || filename.includes('.git') || filename.includes('dist')) return false;
    if (document.getText().length > 1024 * 1024) return false;
    const allowed = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'python', 'html', 'css', 'json', 'go', 'rust', 'c', 'cpp', 'java'];
    return allowed.includes(document.languageId);
}

function isBinaryFile(filePath: string): boolean {
    const binaryExts = new Set([
        '.pyc', '.pyo', '.pyd', '.so', '.dll', '.dylib',
        '.pt', '.pth', '.pkl', '.pickle', '.npy', '.npz',
        '.db', '.sqlite', '.sqlite3',
        '.docx', '.xlsx', '.pptx', '.pdf',
        '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
        '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
        '.mp3', '.mp4', '.wav', '.avi', '.mov',
        '.woff', '.woff2', '.ttf', '.eot', '.otf',
        '.exe', '.bin', '.o', '.a', '.lib',
        '.whl', '.egg',
        '.map'
    ]);
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    return binaryExts.has(ext);
}

async function syncDocument(document: vscode.TextDocument, showStatus: boolean, collector?: GuardEventCollector) {
    // Check auth
    if (!authTokens.accessToken) {
        promptSignIn();
        return;
    }
    const config = vscode.workspace.getConfiguration('contextbridge');
    const projectIds = config.get<string[]>('projectIds') || [];
    const apiUrl = config.get<string>('apiUrl') || 'https://api.ctxbridge.io/api/codex/upsert-file';
    const apiBaseUrl = apiUrl.replace(/\/api\/codex\/upsert-file\/?$/, '');
    if (projectIds.length === 0) return;
    
    // Sync to all selected projects
    for (const projectId of projectIds) {

    await waitForBackendReady(apiBaseUrl);

    const content = document.getText();
    if (!content || content.trim().length === 0) return;

    const relativePath = vscode.workspace.asRelativePath(document.uri);
    const contentHash = crypto.createHash('md5').update(content).digest('hex');
    const repoExternalId = `vscode-local-${projectId}`;
    const repoName = vscode.workspace.getWorkspaceFolder(document.uri)?.name || 'Local Workspace';

    if (showStatus) vscode.window.setStatusBarMessage(`$(sync~spin) Syncing ${relativePath}...`, 2000);

    const MAX_RETRIES = 5;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await authFetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId,
                    origin: 'vscode',
                    repoExternalId,
                    repoName,
                    filePath: relativePath,
                    language: document.languageId,
                    content,
                    contentHash,
                    lastModified: new Date().toISOString()
                })
            });

            if (!response.ok) {
                if (response.status === 401) return; // Auth handler already prompted
                
                if (response.status >= 500 && attempt < MAX_RETRIES) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const errText = await response.text();
                outputChannel.appendLine(`❌ Sync rejected (${response.status}) ${relativePath}: ${errText}`);
                if (showStatus && !collector) vscode.window.showErrorMessage(`Sync rejected (${response.status}) for ${relativePath}`);
                return;
            }

            const result = await response.json() as {
                success?: boolean;
                status?: string;
                chunksInserted?: number;
                skipped?: boolean;
                reason?: string;
                message?: string;
                pattern?: string;
                redaction?: {
                    redacted: boolean;
                    findings: Array<{ ruleId: string; line: number; message: string }>;
                };
            };

            // ────────────────────────────────────────────────────────
            // Secret guard: file refused outright (HTTP 200 + skipped).
            // ────────────────────────────────────────────────────────
            if (result.success === false && result.skipped) {
                if (result.reason === 'secret_filename_blocked') {
                    outputChannel.appendLine(
                        `🛡️ Skipped (secret-bearing filename): ${relativePath}` +
                        (result.pattern ? ` [pattern: ${result.pattern}]` : '')
                    );
                    if (collector) {
                        collector.denylistSkips.push({ path: relativePath, pattern: result.pattern });
                    } else if (showStatus) {
                        vscode.window.showWarningMessage(
                            `ContextBridge: "${relativePath}" was not indexed because its filename is on the secret denylist. The file remains on your machine; it was simply not uploaded.`
                        );
                    }
                } else if (result.reason === 'secret_scan_error') {
                    outputChannel.appendLine(`⚠️ Skipped (secret scan failed): ${relativePath}`);
                    if (collector) {
                        collector.scanErrors.push({ path: relativePath });
                    } else if (showStatus) {
                        vscode.window.showWarningMessage(
                            `ContextBridge: "${relativePath}" was not indexed because the secret scanner errored out. We err on the side of caution.`
                        );
                    }
                } else {
                    // Other skip reasons (e.g. invalid_path) — log only, no toast.
                    outputChannel.appendLine(`⏭️ Skipped (${result.reason ?? 'unknown'}): ${relativePath}`);
                }
                break;
            }

            // ────────────────────────────────────────────────────────
            // Secret guard: file synced but some lines were redacted.
            // ────────────────────────────────────────────────────────
            if (result.redaction?.redacted) {
                const findings = result.redaction.findings ?? [];
                const lineList = findings.map(f => `line ${f.line} (${f.ruleId})`).join(', ');
                outputChannel.appendLine(`🛡️ Synced WITH REDACTIONS ${relativePath}: ${findings.length} secret(s) removed — ${lineList}`);
                if (collector) {
                    collector.redactions.push({ path: relativePath, findings });
                } else if (showStatus) {
                    vscode.window.showWarningMessage(
                        `ContextBridge: Redacted ${findings.length} secret(s) from "${relativePath}" before indexing. The uploaded copy has those lines replaced with placeholders.`,
                        'Show Details'
                    ).then(choice => {
                        if (choice === 'Show Details') {
                            outputChannel.show();
                        }
                    });
                }
                break;
            }

            // ────────────────────────────────────────────────────────
            // Normal sync path.
            // ────────────────────────────────────────────────────────
            if (result.status !== 'no_change') {
                outputChannel.appendLine(`✅ Synced ${relativePath}`);
                if (showStatus && !collector) vscode.window.setStatusBarMessage(`$(check) Synced ${relativePath}`, 3000);
            } else {
                outputChannel.appendLine(`⏭️ No change ${relativePath}`);
            }

            break;

        } catch (error: any) {
            const msg = String(error?.message || '').toLowerCase();
            const code = String(error?.code || '').toUpperCase();

            const isConnectionError =
                msg.includes('econnrefused') ||
                msg.includes('socket hang up') ||
                msg.includes('etimedout') ||
                msg.includes('econnreset') ||
                code === 'ECONNRESET' ||
                code === 'ECONNREFUSED' ||
                code === 'ETIMEDOUT' ||
                msg.startsWith('http 5');

            if (!isConnectionError || attempt === MAX_RETRIES) {
                outputChannel.appendLine(`❌ Sync Failed ${relativePath} after ${attempt} attempts: ${error?.message || error}`);
                if (showStatus) vscode.window.showErrorMessage(`Sync failed: ${relativePath}`);
                return;
            }

            const delay = attempt * 700 + Math.floor(Math.random() * 200);
            outputChannel.appendLine(`⚠️ Backend busy/restarting. Retrying in ${delay}ms... (${attempt}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, delay));

            await waitForBackendReady(apiBaseUrl);
        }
    }
}
}