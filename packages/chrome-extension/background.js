// background.js - Interceptor version (no chrome.debugger)
console.log('🚀 ContextBridge background script starting...');

// ============================================================
// POST-INSTALL WELCOME PAGE
// ============================================================
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: 'https://ctxbridge.io/welcome' });
  }
});

let captureActive = false;
let capturedData = {};
let originalProjectUrl = null;
let activeTabId = null;
let progressPopupId = null;
let progressWindowId = null;
let claudeConversationTimestamps = {};
let scrapedConversationTitles = {};
let openaiConversationTimestamps = {};
let geminiConversationTimestamps = {};
let grokConversationTimestamps = {};
let grokResponseNodes = {};  // Store response nodes (message IDs + sender info)
let grokConversationsList = [];  // Store full conversation list from interceptor
let currentOpenAIGizmoId = null;
let geminiConversationProjectMap = {};  // convId → notebookProjectId
let geminiDefaultProjectId = null;

const pendingEnrichment = new Map();
// Cache for existing content IDs (to avoid repeated queries)
const existingContentCache = new Map();
const CACHE_DURATION = 60000; // 60 seconds

// ============================================================
// AUTOMATIC SYNC - Configuration
// ============================================================
const SYNC_ALARM_NAME = 'contextbridge-auto-sync';
const SYNC_INTERVAL_MINUTES = 60; // 1 hour

// Helper function to fetch and cache existing content for a conversation
async function getExistingContent(conversationId) {
  const now = Date.now();
  
  // Check cache first
  const cached = existingContentCache.get(conversationId);
  if (cached && (now - cached.timestamp) < CACHE_DURATION) {
    console.log(`[Cache HIT] Using cached content for ${conversationId}`);
    return cached.data;
  }
  
  // Cache miss - fetch from backend
  console.log(`[Cache MISS] Fetching existing content for ${conversationId}`);
  
  try {
    const response = await authFetch(`${BACKEND_URL}/api/conversations/${conversationId}/existing-content`);
    
    if (!response.ok) {
      console.error(`Failed to fetch existing content: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    
    // Store in cache
    existingContentCache.set(conversationId, {
      data: data,
      timestamp: now
    });
    
    console.log(`[Cache] Stored content for ${conversationId}: ${data.existing_message_ids.length} messages, ${data.existing_file_ids.length} files, ${data.existing_block_ids.length} blocks`);
    
    return data;
    
  } catch (error) {
    console.error(`Error fetching existing content for ${conversationId}:`, error);
    return null;
  }
}

// Filter captured conversation data to remove existing content (via backend API)
async function filterExistingContent(conversationData, existingContent) {
  if (!existingContent || !conversationData) {
    console.log('[Filter] No existing content or conversation data - returning original');
    return conversationData;
  }
  
  console.log(`[Filter] Sending to backend for filtering: ${conversationData.id}`);
  
  try {
    const response = await authFetch(`${BACKEND_URL}/api/utils/filter-existing-content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationData, existingContent })
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    console.log(`[Filter] Results for ${conversationData.id}:`);
    console.log(`  - Messages: ${data.stats.newMessages} new, ${data.stats.skippedMessages} already exist`);
    
    if (data.stats.newMessages === 0) {
      console.log(`[Filter] ⚠️ No new content to capture for ${conversationData.id}`);
    }
    
    return data.filtered;
  } catch (error) {
    console.error('[Filter] API call failed:', error);
    // Fallback: return original data if API fails
    console.log('[Filter] Falling back to unfiltered data');
    return conversationData;
  }
}

// Generate deterministic UUID from OpenAI gizmo_id (via backend API)
async function gizmoIdToUUID(gizmoId) {
  try {
    const response = await authFetch(`${BACKEND_URL}/api/utils/gizmo-to-uuid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gizmoId })
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.uuid;
  } catch (error) {
    console.error('[gizmoIdToUUID] API call failed:', error);
    throw error;
  }
}

// Convert 16-char Gemini ID to valid 36-char PostgreSQL UUID format
function formatGeminiIdToUUID(geminiId) {
  if (!geminiId) return null;
  // Duplicate the 16-char string to ensure we have 32 hex chars
  const padded = (geminiId + geminiId).padEnd(32, '0').slice(0, 32);
  // Inject the standard 8-4-4-4-12 UUID hyphens
  return `${padded.slice(0,8)}-${padded.slice(8,12)}-${padded.slice(12,16)}-${padded.slice(16,20)}-${padded.slice(20)}`;
}

// Backend configuration
const DEFAULT_BACKEND_URL = 'https://api.ctxbridge.io';
let BACKEND_URL = DEFAULT_BACKEND_URL;
let storageMode = 'both';
let authTokens = { accessToken: null, refreshToken: null };

// Load backend URL and auth tokens from storage on startup
chrome.storage.sync.get(['backendUrl', 'accessToken', 'refreshToken'], (result) => {
  if (result.backendUrl) {
    BACKEND_URL = result.backendUrl;
    console.log('📡 Backend URL loaded:', BACKEND_URL);
  } else {
    console.log('📡 Using default backend URL:', BACKEND_URL);
  }
  
  if (result.accessToken) {
    authTokens.accessToken = result.accessToken;
    authTokens.refreshToken = result.refreshToken;
    console.log('🔐 Auth tokens loaded');
  }
});

// Listen for auth state changes from options page
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'openOptionsPage') {
    chrome.runtime.openOptionsPage();
    return false;
  }

  if (request.type === 'AUTH_STATE_CHANGED') {
    if (request.user) {
      chrome.storage.sync.get(['accessToken', 'refreshToken'], (result) => {
        authTokens.accessToken = result.accessToken;
        authTokens.refreshToken = result.refreshToken;
        console.log('🔐 Auth tokens updated after login');
      });
    } else {
      authTokens.accessToken = null;
      authTokens.refreshToken = null;
      console.log('🔐 Auth tokens cleared after logout');
    }
  }
});

// Helper function to refresh tokens
async function refreshAuthTokens() {
  if (!authTokens.refreshToken) return false;
  
  try {
    const response = await fetch(`${BACKEND_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: authTokens.refreshToken })
    });
    
    if (response.ok) {
      const data = await response.json();
      authTokens.accessToken = data.tokens.accessToken;
      authTokens.refreshToken = data.tokens.refreshToken;
      
      // Persist to storage
      await chrome.storage.sync.set({
        accessToken: data.tokens.accessToken,
        refreshToken: data.tokens.refreshToken
      });
      
      console.log('🔐 Tokens refreshed successfully');
      return true;
    }
  } catch (error) {
    console.error('🔐 Token refresh failed:', error);
  }
  return false;
}

// Authenticated fetch wrapper
async function authFetch(url, options = {}) {
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
      options.headers['Authorization'] = `Bearer ${authTokens.accessToken}`;
      response = await fetch(url, options);
    }
  }
  
  // If still 401 after refresh attempt, prompt user to sign in
  if (response.status === 401) {
    showSignInRequired();
  }
  
  return response;
}

// Show notification prompting user to sign in
function showSignInRequired() {
  chrome.notifications.create('auth-required', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'ContextBridge: Sign In Required',
    message: 'Please sign in to continue capturing conversations.',
    buttons: [{ title: '🔑 Sign In' }],
    requireInteraction: true,
    priority: 2
  });
}

/**
 * Injects a confirmation dialog into the active tab and waits for user response.
 * Includes an optional input field for topic filtering.
 */
async function promptUserInTab(tabId, title, message, confirmText, cancelText, showInput = false) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: (t, m, confirmBtn, cancelBtn, showInp) => {
        return new Promise((resolve) => {
          const existing = document.getElementById('ctxbridge-prompt-toast');
          if (existing) existing.remove();

          const overlay = document.createElement('div');
          overlay.id = 'ctxbridge-prompt-toast';
          overlay.style.cssText = `
            position: fixed; top: 24px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
            width: 480px; padding: 24px; border-radius: 12px;
            background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            box-shadow: 0 12px 40px rgba(0,0,0,0.8); border: 1px solid rgba(99,102,241,0.5);
            animation: ctxSlideDown 0.3s ease-out;
          `;
          
          const inputHtml = showInp ? `
            <div style="margin-bottom: 20px;">
              <label style="display:block; font-size: 13px; color: #a5b4fc; margin-bottom: 6px;">Optional: Filter by Topic/Keyword (searches titles)</label>
              <input type="text" id="ctx-keyword-input" placeholder="e.g., 'React', 'Financial Model'" style="
                width: 100%; box-sizing: border-box; padding: 10px; border-radius: 6px; 
                background: rgba(0,0,0,0.2); border: 1px solid rgba(99,102,241,0.3); color: white; font-size: 14px;
              ">
            </div>
          ` : '';

          overlay.innerHTML = `
            <style>
              @keyframes ctxSlideDown { from { opacity: 0; transform: translate(-50%, -20px); } to { opacity: 1; transform: translate(-50%, 0); } }
            </style>
            <div style="font-weight:600;font-size:18px;color:#fff;margin-bottom:12px;display:flex;align-items:center;gap:10px;">
              ⚠️ ${t}
            </div>
            <p style="margin:0 0 ${showInp ? '12px' : '20px'} 0;font-size:14px;line-height:1.6;color:#c0c0c0;">${m}</p>
            ${inputHtml}
            <div style="display:flex; justify-content:flex-end; gap:12px;">
              <button id="ctx-btn-cancel" style="background:rgba(255,255,255,0.1);color:#fff;border:none;padding:10px 18px;border-radius:6px;cursor:pointer;font-size:14px;">${cancelBtn}</button>
              <button id="ctx-btn-confirm" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;padding:10px 18px;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">${confirmBtn}</button>
            </div>
          `;
          document.body.appendChild(overlay);

          if (showInp) document.getElementById('ctx-keyword-input').focus();

          document.getElementById('ctx-btn-cancel').onclick = () => { 
            overlay.remove(); resolve({ proceed: false }); 
          };
          document.getElementById('ctx-btn-confirm').onclick = () => { 
            const keyword = showInp ? document.getElementById('ctx-keyword-input').value.trim() : null;
            overlay.remove(); resolve({ proceed: true, keyword: keyword }); 
          };
        });
      },
      args: [title, message, confirmText, cancelText, showInput]
    });
    return result.result;
  } catch (e) {
    console.error("Failed to prompt user in tab:", e);
    return { proceed: false };
  }
}

// Handle sign-in notification button click
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId === 'auth-required' && buttonIndex === 0) {
    chrome.notifications.clear(notificationId);
    chrome.runtime.openOptionsPage();
  }
});

// Also handle notification click (not just button)
chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === 'auth-required') {
    chrome.notifications.clear(notificationId);
    chrome.runtime.openOptionsPage();
  }
});

// ============================================================================
// REGISTER INTERCEPTOR FOR OPENAI (Runs before page scripts)
// ============================================================================
(async function registerOpenAIInterceptor() {
  try {
    // Unregister first (in case of extension reload)
    await chrome.scripting.unregisterContentScripts({ ids: ['openai-interceptor'] }).catch(() => {});
    
    // Register the interceptor to run at document_start in MAIN world
    await chrome.scripting.registerContentScripts([{
      id: 'openai-interceptor',
      matches: ['*://chatgpt.com/*', '*://chat.openai.com/*'],
      js: ['injected_interceptor.js'],
      runAt: 'document_start',
      world: 'MAIN'
    }]);
    console.log('✅ Registered OpenAI interceptor as content script');
  } catch (e) {
    console.error('❌ Failed to register OpenAI interceptor:', e);
  }
})();

// ============================================================================
// REGISTER INTERCEPTOR FOR GROK
// ============================================================================
(async function registerGrokInterceptor() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['grok-interceptor'] }).catch(() => {});
    
    await chrome.scripting.registerContentScripts([{
      id: 'grok-interceptor',
      matches: ['*://grok.com/*'],
      js: ['injected_interceptor.js'],
      runAt: 'document_start',
      world: 'MAIN'
    }]);
    console.log('✅ Registered Grok interceptor as content script');
  } catch (e) {
    console.error('❌ Failed to register Grok interceptor:', e);
  }
})();

// Handle external messages from dashboard (api.ctxbridge.io)
chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  console.log('📨 External message received:', request.action, 'from:', sender.origin);
  
  if (request.action === 'GET_AUTH_TOKEN') {
    // Handle async token retrieval and refresh
    (async () => {
      try {
        // Get tokens from storage
        const stored = await chrome.storage.sync.get(['accessToken', 'refreshToken', 'userId', 'user']);
        
        if (!stored.accessToken) {
          sendResponse({ success: false, error: 'Not authenticated' });
          return;
        }
        
        // Validate token by calling /api/auth/me
        const validateResponse = await fetch(`${BACKEND_URL}/api/auth/me`, {
          headers: { 'Authorization': `Bearer ${stored.accessToken}` }
        });
        
        if (validateResponse.ok) {
          // Token is still valid
          authTokens.accessToken = stored.accessToken;
          authTokens.refreshToken = stored.refreshToken;
          sendResponse({ 
            success: true, 
            accessToken: stored.accessToken,
            userId: stored.userId
          });
          return;
        }
        
        // Token expired, try to refresh
        if (validateResponse.status === 401 && stored.refreshToken) {
          console.log('🔐 Token expired, attempting refresh...');
          
          const refreshResponse = await fetch(`${BACKEND_URL}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: stored.refreshToken })
          });
          
          if (refreshResponse.ok) {
            const data = await refreshResponse.json();
            
            // Update storage and memory
            await chrome.storage.sync.set({
              accessToken: data.tokens.accessToken,
              refreshToken: data.tokens.refreshToken
            });
            
            authTokens.accessToken = data.tokens.accessToken;
            authTokens.refreshToken = data.tokens.refreshToken;
            
            console.log('🔐 Token refreshed successfully');
            sendResponse({ 
              success: true, 
              accessToken: data.tokens.accessToken,
              refreshToken: data.tokens.refreshToken,
              userId: stored.userId,
              user: stored.user
            });
            return;
          }
        }
        
        // Could not validate or refresh
        sendResponse({ success: false, error: 'Token expired and refresh failed' });
        
      } catch (error) {
        console.error('🔐 Error handling GET_AUTH_TOKEN:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    
    return true; // Keep channel open for async response
  }

  if (request.action === 'SET_ACTIVE_PROJECT' && request.projectId) {
    chrome.storage.sync.set({ activeProjectId: request.projectId }, () => {
      console.log('🗂️ Active project set:', request.projectId);
      sendResponse({ success: true });
    });
    return true;
  }
  
  return true;
});

// ============================================================================
// REGISTER INTERCEPTOR FOR GEMINI
// ============================================================================
(async function registerGeminiInterceptor() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['gemini-interceptor'] }).catch(() => {});
    
    await chrome.scripting.registerContentScripts([{
      id: 'gemini-interceptor',
      matches: ['*://gemini.google.com/*'],
      js: ['injected_interceptor.js'],
      runAt: 'document_start',
      world: 'MAIN'
    }]);
    console.log('✅ Registered Gemini interceptor as content script');
  } catch (e) {
    console.error('❌ Failed to register Gemini interceptor:', e);
  }
})();

// ============================================================================
// REGISTER INTERCEPTOR FOR CLAUDE.AI
// ============================================================================
(async function registerClaudeInterceptor() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['claude-interceptor'] }).catch(() => {});
    
    await chrome.scripting.registerContentScripts([{
      id: 'claude-interceptor',
      matches: ['*://claude.ai/*'],
      js: ['injected_interceptor.js'],
      runAt: 'document_start',
      world: 'MAIN'
    }]);
    console.log('✅ Registered Claude interceptor as content script');
  } catch (e) {
    console.error('❌ Failed to register Claude interceptor:', e);
  }
})();

// ============================================================
// SINGLE CONSOLIDATED MESSAGE LISTENER
// ============================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Message received in background:', request.action || request.type);

  // ---- Settings Update ----
  if (request.type === 'SETTINGS_UPDATED' && request.backendUrl) {
    BACKEND_URL = request.backendUrl;
    console.log('📡 Backend URL updated:', BACKEND_URL);
    return false;
  }

  // ---- Fresh Auth Token Request (from content script for dashboard) ----
  if (request.action === 'GET_FRESH_AUTH_TOKEN') {
    (async () => {
      try {
        const stored = await chrome.storage.sync.get(['accessToken', 'refreshToken', 'userId', 'user']);
        
        if (!stored.accessToken) {
          sendResponse({ success: false, error: 'Not authenticated' });
          return;
        }
        
        // Validate token by calling /api/auth/me
        const validateResponse = await fetch(`${BACKEND_URL}/api/auth/me`, {
          headers: { 'Authorization': `Bearer ${stored.accessToken}` }
        });
        
        if (validateResponse.ok) {
          // Token is still valid
          console.log('🔐 Token still valid, returning to content script');
          sendResponse({ 
            success: true, 
            accessToken: stored.accessToken,
            refreshToken: stored.refreshToken,
            userId: stored.userId,
            user: stored.user
          });
          return;
        }
        
        // Token expired, try to refresh
        if (validateResponse.status === 401 && stored.refreshToken) {
          console.log('🔐 Token expired, refreshing...');
          
          const refreshResponse = await fetch(`${BACKEND_URL}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: stored.refreshToken })
          });
          
          if (refreshResponse.ok) {
            const data = await refreshResponse.json();
            
            // Update storage and memory
            await chrome.storage.sync.set({
              accessToken: data.tokens.accessToken,
              refreshToken: data.tokens.refreshToken
            });
            
            authTokens.accessToken = data.tokens.accessToken;
            authTokens.refreshToken = data.tokens.refreshToken;
            
            console.log('🔐 Token refreshed, returning to content script');
            sendResponse({ 
              success: true, 
              accessToken: data.tokens.accessToken,
              refreshToken: data.tokens.refreshToken,
              userId: stored.userId,
              user: stored.user
            });
            return;
          }
        }
        
        sendResponse({ success: false, error: 'Token expired and refresh failed' });
        
      } catch (error) {
        console.error('🔐 Error getting fresh token:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // Keep channel open for async response
  }

  // ---- Set Active Project (from dashboard via content script) ----
  if (request.action === 'SET_ACTIVE_PROJECT' && request.projectId) {
    chrome.storage.sync.set({ activeProjectId: request.projectId }, () => {
      console.log('🗂️ Active project set:', request.projectId);
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'INJECT_INTERCEPTOR') {
  (async () => {
    try {
      // ✅ Use sender.tab.id - the tab that SENT the message
      const tabId = sender.tab?.id;
      if (!tabId) {
        sendResponse({ success: false, error: 'No sender tab' });
        return;
      }
      
      // Skip extension pages
      if (sender.tab.url?.startsWith('chrome-extension://')) {
        sendResponse({ success: false, error: 'Skip extension page' });
        return;
      }
      
      await chrome.scripting.executeScript({
        target: { tabId: tabId },  // ← Use sender's tab, not active tab
        world: 'MAIN',
        func: () => {
          if (window.__cbInterceptorActive) {
            console.log('⏭️ Interceptor already active');
            return;
          }
          
          const originalFetch = window.fetch;
          window.fetch = async function(...args) {
            const [resource, config] = args;
            const response = await originalFetch(resource, config);
            const clone = response.clone();
            const url = resource.toString();

            if (url.includes('/backend-api/')) {
              if (url.includes('/conversations') && (url.includes('?') || url.endsWith('/conversations'))) {
                clone.json().then(data => {
                  console.log('📡 [Interceptor] OpenAI LIST captured');
                  window.postMessage({ type: 'CTX_INTERCEPT_LIST', platform: 'openai', payload: data }, '*');
                }).catch(() => {});
              }
              else if (url.match(/\/conversation\/[a-f0-9-]+/)) {
                clone.json().then(data => {
                  const match = url.match(/\/conversation\/([a-f0-9-]+)/);
                  if (match && data) {
                    console.log('📡 [Interceptor] OpenAI DETAIL captured:', match[1]);
                    data._interceptedId = match[1];
                    window.postMessage({ type: 'CTX_INTERCEPT_DETAIL', platform: 'openai', payload: data }, '*');
                  }
                }).catch(() => {});
              }
            }
            return response;
          };
          window.__cbInterceptorActive = true;
          console.log('✅ ContextBridge: Fetch interceptor active');
        }
      });
      sendResponse({ success: true });
    } catch (e) {
      console.error('❌ Interceptor injection failed:', e);
      sendResponse({ success: false, error: e.message });
    }
  })();
  return true;
}

  // ---- POST Proxy (for CORS) ----
  if (request.action === 'postToBackend') {
    fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body
    })
    .then(response => response.text())
    .then(body => {
      sendResponse({ ok: true, body });
    })
    .catch(error => {
      console.error('Background POST error:', error);
      sendResponse({ ok: false, error: error.message });
    });
    return true; // Keep channel open for async response
  }

  // ---- User Activity (Auto-Sync) ----
  if (request.action === 'userActivity') {
    console.log('[Auto-Sync] User activity detected:', request);
    
    const { provider, projectId, conversationId, timestamp } = request;
    
    if (!projectId) {
      sendResponse({ success: false, error: 'No projectId' });
      return true;
    }
    
    const alarmName = `sync-project-${projectId}`;
    
    chrome.alarms.get(alarmName, (existingAlarm) => {
      if (existingAlarm) {
        console.log(`[Auto-Sync] Alarm already exists for project ${projectId}, not resetting`);
        sendResponse({ success: true, alarmSet: false, reason: 'already exists' });
      } else {
        chrome.alarms.create(alarmName, {
          delayInMinutes: SYNC_INTERVAL_MINUTES
        });
        
        chrome.storage.local.get('activeProjects', (result) => {
          const activeProjects = result.activeProjects || {};
          activeProjects[projectId] = {
            provider,
            projectId,
            firstActivity: timestamp,
            conversationId
          };
          chrome.storage.local.set({ activeProjects });
        });
        
        console.log(`[Auto-Sync] NEW alarm set for project ${projectId} in ${SYNC_INTERVAL_MINUTES} minutes`);
        sendResponse({ success: true, alarmSet: true });
      }
    });
    return true; // Keep channel open for async response
  }

  // ---- Intercepted LIST Data (Timestamps) ----
  if (request.action === 'PROCESS_INTERCEPTED_DATA') {
    const { platform, payload } = request;
    console.log(`📡 Received intercepted LIST from ${platform}`);
    
    if (platform === 'claude') {
      const items = Array.isArray(payload) ? payload : (payload.data || payload.conversations || []);
      let count = 0;
      items.forEach(conv => {
        if (conv.uuid && conv.updated_at) {
          claudeConversationTimestamps[conv.uuid] = conv.updated_at;
          count++;
        }
      });
      console.log(`📋 Stored ${count} Claude conversation timestamps`);
    }
    
    if (platform === 'openai') {
      const items = payload.items || payload;
      if (Array.isArray(items)) {
        let count = 0;
        items.forEach(conv => {
          if (conv.id && conv.update_time) {
            let timestamp;
            if (typeof conv.update_time === 'string') {
              timestamp = conv.update_time;
            } else if (typeof conv.update_time === 'number') {
              timestamp = new Date(conv.update_time * 1000).toISOString();
            }
            if (timestamp) {
              openaiConversationTimestamps[conv.id] = timestamp;
              count++;
            }
          }
        });
        console.log(`📋 Stored ${count} OpenAI conversation timestamps`);
      }
    }

    if (platform === 'grok') {
      const items = payload.conversations || [];
      let count = 0;
      
      // Store full list for later use (include workspaces for filtering)
      grokConversationsList = items.map(conv => ({
        id: conv.conversationId,
        title: conv.title || 'Untitled',
        modifyTime: conv.modifyTime,
        createTime: conv.createTime,
        workspaces: conv.workspaces || []  // Include workspace IDs for project filtering
      }));
      
      items.forEach(conv => {
        if (conv.conversationId && conv.modifyTime) {
          grokConversationTimestamps[conv.conversationId] = conv.modifyTime;
          count++;
        }
      });
      console.log(`📋 Stored ${count} Grok conversation timestamps and ${grokConversationsList.length} total conversations`);
    }
    
    sendResponse({ success: true });
    return false;
  }

  // ---- Intercepted DETAIL Data (Conversation Content) ----
  if (request.action === 'PROCESS_INTERCEPTED_DETAIL') {
    const { platform, payload } = request;
    console.log(`📡 Received intercepted DETAIL from ${platform}`);
    
    // Only process if capture is active
    if (!captureActive) {
      console.log('[Interceptor] Ignoring detail - capture not active');
      sendResponse({ success: false, reason: 'capture not active' });
      return false;
    }
    
    if (platform === 'claude') {
      const convId = payload._interceptedId || payload.uuid;
      
      if (convId && payload.chat_messages) {
        // ✅ RESTORED LOGIC: Enrich messages with Files and Artifacts
        // We make this an async IIFE so we don't block the message listener
        let _enrichResolve;
        pendingEnrichment.set(convId, new Promise(r => { _enrichResolve = r; }));
        (async () => { 
          try { 
             // 1. Fetch PDFs in files_v2
             const messagesWithPdfContent = await Promise.all(
                payload.chat_messages.map(async (msg) => {
                  if (msg.files_v2 && msg.files_v2.length > 0) {
                    const enrichedFiles = await Promise.all(
                      msg.files_v2.map(async (fileInfo) => {
                        // Check if it's a PDF and has a URL
                        if (fileInfo.file_name?.toLowerCase().endsWith('.pdf') && fileInfo.document_asset?.url) {
                          try {
                            console.log(`[PDF] Fetching: ${fileInfo.file_name}`);
                            const pdfUrl = `https://claude.ai${fileInfo.document_asset.url}`;
                            // Standard fetch works here because we have host permissions + cookies
                            const pdfResponse = await fetch(pdfUrl); 
                            if (pdfResponse.ok) {
                              const pdfBlob = await pdfResponse.blob();
                              const base64 = await new Promise((resolve) => {
                                const reader = new FileReader();
                                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                                reader.readAsDataURL(pdfBlob);
                              });
                              console.log(`[PDF] ✅ Fetched ${fileInfo.file_name}: ${base64.length} chars`);
                              return { ...fileInfo, pdf_base64: base64 };
                            }
                          } catch (e) {
                            console.error(`[PDF] Failed to fetch ${fileInfo.file_name}:`, e);
                          }
                        }
                        return fileInfo;
                      })
                    );
                    return { ...msg, files_v2: enrichedFiles };
                  }
                  return msg;
                })
             );

             // 2. Fetch Artifacts (Code/Text downloads)
             // We try to extract orgId from the intercepted URL passed from content script
             const url = payload._interceptedUrl || '';
             const orgIdMatch = url.match(/organizations\/([a-f0-9-]+)/);
             const orgId = orgIdMatch ? orgIdMatch[1] : (payload.account_uuid || payload.organization_uuid);
             
             const messagesWithArtifacts = await Promise.all(
                messagesWithPdfContent.map(async (msg) => {
                  if (!msg.content || !Array.isArray(msg.content)) return msg;
                  
                  const enrichedContent = await Promise.all(
                    msg.content.map(async (block) => {
                      // Check for 'present_files' (Claude's internal name for Artifacts/Code)
                      if (block.type === 'tool_use' && block.name === 'present_files' && block.input?.filepaths && orgId) {
                         const artifactFiles = [];
                         for (const filepath of block.input.filepaths) {
                            try {
                                const encodedPath = encodeURIComponent(filepath);
                                const downloadUrl = `https://claude.ai/api/organizations/${orgId}/conversations/${convId}/wiggle/download-file?path=${encodedPath}`;
                                
                                console.log(`[Artifact] Fetching: ${filepath}`);
                                const response = await fetch(downloadUrl); // Creds are auto-included by Chrome
                                
                                if (response.ok) {
                                    const blob = await response.blob();
                                    const base64 = await new Promise((resolve) => {
                                        const reader = new FileReader();
                                        reader.onloadend = () => resolve(reader.result.split(',')[1]);
                                        reader.readAsDataURL(blob);
                                    });
                                    const fileName = filepath.split('/').pop();
                                    artifactFiles.push({
                                        file_name: fileName,
                                        file_path: filepath,
                                        artifact_base64: base64,
                                        mime_type: response.headers.get('content-type') || 'application/octet-stream'
                                    });
                                    console.log(`[Artifact] ✅ Fetched ${fileName}`);
                                } else {
                                    console.warn(`[Artifact] Failed ${response.status}`);
                                }
                            } catch(e) { console.error('[Artifact] Error:', e); }
                         }
                         // If we successfully fetched files, attach them to the block
                         if (artifactFiles.length > 0) {
                             return { ...block, artifact_files: artifactFiles };
                         }
                      }
                      return block;
                    })
                  );
                  return { ...msg, content: enrichedContent };
                })
             );

            // 3. Map to final format
            const messages = messagesWithArtifacts.map(msg => ({
              uuid: msg.uuid,
              sender: msg.sender,
              text: msg.text || '',
              created_at: msg.created_at,
              updated_at: msg.updated_at,
              files_v2: msg.files_v2 || [],
              content: msg.content || []
            }));
            
            capturedData[convId] = {
              id: convId,
              name: payload.name || 'Untitled',
              messages: messages,
              created_at: payload.created_at,
              updated_at: payload.updated_at,
              project_id: payload.project_uuid,
              provider: 'claude',
              message_count: messages.length,
              url: payload.project_uuid 
                ? `https://claude.ai/project/${payload.project_uuid}/chat/${convId}`
                : `https://claude.ai/chat/${convId}`
            };
            console.log(`✅ Interceptor saved Claude conversation ${convId}: ${messages.length} messages`);
            _enrichResolve(true);
            
          } catch (err) {
            console.error('[Interceptor] Error processing Claude detail:', err);
            _enrichResolve(false);
          }
        })();
      }
    }
    
    if (platform === 'openai') {
       // (Your existing OpenAI Logic here is fine, keep it as is)
       const convId = payload._interceptedId;
       if (convId && payload.mapping) {
        (async () => {
          try {
            // ✅ Store timestamp from DETAIL (source of truth)
            if (payload.update_time) {
              openaiConversationTimestamps[convId] = 
                new Date(payload.update_time * 1000).toISOString();
              console.log(`📋 [OpenAI] Stored timestamp from DETAIL: ${convId}`);
            }
            const messages = await parseOpenAIMessages(payload.mapping);
            const gizmoId = payload.gizmo_id;
            const projectUUID = (typeof gizmoId === 'string' && gizmoId.length > 0) 
              ? await gizmoIdToUUID(gizmoId) 
              : null;
            
            capturedData[convId] = {
              id: convId,
              name: payload.title || 'Untitled',
              messages: messages,
              created_at: new Date(payload.create_time * 1000).toISOString(),
              updated_at: new Date(payload.update_time * 1000).toISOString(),
              project_id: projectUUID,
              provider: 'openai',
              provider_project_id: gizmoId,
              message_count: messages.length,
              url: gizmoId 
                ? `https://chatgpt.com/g/${gizmoId}/c/${convId}`
                : `https://chatgpt.com/c/${convId}`
            };
            console.log(`✅ Captured OpenAI conversation ${convId}: ${messages.length} messages`);
          } catch (err) {
            console.error(`[Interceptor] Failed to parse OpenAI conversation ${convId}:`, err);
          }
        })();
      }
    }

    if (platform === 'grok') {
      const convId = payload._interceptedId;
      if (convId && payload.responses) {
        (async () => {
          try {
            // Get response nodes for sender info (stored from earlier intercept)
            const responseNodes = grokResponseNodes[convId] || [];
            const senderMap = new Map(responseNodes.map(n => [n.responseId, n.sender]));
            
            // Map responses to messages format
            const messages = payload.responses.map((resp, index) => ({
              uuid: resp.responseId,
              sender: senderMap.get(resp.responseId) || resp.sender || 'unknown',
              text: resp.message || '',
              created_at: resp.createTime || new Date().toISOString(),
              updated_at: resp.modifyTime || new Date().toISOString(),
              index: index
            }));
            
            capturedData[convId] = {
              id: convId,
              name: grokConversationsList.find(c => c.id === convId)?.title || 'Grok Conversation',
              messages: messages,
              created_at: messages[0]?.created_at || new Date().toISOString(),
              updated_at: messages[messages.length - 1]?.updated_at || new Date().toISOString(),
              provider: 'grok',
              message_count: messages.length,
              url: `https://x.com/i/grok?conversation=${convId}`
            };
            console.log(`✅ Captured Grok conversation ${convId}: ${messages.length} messages`);
          } catch (err) {
            console.error(`[Interceptor] Failed to parse Grok conversation ${convId}:`, err);
          }
        })();
      }
    }

    if (platform === 'gemini') {
      console.log('Gemini payload keys:', Object.keys(payload));
      console.log('Gemini payload:', JSON.stringify(payload, null, 2).slice(0, 500));
      let rawId = payload._interceptedId;
      
      // 1. Array Fix: Extract the first element if Google sent an array
      if (Array.isArray(rawId)) {
        rawId = String(rawId[0]);
      } else {
        rawId = String(rawId);
      }

      // 2. Clean up Google's composite ID
      let originalId = rawId;
      const match = rawId.match(/c_([a-f0-9]+)/i);
      if (match) {
        originalId = match[1];
      } else {
        originalId = rawId.split(',')[0].replace(/^c_/, '');
      }

      // 3. Convert to UUID format
      const convId = formatGeminiIdToUUID(originalId);

      if (convId && payload._turns) {
        (async () => {
          try {
            geminiConversationTimestamps[convId] = new Date().toISOString();
            
            // Pass originalId down to generate message UUIDs
            const { messages, lastModified } = parseGeminiTurns(payload._turns, originalId);

            console.log(`[ProjectMap] convId: ${convId}, mapped project: ${geminiConversationProjectMap[convId]}`);
                capturedData[convId] = {
                  id: convId,
                  name: scrapedConversationTitles[convId] || payload._title || 'Gemini Conversation',
                  messages: messages,
                  created_at: lastModified || new Date().toISOString(),
                  updated_at: lastModified || new Date().toISOString(),
                  provider: 'gemini',
                  project_id: geminiConversationProjectMap[convId] || geminiDefaultProjectId || null,
                  message_count: messages.length,
                  url: `https://gemini.google.com/app/${originalId}`
                };
            console.log(`✅ Captured Gemini conversation ${convId}: ${messages.length} messages, ${messages.reduce((acc, m) => acc + (m.attachments?.length || 0), 0)} blocks`);
          } catch (err) {
            console.error(`[Interceptor] Failed to parse Gemini conversation ${convId}:`, err);
          }
        })();
      }
    }
    
    sendResponse({ success: true });
    return false;
  }

  // ---- Intercepted RESPONSE_NODE Data (Grok message metadata) ----
  if (request.action === 'PROCESS_INTERCEPTED_RESPONSE_NODE') {
    const { platform, payload, conversationId } = request;
    console.log(`📡 Received intercepted RESPONSE_NODE from ${platform}`);
    
    if (platform === 'grok' && payload.responseNodes) {
      grokResponseNodes[conversationId] = payload.responseNodes;
      console.log(`📋 Stored ${payload.responseNodes.length} Grok response nodes for ${conversationId}`);
    }
    
    sendResponse({ success: true });
    return false;
  }

  // ---- Open Dashboard (from widget) ----
  if (request.action === 'openDashboard') {
    (async () => {
      try {
        // Get userId and last captured projectId from storage
        const result = await chrome.storage.sync.get(['userId', 'lastProjectId']);
        const userId = result.userId || 'default';
        const projectId = result.lastProjectId;
        
        let dashboardUrl = `${BACKEND_URL}/project-dashboard`;
        if (projectId) {
          dashboardUrl += `?projectId=${projectId}&userId=${encodeURIComponent(userId)}`;
        }
        // Add auth token if available
        if (authTokens.accessToken) {
          dashboardUrl += `#token=${encodeURIComponent(authTokens.accessToken)}`;
        }
        
        await chrome.tabs.create({ url: dashboardUrl });
        sendResponse({ success: true });
      } catch (error) {
        console.error('[Widget] Failed to open dashboard:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  // ---- Refresh Token (from content scripts) ----
  if (request.action === 'refreshToken') {
    (async () => {
      try {
        const refreshed = await refreshAuthTokens();
        if (refreshed) {
          sendResponse({ success: true, accessToken: authTokens.accessToken });
        } else {
          sendResponse({ success: false, error: 'Refresh failed' });
        }
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // Keep channel open for async response
  }

  // ---- Close Progress Window ----
  if (request.type === 'CLOSE_PROGRESS' || request.action === 'closeProgress') {
    if (progressWindowId) {
      console.log('[Progress] Closing progress window:', progressWindowId);
      chrome.windows.remove(progressWindowId).catch(() => {});
      progressWindowId = null;
      progressPopupId = null;
    }
    return false;
  }

  // ---- Default: unhandled message ----
  return false;
});

// ============================================================
// PROGRESS POPUP FUNCTIONS
// ============================================================
async function openProgressPopup() {
  try {
    const window = await chrome.windows.create({
      url: 'progress.html',
      type: 'popup',
      width: 450,
      height: 500,
      focused: true
    });
    progressWindowId = window.id;
    progressPopupId = window.tabs[0].id;
    await new Promise(resolve => setTimeout(resolve, 1000));
    return progressPopupId;
  } catch (error) {
    console.error('Failed to open progress popup:', error);
  }
}

async function sendProgressUpdate(update) {
  if (!progressPopupId) return;
  
  try {
    await chrome.tabs.sendMessage(progressPopupId, {
      type: 'PROGRESS_UPDATE',
      data: update
    });
  } catch (error) {
    console.error('[Progress] Update failed:', error.message);
  }
}

// Send state update to status widget on AI platform tabs
async function updateWidgetState(state, syncTime = null) {
  try {
    // Persist state to storage so it survives page navigation
    const storageData = { 
      cb_widgetState: state,
      cb_widgetStateTimestamp: Date.now()
    };
    if (syncTime) {
      storageData.cb_lastSyncTime = syncTime;
    }
    await chrome.storage.local.set(storageData);
    
    // Find all AI platform tabs
    const tabs = await chrome.tabs.query({
      url: ['*://claude.ai/*', '*://chatgpt.com/*', '*://chat.openai.com/*', '*://grok.com/*', '*://gemini.google.com/*']
    });
    
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'widgetStateUpdate',
          state: state,
          syncTime: syncTime
        });
      } catch (e) {
        // Tab might not have content script loaded yet
        console.log(`[Widget] Could not update tab ${tab.id}:`, e.message);
      }
    }
    
    console.log(`[Widget] State updated to '${state}' on ${tabs.length} tabs`);
  } catch (error) {
    console.error('[Widget] Failed to update state:', error);
  }
}

// Enhanced function to wait for all embeddings with detailed progress
async function waitForEmbeddingsComplete(projectId, progressWindow) {
  console.log('[Embedding] Starting progress monitoring for project:', projectId);

  let consecutive100s = 0; // Track consecutive 100% checks
  
  let lastState = {
    messages: 0,
    files: 0,
    blocks: 0,
    conversations: 0
  };
  
  while (true) {
    try {
      const response = await authFetch(`${BACKEND_URL}/api/context/embedding-status?projectId=${projectId}`);
      if (!response.ok) {
        console.warn(`[Embedding] Status check returned ${response.status}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 15000));
        continue;
      }
      const status = await response.json();
      
      const current = status.breakdown;
      
      // Check each category for changes and send specific updates
      if (current.messages.embedded !== lastState.messages) {
        const delta = current.messages.embedded - lastState.messages;
        await sendProgressUpdate({
          message: `📝 Messages: +${delta} (total: ${current.messages.embedded}/${current.messages.total})`
        });
        lastState.messages = current.messages.embedded;
      }
      
      if (current.files.embedded !== lastState.files) {
        const delta = current.files.embedded - lastState.files;
        await sendProgressUpdate({
          message: `📁 Files: +${delta} (total: ${current.files.embedded}/${current.files.total})`
        });
        lastState.files = current.files.embedded;
      }
      
      if (current.blocks.embedded !== lastState.blocks) {
        const delta = current.blocks.embedded - lastState.blocks;
        await sendProgressUpdate({
          message: `📦 Blocks: +${delta} (total: ${current.blocks.embedded}/${current.blocks.total})`
        });
        lastState.blocks = current.blocks.embedded;
      }
      
      if (current.conversations.embedded !== lastState.conversations) {
        const delta = current.conversations.embedded - lastState.conversations;
        await sendProgressUpdate({
          message: `💬 Conversations: +${delta} (total: ${current.conversations.embedded}/${current.conversations.total})`
        });
        lastState.conversations = current.conversations.embedded;
      }

      if (current.entities && current.entities.total !== (lastState.entities || 0)) {
        const delta = current.entities.total - (lastState.entities || 0);
        await sendProgressUpdate({
          message: `🏷️ Entities: +${delta} (total: ${current.entities.total})`
        });
        lastState.entities = current.entities.total;
      }
      
      // Also send breakdown for the live updating percentage display
      await sendProgressUpdate({
        breakdown: current
      });
      
      console.log('[Embedding] Progress:', status.percentage + '%', status.breakdown);
      
      // Also send breakdown for the live updating percentage display
      await sendProgressUpdate({
        breakdown: current
      });
      
      console.log('[Embedding] Progress:', status.percentage + '%', status.breakdown);
      
      // Track consecutive 100% readings
      if (status.percentage >= 100) {
        consecutive100s++;
      } else {
        consecutive100s = 0;
      }
      
      // Check if complete (using backend flag, manual count, OR the 3-strike guardrail)
      const isManuallyComplete = 
        current.messages.embedded >= Math.max(1, current.messages.total) &&
        current.files.embedded >= current.files.total &&
        current.blocks.embedded >= current.blocks.total &&
        current.conversations.embedded >= Math.max(1, current.conversations.total);

      if (status.isComplete || (status.percentage >= 100 && isManuallyComplete) || consecutive100s >= 3) {
        console.log(`[Embedding] ✅ Complete! (Consecutive 100s: ${consecutive100s}) Breaking loop.`);
        return true;
      }
      
      // Wait 15 seconds before next check
      await new Promise(resolve => setTimeout(resolve, 15000));
      
    } catch (error) {
      console.error('[Embedding] Status check error:', error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Clean up any stale extension windows on browser startup
chrome.runtime.onStartup.addListener(async () => {
  console.log('[Startup] Browser started, cleaning up...');
  
  // Close any stale progress windows
  if (progressWindowId) {
    chrome.windows.remove(progressWindowId).catch(() => {});
    progressWindowId = null;
    progressPopupId = null;
  }
  
  // Reset capture state
  captureActive = false;
  await chrome.storage.local.set({ 
    cb_widgetState: 'active',
    cb_widgetStateTimestamp: Date.now()
  });
  
  console.log('[Startup] State reset to active');
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log('✅ Extension installed/updated:', details.reason);
  
  // Create recurring alarm for auto-sync
  chrome.alarms.create(SYNC_ALARM_NAME, {
    delayInMinutes: 1, // First check 1 minute after install (for testing)
    periodInMinutes: SYNC_INTERVAL_MINUTES
  });
  
  console.log(`⏰ Auto-sync alarm set: every ${SYNC_INTERVAL_MINUTES} minutes`);
});

async function extractProjectName(tab) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Try to find project name in various places
        // Claude's project pages usually have the project name in an h1 or header
        const selectors = [
          'h1',
          '[class*="project-title"]',
          '[class*="project-name"]',
          'header h2',
          'main h1'
        ];
        
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (element && element.textContent) {
            const text = element.textContent.trim();
            // Skip if it's a generic Claude UI element
            if (!text.includes('Claude') && !text.includes('New chat') && text.length > 0) {
              return text;
            }
          }
        }
        
        // Fallback: extract from document title
        if (document.title && !document.title.includes('Claude')) {
          return document.title.split('|')[0].trim();
        }
        
        return null;
      }
    });
    
    return result?.result || null;
  } catch (error) {
    console.error('Failed to extract project name:', error);
    return null;
  }
}

// ============================================================
// AUTOMATIC SYNC - Alarm Handler & Functions
// ============================================================

// Listen for alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log(`⏰ Alarm triggered: ${alarm.name}`);
  
  if (alarm.name === SYNC_ALARM_NAME) {
    // Global sync check (keeping for backward compatibility)
    await checkForUpdates();
  } else if (alarm.name.startsWith('sync-project-')) {
    // Project-specific sync alarm
    const projectId = alarm.name.replace('sync-project-', '');
    await handleProjectSyncAlarm(projectId);
  }
});

// Handle project-specific sync alarm
async function handleProjectSyncAlarm(projectId) {
  try {
    console.log(`[Auto-Sync] Project sync alarm for: ${projectId}`);
    
    // Get stored project info
    const { activeProjects } = await chrome.storage.local.get('activeProjects');
    const projectInfo = activeProjects?.[projectId];
    
    if (!projectInfo) {
      console.log(`[Auto-Sync] No stored info for project ${projectId}`);
      return;
    }
    
    // Fetch project name from backend
    const response = await authFetch(`${BACKEND_URL}/api/sync/project-status/${projectId}`);
    let projectName = projectId; // Fallback
    
    if (response.ok) {
      // Try to get project name from watched projects
      const watchedResponse = await authFetch(`${BACKEND_URL}/api/sync/watched-projects`);
      if (watchedResponse.ok) {
        const { projects } = await watchedResponse.json();
        const project = projects.find(p => p.id === projectId);
        if (project) {
          projectName = project.name;
        }
      }
    }
    
    // Show notification for this specific project
    chrome.notifications.create(`sync-project-${projectId}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '🔄 ContextBridge: Time to Sync',
      message: `You've been working on "${projectName}". Would you like to capture your changes?`,
      buttons: [
        { title: '✅ Sync Now' },
        { title: '⏰ Later' }
      ],
      requireInteraction: true,
      priority: 2
    });
    
    // Store for button handler
    await chrome.storage.local.set({
      [`pendingSync-${projectId}`]: {
        ...projectInfo,
        projectName
      }
    });
    
  } catch (error) {
    console.error(`[Auto-Sync] Error handling project sync alarm:`, error);
  }
}

// Main function: Check all watched projects for updates
async function checkForUpdates() {
  try {
    console.log('[Auto-Sync] Starting update check...');
    
    // 1. Get watched projects from backend
    const response = await authFetch(`${BACKEND_URL}/api/sync/watched-projects`);
    if (!response.ok) {
      console.error('[Auto-Sync] Failed to fetch watched projects:', response.status);
      return;
    }
    
    const { projects } = await response.json();
    console.log(`[Auto-Sync] Found ${projects.length} watched projects`);
    
    if (projects.length === 0) {
      console.log('[Auto-Sync] No watched projects, skipping');
      return;
    }
    
    // For now, just log - actual sync will be activity-based
    console.log('[Auto-Sync] Activity-based sync enabled - waiting for user interaction');
    
  } catch (error) {
    console.error('[Auto-Sync] Error checking for updates:', error);
  }
}

// Show notification that sync check is available
function showSyncAvailableNotification(projects) {
  const projectNames = projects
    .map(p => p.name)
    .slice(0, 3)
    .join(', ');
  
  const moreProjects = projects.length > 3 
    ? ` +${projects.length - 3} more` 
    : '';
  
  // Store projects for when user clicks
  chrome.storage.local.set({ 
    pendingSyncProjects: projects,
    pendingSyncTimestamp: Date.now()
  });
  
  chrome.notifications.create('sync-check-available', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: '🔄 ContextBridge: Sync Check',
    message: `Ready to check for updates in: ${projectNames}${moreProjects}`,
    buttons: [
      { title: '✅ Check Now' },
      { title: '⏰ Later' }
    ],
    requireInteraction: true,
    priority: 2
  });
}

// Handle notification button clicks
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  chrome.notifications.clear(notificationId);
  
  if (buttonIndex === 0) {
    // "Sync Now" clicked
    console.log(`[Auto-Sync] User clicked Sync Now on ${notificationId}`);
    
    if (notificationId.startsWith('sync-project-')) {
      const projectId = notificationId.replace('sync-project-', '');
      await openSpecificProjectForSync(projectId);
    } else {
      await openProjectForSync();
    }
  } else {
    // "Later" clicked
    console.log('[Auto-Sync] User clicked Later');
  }
});

// Handle notification click (not just buttons)
chrome.notifications.onClicked.addListener(async (notificationId) => {
  chrome.notifications.clear(notificationId);
  console.log(`[Auto-Sync] User clicked notification: ${notificationId}`);
  
  if (notificationId.startsWith('sync-project-')) {
    const projectId = notificationId.replace('sync-project-', '');
    await openSpecificProjectForSync(projectId);
  } else {
    await openProjectForSync();
  }
});

// Open a specific project for sync and auto-trigger capture
async function openSpecificProjectForSync(projectId) {
  try {
    const storageKey = `pendingSync-${projectId}`;
    const result = await chrome.storage.local.get(storageKey);
    const projectInfo = result[storageKey];
    
    if (!projectInfo) {
      console.log(`[Auto-Sync] No pending sync info for ${projectId}`);
      return;
    }
    
    const { provider, projectName } = projectInfo;
    
    const projectUrl = provider === 'claude'
      ? `https://claude.ai/project/${projectId}`
      : `https://chatgpt.com/g/${projectId}`;
    
    console.log(`[Auto-Sync] Opening project for auto-capture: ${projectName} at ${projectUrl}`);
    
    // Show notification that sync is starting
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'ContextBridge',
      message: `Starting sync for "${projectName}"...`
    });
    
    // Open the project page
    const tab = await chrome.tabs.create({ url: projectUrl, active: true });
    
    // Wait for page to fully load
    await new Promise((resolve) => {
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 15000);
    });
    
    // Extra wait for SPA content
    await new Promise(r => setTimeout(r, 3000));
    
    console.log(`[Auto-Sync] Page loaded, starting capture for ${projectName}`);
    
    // Trigger capture using the refactored function
    await startProjectCapture(tab, projectId, provider);
    
    // Clean up
    await chrome.storage.local.remove(storageKey);
    
  } catch (error) {
    console.error(`[Auto-Sync] Error in auto-sync:`, error);
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'ContextBridge Error',
      message: `Sync failed: ${error.message}`
    });
  }
}

// Open first pending project for user to sync
async function openProjectForSync() {
  try {
    const { pendingSyncProjects } = await chrome.storage.local.get('pendingSyncProjects');
    
    if (!pendingSyncProjects || pendingSyncProjects.length === 0) {
      console.log('[Auto-Sync] No pending projects');
      return;
    }
    
    // Open first project
    const project = pendingSyncProjects[0];
    const projectUrl = project.provider === 'claude'
      ? `https://claude.ai/project/${project.id}`
      : `https://chatgpt.com/g/${project.provider_project_id || project.id}`;
    
    console.log(`[Auto-Sync] Opening project: ${project.name} at ${projectUrl}`);
    
    chrome.tabs.create({ url: projectUrl, active: true });
    
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'ContextBridge',
      message: `Opened "${project.name}". Click the extension icon to capture any updates.`
    });
    
    // Remove this project from pending list
    const remaining = pendingSyncProjects.slice(1);
    if (remaining.length > 0) {
      await chrome.storage.local.set({ pendingSyncProjects: remaining });
    } else {
      await chrome.storage.local.remove('pendingSyncProjects');
    }
    
  } catch (error) {
    console.error('[Auto-Sync] Error opening project:', error);
  }
}

// ============================================================
// CHANGE DETECTION - Scan project pages for new conversations
// ============================================================

// Manual trigger for testing (call from service worker console)
async function triggerSyncCheck() {
  console.log('[Auto-Sync] Manual trigger');
  await checkForUpdates();
}

// Expose for debugging
globalThis.triggerSyncCheck = triggerSyncCheck;

// CLAUDE conversation loader
async function loadAllClaudeConversations(tab) {
  console.log('Loading Claude project conversations...');
  
  return await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      const waitFor = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      
      let loadMoreClicked = false;
      let attempts = 0;
      const maxAttempts = 30;
      let totalConversationsFound = 0;
      
      do {
        const currentCount = document.querySelectorAll('a[href*="/chat/"]').length;
        console.log(`Currently showing ${currentCount} conversations`);
        
        const loadMoreBtn = 
          document.querySelector('button[aria-label*="Load more"]') ||
          document.querySelector('button[aria-label*="Load More"]') ||
          Array.from(document.querySelectorAll('button')).find(btn => 
            btn.textContent?.toLowerCase().includes('load more') ||
            btn.textContent?.toLowerCase().includes('show more')  // ✅ Add 'show more' back
          );
        
        if (loadMoreBtn && !loadMoreBtn.disabled) {
          loadMoreBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await waitFor(500);
          loadMoreBtn.click();
          console.log(`Attempt ${attempts + 1}: Clicked Load More button`);
          loadMoreClicked = true;
          attempts++;
          await waitFor(3000);
          
          const newCount = document.querySelectorAll('a[href*="/chat/"]').length;
          if (newCount === currentCount) {
            loadMoreClicked = false;
          } else {
            totalConversationsFound = newCount;  // ✅ Track total found
          }
        } else {
          loadMoreClicked = false;
        }
      } while (loadMoreClicked && attempts < maxAttempts);

      console.log(`Load More clicking complete. Total attempts: ${attempts}`);
      console.log(`Total conversations found after loading: ${totalConversationsFound}`);

      // Get from main content area only
      const mainContent = document.querySelector('main') || document.querySelector('[role="main"]');
      if (!mainContent) return [];

      // Get links from mainContent only
      const links = Array.from(mainContent.querySelectorAll('a[href*="/chat/"]'));
      console.log(`Total links found in main content: ${links.length}`);
      console.log(`Sample link hrefs:`, links.slice(0, 5).map(l => l.href));

      const conversations = links
        // Add parent element filtering
        .filter(link => {
          const parent = link.closest('[class*="conversation"]') || 
                        link.closest('[class*="chat-list"]') ||
                        link.closest('li');
          return parent !== null;
        })
        .map(link => {
          const href = link.getAttribute('href') || '';
          const id = href.split('/chat/')[1]?.split('?')[0] || '';
          
          // Try multiple methods for title extraction
          const titleDiv = link.querySelector('div[title]');
          let title = titleDiv?.getAttribute('title');
          
          if (!title) {
            // innerText separates block elements (like the new timestamp div) with newlines
            // textContent squashes them together. We split by newline to grab just the actual title.
            const rawText = link.innerText || link.textContent || '';
            title = rawText.split('\n')[0].trim();
          }
          
          // Fallback regex to strip the specific timestamp string if it still snuck through
          if (title) {
            title = title.replace(/Last message.*$/i, '').trim();
          } else {
            title = 'Untitled';
          }

          console.log(`Mapped conversation: ${id} - ${title}`);
          
          return {
            id,
            url: link.href,
            title,
          };
        })
        .filter(c => c.id);

      console.log(`After filtering: ${conversations.length} conversations`);
      console.log(`Sample conversations:`, conversations.slice(0, 3));
      
      const unique = Array.from(new Map(conversations.map(c => [c.id, c])).values());
      console.log(`After deduplication: ${unique.length} Claude project conversations`);

      return unique;
    }
  });
}

// Load Grok conversations from intercepted API data
async function loadAllGrokConversations(tab, projectId) {
  // Since we intercept the workspace-specific endpoint,
  // all conversations in grokConversationsList already belong to this project
  const conversations = grokConversationsList.map(conv => ({
    id: conv.id,
    title: conv.title || 'Untitled',
    url: `https://grok.com/project/${projectId}?chat=${conv.id}`
  }));
  
  console.log(`[Grok] Found ${conversations.length} conversations in project ${projectId}`);
  
  // Return in the same format as executeScript would
  return [{ result: conversations }];
}

// OPENAI conversation loader
async function loadAllOpenAIConversations(tab, gizmoId) {
  console.log('Loading OpenAI conversations for project:', gizmoId);
  
  return await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [gizmoId],

    func: async (gizmoId) => {
      const waitFor = (ms) => new Promise(resolve => setTimeout(resolve, ms));

      console.log('Starting to load OpenAI conversations for:', gizmoId);

      const maxScrollAttempts = 30;
      let lastCount = 0;
      let stableAttempts = 0;

      for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
        // Current set of conversation links for this gizmo
        const links = Array.from(
          document.querySelectorAll(`a[href*="/c/"][href*="${gizmoId}"]`)
        );
        const currentCount = links.length;

        console.log(
          `Scroll attempt ${attempt + 1}: found ${currentCount} conversations (last: ${lastCount})`
        );

        if (currentCount === lastCount) {
          stableAttempts++;
        } else {
          stableAttempts = 0;
          lastCount = currentCount;
        }

        // After a few iterations with no growth, assume we've loaded everything
        if (currentCount > 0 && stableAttempts >= 3) {
          console.log('No more new conversations loaded; stopping scroll');
          break;
        }

        // Try to scroll all containers that appear to hold these links
        const scrollContainers = new Set();

        for (const link of links) {
          let el = link.parentElement;
          while (el && el !== document.body) {
            const style = window.getComputedStyle(el);
            const hasScrollableContent = el.scrollHeight > el.clientHeight + 10;
            const canScroll = /(auto|scroll|overlay)/.test(
              style.overflowY || style.overflow || ''
            );
            if (hasScrollableContent && canScroll) {
              scrollContainers.add(el);
            }
            el = el.parentElement;
          }
        }

        if (scrollContainers.size === 0) {
          // Fallback: try window scroll
          window.scrollTo(0, document.body.scrollHeight);
        } else {
          scrollContainers.forEach(container => {
            container.scrollTop = container.scrollHeight;
          });
        }

        await waitFor(1500);
      }

      // Final pass: gather all links for this gizmo
      const conversationLinks = Array.from(
        document.querySelectorAll(`a[href*="/c/"][href*="${gizmoId}"]`)
      );

      console.log(`Conversation links matching gizmo: ${conversationLinks.length}`);

      const conversations = conversationLinks
        .map(link => {
          const href = link.getAttribute('href') || '';
          const urlMatch = href.match(/\/c\/([^/?]+)/);
          if (!urlMatch) return null;

          const titleSpan =
            link.querySelector('span[dir="auto"]') ||
            link.querySelector('span') ||
            link.querySelector('div');

          let title =
            titleSpan?.textContent?.trim() ||
            link.textContent?.trim() ||
            'Untitled';

          return {
            id: urlMatch[1],
            gizmo_id: gizmoId,
            url: `https://chatgpt.com${href}`,
            title: title.replace(/\s+/g, ' ').trim()
          };
        })
        .filter(Boolean);

      const unique = Array.from(new Map(conversations.map(c => [c.id, c])).values());
      console.log(`Found ${unique.length} openai project conversations`);
      return unique;
    }
  });
}

async function loadAllGeminiConversations(tab) {
  console.log('Loading Gemini project conversations...');
  
  return await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      const waitFor = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      
      // 1. Ensure the sidebar is open
      const menuBtn = document.querySelector('button[aria-label*="menu" i]');
      if (menuBtn && document.querySelectorAll('a[href*="/app/"]').length < 5) {
        menuBtn.click();
        await waitFor(1000);
      }

      // 2. Scroll to load all history dynamically
      let lastCount = 0;
      let stableAttempts = 0;
      const maxAttempts = 30;

      for (let i = 0; i < maxAttempts; i++) {
        const links = document.querySelectorAll('a[href*="/app/"]');
        if (links.length > 0) {
          // Scroll the very last link into view to trigger pagination
          links[links.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
        await waitFor(1000);

        const currentCount = document.querySelectorAll('a[href*="/app/"]').length;
        if (currentCount === lastCount) {
          stableAttempts++;
          if (stableAttempts > 3) break;
        } else {
          stableAttempts = 0;
          lastCount = currentCount;
        }
      }

      // 3. Extract all conversation links
      const allLinks = Array.from(document.querySelectorAll('a[href*="/app/"]'));

      const conversations = allLinks.map(link => {
        const href = link.getAttribute('href') || '';
        const idMatch = href.match(/\/app\/([a-f0-9]+)/i);
        const id = idMatch ? idMatch[1] : null;

        if (!id) return null;

        let title = link.getAttribute('data-tooltip') || 
                    link.getAttribute('aria-label') || 
                    link.textContent || 
                    'Untitled';
        
        title = title.replace(/^Chat history\s*/i, '').replace(/Options\s*$/i, '').trim();

        return {
          id,
          url: `https://gemini.google.com/app/${id}`,
          title
        };
      }).filter(c => c !== null);

      // 4. Deduplicate
      const unique = Array.from(new Map(conversations.map(c => [c.id, c])).values());
      console.log(`Found ${unique.length} Gemini conversations`);
      return unique;
    }
  });
}

async function loadAllGeminiNotebooks(tab) {
  console.log('Loading Gemini notebook list...');
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const notebooks = [];
      const cards = document.querySelectorAll('a.project-card');
      cards.forEach(card => {
        const hrefMatch = card.href?.match(/notebooks\/([a-f0-9-]{36})/);
        const titleEl = card.querySelector('span.title.gds-title-l');
        if (hrefMatch && titleEl) {
          notebooks.push({
            id: hrefMatch[1],
            title: titleEl.textContent.trim()
          });
        }
      });
      // Fallback: if no cards found, extract IDs from HTML only
      if (notebooks.length === 0) {
        const html = document.documentElement.innerHTML;
        const matches = html.match(/notebooks\/[a-f0-9-]{36}/g) || [];
        [...new Set(matches)].forEach(m => {
          notebooks.push({ id: m.replace('notebooks/', ''), title: null });
        });
      }
      return notebooks;
    }
  });
  return result.result || [];
}

async function loadAllGeminiNotebookConversations(tab, notebookId) {
  console.log(`Loading conversations for notebook: ${notebookId}`);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (nbId) => {
      // Extract XSRF token
      const html = document.documentElement.innerHTML;
      const snlmMatch = html.match(/"SNlM0e":"([^"]+)"/);
      const atToken = snlmMatch ? snlmMatch[1] : '';

      const conversations = [];
      let pageToken = null;
      let isFirst = true;

      try {
        while (true) {
          const payload = isFirst
            ? `[10,null,[null,null,1,"notebooks/${nbId}",1]]`
            : `[100,"${pageToken}",[null,null,1,"notebooks/${nbId}",1]]`;

          const body = new URLSearchParams();
          body.append('f.req', JSON.stringify([[['MaZiqc', payload, null, 'generic']]]));
          if (atToken) body.append('at', atToken);

          const url = `/_/BardChatUi/data/batchexecute?rpcids=MaZiqc&source-path=%2Fnotebook%2Fnotebooks%252F${nbId}&rt=c`;

          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
            credentials: 'include'
          });

          const text = await resp.text();

          // Parse batchexecute response: format is )]}'\n{size}\n{json}\n...
          let parsed = null;
          for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('[')) continue;
            try {
              const outer = JSON.parse(trimmed);
              for (const entry of outer) {
                if (Array.isArray(entry) && entry[1] === 'MaZiqc' && typeof entry[2] === 'string') {
                  parsed = JSON.parse(entry[2]);
                  break;
                }
              }
              if (parsed) break;
            } catch(e) { continue; }
          }
          if (!parsed) break;

          const nextToken = parsed[1] || null;
          const convList = parsed[2] || [];

          for (const c of convList) {
            const rawId = (c[0] || '').replace(/^c_/, '');
            const title = c[1] || 'Untitled';
            if (rawId) {
              conversations.push({ id: rawId, url: `https://gemini.google.com/app/${rawId}`, title });
            }
          }

          await new Promise(r => setTimeout(r, 500));
          if (!nextToken || convList.length === 0) break;
          pageToken = nextToken;
          isFirst = false;
        }
      } catch(loopErr) {
          console.log('[CB Notebook] Loop error for ' + nbId + ':', loopErr.message);
      }
      return conversations;
    },
    args: [notebookId]
  });
  return result.result || [];
}

// ============================================================
// CAPTURE LOGIC - Extracted for reuse by auto-sync
// ============================================================

// Main capture function - can be called from icon click OR auto-sync
async function startProjectCapture(tab, overrideProjectId = null, overrideProvider = null) {
  console.log('Starting capture for tab:', tab.url);

  // ── Auth Guard: block capture if not signed in ──
  if (!authTokens.accessToken) {
    console.log('🚫 Capture blocked: user not signed in');
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // Remove any existing toast
          const existing = document.getElementById('ctxbridge-auth-toast');
          if (existing) existing.remove();

          // Create overlay
          const overlay = document.createElement('div');
          overlay.id = 'ctxbridge-auth-toast';
          overlay.style.cssText = `
            position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
            max-width: 400px; padding: 20px 24px; border-radius: 12px;
            background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4); border: 1px solid rgba(99,102,241,0.3);
            animation: ctxSlideIn 0.3s ease-out;
          `;
          overlay.innerHTML = `
            <style>
              @keyframes ctxSlideIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
              @keyframes ctxFadeOut { from { opacity: 1; } to { opacity: 0; transform: translateY(10px); } }
            </style>
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
              <div style="width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:16px;color:white;">C</div>
              <span style="font-weight:600;font-size:15px;color:#fff;">ContextBridge: Sign In Required</span>
            </div>
            <p style="margin:0 0 14px 0;font-size:13.5px;line-height:1.5;color:#c0c0c0;">
              Please sign in or register to start capturing.
            </p>
            <div style="display:flex; gap:10px;">
              <button id="ctxbridge-signin-btn" style="
                background: linear-gradient(135deg,#6366f1,#8b5cf6); color: #fff; border: none;
                padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600;
              ">🔑 Sign In / Register</button>
              <button id="ctxbridge-dismiss-btn" style="
                background: rgba(99,102,241,0.2); color: #a5b4fc; border: 1px solid rgba(99,102,241,0.3);
                padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px;
              ">Dismiss</button>
            </div>
          `;
          document.body.appendChild(overlay);

          // Button handlers
          const dismiss = () => {
            overlay.style.animation = 'ctxFadeOut 0.2s ease-in forwards';
            setTimeout(() => overlay.remove(), 200);
          };
          document.getElementById('ctxbridge-dismiss-btn').addEventListener('click', dismiss);
          document.getElementById('ctxbridge-signin-btn').addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'openOptionsPage' });
            dismiss();
          });
          setTimeout(dismiss, 20000);
        }
      });
    } catch (e) {
      console.error('Failed to show auth toast:', e);
    }
    return; // ← Block capture entirely
  }
  
  // Detect platform and extract project info
  let provider = overrideProvider;
  let projectId = overrideProjectId;
  let projectName = null;
  let gizmoId = null; // For OpenAI only

  // Get user ID from storage
  const storageResult = await chrome.storage.sync.get(['userId']);
  const userId = storageResult.userId || 'default';
  
  if (!provider || !projectId) {
    // Auto-detect from URL
    if (tab.url?.includes('claude.ai/project/')) {
      // CLAUDE
      provider = 'claude';
      projectId = tab.url.match(/\/project\/([a-f0-9-]+)/)?.[1];
      projectName = await extractProjectName(tab) || `Claude Project ${new Date().toLocaleDateString()}`;
      
      console.log('Claude Project ID:', projectId);
      console.log('Project Name:', projectName);
      
    } else if (tab.url?.includes('chatgpt.com/g/g-p-')) {
      // OPENAI
      provider = 'openai';
      
      // Extract gizmo_id from URL
      gizmoId = tab.url.match(/\/g\/(g-p-[a-z0-9]+)/)?.[1];
      
      // Generate UUID from gizmo_id for database compatibility
      projectId = await gizmoIdToUUID(gizmoId);
      
      // Extract project name from URL
      const nameMatch = tab.url.match(/\/g\/g-p-[a-z0-9]+-([^/]+)/);
      projectName = nameMatch ? nameMatch[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'OpenAI Project';
      
      console.log('OpenAI Gizmo ID:', gizmoId);
      console.log('OpenAI Project ID (UUID):', projectId);
      console.log('Project Name:', projectName);
      
    } else if (tab.url?.includes('grok.com/project/')) {
      // GROK
      provider = 'grok';
      projectId = tab.url.match(/\/project\/([a-f0-9-]+)/)?.[1];
      projectName = await extractProjectName(tab) || `Grok Project ${new Date().toLocaleDateString()}`;
      
      console.log('Grok Project ID:', projectId);
      console.log('Project Name:', projectName);
      
    } else if (tab.url?.includes('gemini.google.com')) {
      // GEMINI
      provider = 'gemini';
      // Gemini has no projects — derive a deterministic UUID from the user ID
      projectId = await gizmoIdToUUID(`gemini-global-${userId}`);
      projectName = 'Gemini Conversations';
      geminiDefaultProjectId = projectId;
      
      console.log('Gemini Platform ID:', projectId);
      console.log('Project Name:', projectName);
      
    } else {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'ContextBridge',
        message: 'Please navigate to a Claude, OpenAI, Grok, or Gemini page first'
      });
      return;
    }

  } else {
    // Using override values - still need project name
    projectName = await extractProjectName(tab) || `Project ${new Date().toLocaleDateString()}`;
    console.log(`Using override - Provider: ${provider}, Project ID: ${projectId}`);
  }

  // Store last captured project for dashboard access
  chrome.storage.sync.set({ lastProjectId: projectId });

  // Check if capture is already running
  if (captureActive) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'ContextBridge',
      message: 'Capture already in progress...'
    });
    return;
  }
  
  // Save original URL to return to
  originalProjectUrl = tab.url;
  
  // Start capture
  captureActive = true;
  // Update widget to syncing state
  await updateWidgetState('syncing');
  capturedData = {};
  const failedConversations = [];

  // Shared list of conversations for both providers
  let conversationsToCapture = [];

  // Simple Reload Strategy (No Permissions Needed)
  try {
    if (provider === 'claude') {
      console.log('🔄 Reloading page to trigger API interceptor...');
      
      // 1. Clear old timestamps so we know we are getting fresh data
      for (const key in claudeConversationTimestamps) delete claudeConversationTimestamps[key];
      
      // 2. Reload the page (Interceptor injects on load)
      await chrome.tabs.reload(tab.id);
      
      // 3. Wait for page load + API calls (Interceptor will catch them)
      console.log('⏳ Waiting for page load and API traffic...');
      await new Promise(resolve => setTimeout(resolve, 6000)); // 6s is usually safe for Claude
      
      // 4. Check if we got data
      const capturedCount = Object.keys(claudeConversationTimestamps).length;
      console.log(`✅ Interceptor report: Captured ${capturedCount} timestamps`);
      
      // 5. Proceed with DOM scraping (Existing logic continues below...)
      const [result] = await loadAllClaudeConversations(tab);
      // ... (Keep the rest of your existing filtering logic)
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for page + API to fully load
      
      const conversations = result.result;

    console.log(`Found ${conversations.length} Claude project conversations`);

    // 4. Wait for all timestamp API responses to be captured
    const targetCount = conversations.length;
    const startTime = Date.now();
    while (Object.keys(claudeConversationTimestamps).length < targetCount && Date.now() - startTime < 10000) {
      console.log(`⏳ Waiting for timestamps: ${Object.keys(claudeConversationTimestamps).length}/${targetCount}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    console.log(`📋 Captured timestamps for ${Object.keys(claudeConversationTimestamps).length}/${conversations.length} conversations`);

    // Check existing conversations
    const needsCaptureResponse = await authFetch(`${BACKEND_URL}/api/projects/${projectId}/conversations/status`);
    const projectData = await needsCaptureResponse.json();
    const existingConvs = projectData.conversations || [];
    const existingConvMap = new Map(
      existingConvs.map(c => [c.id, { 
        message_count: c.message_count,
        captured_at: c.captured_at ? new Date(c.captured_at).getTime() : 0
      }])
    );

    // Filter conversations: brand new OR stale (updated since last capture)
    const brandNewConversations = conversations.filter(c => !existingConvMap.has(c.id));
    const staleConversations = conversations.filter(c => {
      if (!existingConvMap.has(c.id)) return false; // Not stale if brand new
      const existing = existingConvMap.get(c.id);
      const claudeUpdatedAt = claudeConversationTimestamps[c.id];
      if (!claudeUpdatedAt) return false; // No timestamp from Claude, skip (Claude API is reliable)
      const claudeTime = new Date(claudeUpdatedAt).getTime();
      return claudeTime > existing.captured_at;
    });
    const upToDateConversations = conversations.filter(c => {
      if (!existingConvMap.has(c.id)) return false;
      const existing = existingConvMap.get(c.id);
      const claudeUpdatedAt = claudeConversationTimestamps[c.id];
      if (!claudeUpdatedAt) return true; // No timestamp, assume up to date
      const claudeTime = new Date(claudeUpdatedAt).getTime();
      return claudeTime <= existing.captured_at;
    });

    console.log(`📊 Conversation breakdown for claude:`);
    console.log(`  - Brand new: ${brandNewConversations.length}`);
    console.log(`  - Stale (need update): ${staleConversations.length}`);
    console.log(`  - Up to date (skip): ${upToDateConversations.length}`);

    // Only capture new + stale conversations
    conversationsToCapture = [...brandNewConversations, ...staleConversations];
    console.log(`\n🎯 Strategy: Smart incremental capture`);
    console.log(`  - Will navigate to ${conversationsToCapture.length} conversations (skipping ${upToDateConversations.length} unchanged)`);

    console.log(`\n🎯 Strategy: Full incremental capture`);
    console.log(`  - Will navigate to all ${conversationsToCapture.length} conversations`);

    if (conversationsToCapture.length === 0) {
  
      // Distinguish between "no conversations at all" vs "all up to date"
      const totalConversations = conversations?.length || 0;
      const message = totalConversations === 0 
        ? 'No conversations found in project!'
        : `All ${totalConversations} conversations are up to date!`;
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'ContextBridge',
        message: message
      });
      console.log(message);
      captureActive = false;
      await updateWidgetState('active');
      return;
    }

    // ✅ This code only runs if there ARE conversations
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'ContextBridge',
      message: `Checking ${conversationsToCapture.length} conversations for updates...`
    });
    
    await openProgressPopup();
    await sendProgressUpdate({
      message: `📋 Found ${conversationsToCapture.length} conversations to capture`,
      total: conversationsToCapture.length,
      current: 0
    });

    // ✅ Adaptive delay to avoid Claude.ai 429 rate limits
    // Each page navigation triggers ~15-20 ancillary API calls from Claude.ai itself
    const delayBetweenCaptures = conversationsToCapture.length > 20 ? 12000 :
                                  conversationsToCapture.length > 5  ? 10000 : 8000;


    // Force-inject interceptor before loop starts to avoid cold-start miss on first conversation
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['injected_interceptor.js'],
        world: 'MAIN'
      });
      console.log('✅ Claude interceptor force-injected before capture loop');
    } catch (e) {
      console.warn('⚠️ Could not force-inject interceptor:', e.message);
    }
    const captureLoopStartTime = Date.now();

    // CLAUDE: Navigate, confirm via interceptor, reload only as fallback
    for (let i = 0; i < conversationsToCapture.length; i++) {
      const conv = conversationsToCapture[i];
        console.log(`[${i + 1}/${conversationsToCapture.length}] Navigating to conversation: ${conv.title}`);

        // Calculate moving average ETA
        const elapsedMs = Date.now() - captureLoopStartTime;
        const avgTimeMs = i > 0 ? elapsedMs / i : delayBetweenCaptures;
        const remainingMs = avgTimeMs * (conversationsToCapture.length - i);
        const remainingMins = Math.max(1, Math.ceil(remainingMs / 60000));

        await sendProgressUpdate({
          message: `📖 Capturing conversation ${i + 1}/${conversationsToCapture.length}: ${conv.title.substring(0, 40)}...`,
          current: i,
          total: conversationsToCapture.length,
          captureEtaMins: remainingMins
      });

      // 1. Navigate to conversation
      await chrome.tabs.update(tab.id, { url: conv.url });
      
      // 2. Wait for page load
      await new Promise(resolve => {
        const listener = (tabId, info) => {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 15000);
      });
      
      // 3. Poll for interceptor confirmation (data arrives via PROCESS_INTERCEPTED_DETAIL)
      let captured = false;
      // If enrichment promise exists, await it directly (handles large conversations with PDFs/artifacts)
      if (pendingEnrichment.has(conv.id)) {
        console.log(`   ⏳ Awaiting enrichment for: ${conv.id}`);
        await Promise.race([
          pendingEnrichment.get(conv.id),
          new Promise(r => setTimeout(r, 120000)) // 120s max
        ]);
        pendingEnrichment.delete(conv.id);
      } else {
        // Fallback poll for cases where interceptor fires after page load
        const pollStart = Date.now();
        const pollTimeout = 30000; // 30s max wait
        while (!captured && (Date.now() - pollStart) < pollTimeout) {
          if (capturedData[conv.id]) {
            console.log(`   ✅ Interceptor confirmed capture for: ${conv.id}`);
            break;
          }
          // If enrichment registered mid-poll, await it
          if (pendingEnrichment.has(conv.id)) {
            await Promise.race([
              pendingEnrichment.get(conv.id),
              new Promise(r => setTimeout(r, 120000))
            ]);
            pendingEnrichment.delete(conv.id);
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      captured = !!capturedData[conv.id];
      
      // 4. Fallback: reload ONCE if interceptor didn't capture on first load
      if (!captured) {
        console.log(`   ⚠️ Data not captured on first load, reloading as fallback...`);
        await chrome.tabs.reload(tab.id);
        await new Promise(resolve => {
          const listener = (tabId, info) => {
            if (tabId === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 15000);
        });
        // Wait for interceptor after reload
        const reloadPollStart = Date.now();
        while (!capturedData[conv.id] && (Date.now() - reloadPollStart) < 15000) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (capturedData[conv.id]) {
          console.log(`   ✅ Captured after fallback reload: ${conv.id}`);
        } else {
          console.warn(`   ❌ Failed to capture even after reload: ${conv.id}`);
        }
      }
      
      // 5. Delay before next navigation to avoid 429 rate limits
      if (i < conversationsToCapture.length - 1) {
        console.log(`   ⏳ Waiting ${delayBetweenCaptures / 1000}s before next conversation...`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenCaptures));
      }
    }

    } else if (provider === 'gemini') {
      try {
        console.log('🔄 Reloading page to trigger Gemini API interceptor...');

        // Clear previous timestamps
        for (const key in geminiConversationTimestamps) {
          delete geminiConversationTimestamps[key];
        }

        // Reload page to trigger interceptor
        await new Promise(resolve => {
          chrome.tabs.onUpdated.addListener(function listener(updatedTabId, info) {
            if (updatedTabId === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          });
          chrome.tabs.reload(tab.id);
        });

        console.log('⏳ Waiting for Gemini API traffic...');
        await new Promise(resolve => setTimeout(resolve, 6000));

        // Load conversations from the DOM
        const [result] = await loadAllGeminiConversations(tab);
        const rawConversations = result.result || [];
        const conversations = rawConversations.map(c => ({
          ...c,
          originalId: c.id, // Keep the short 16-char ID for URLs
          id: formatGeminiIdToUUID(c.id) // Use UUID format for the database
        }));
        console.log(`Found ${conversations.length} Gemini conversations`);

        // Save the scraped DOM titles to memory so the JSON interceptor can use them
        conversations.forEach(conv => {
          if (conv.id && conv.title) {
            scrapedConversationTitles[conv.id] = conv.title;
          }
        });

        // Load notebook conversations and merge them in
        try {
          console.log('🗒️ Loading Gemini notebook conversations...');
          await chrome.tabs.update(tab.id, { url: 'https://gemini.google.com/notebooks/view' });
          await new Promise((resolve) => {
            const listener = (tabId, info) => {
              if (tabId === tab.id && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
            setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 10000);
          });
          await new Promise(resolve => setTimeout(resolve, 2000));

          const notebookIds = await loadAllGeminiNotebooks(tab);
          console.log(`Found ${notebookIds.length} notebooks: ${notebookIds.join(', ')}`);

          for (const nb of notebookIds) {
            // Get or create a CB project for this notebook
            let nbProjectId = projectId; // fallback to global
            let nbProjectName = 'Gemini Conversations';
            try {
              const nbProjectResp = await authFetch(`${BACKEND_URL}/api/utils/ensure-notebook-project`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  notebookId: nb.id,
                  notebookTitle: nb.title ? `Gemini: ${nb.title}` : `Gemini: ${nb.id.slice(0, 8)}`,
                  userId: userId
                })
              });
              if (nbProjectResp.ok) {
                const nbProjectData = await nbProjectResp.json();
                nbProjectId = nbProjectData.projectId;
                nbProjectName = nbProjectData.projectName;
              }
            } catch (e) {
              console.warn(`[Notebook] Could not ensure project for ${nb.id}:`, e.message);
            }

            const nbConversations = await loadAllGeminiNotebookConversations(tab, nb.id);
            console.log(`Notebook ${nb.id}: ${nbConversations.length} conversations → project ${nbProjectId}`);
            for (const c of nbConversations) {
              const cbId = formatGeminiIdToUUID(c.id);
              if (conversations.some(existing => existing.id === cbId)) continue;
              const enriched = { ...c, originalId: c.id, id: cbId, notebookProjectId: nbProjectId, notebookProjectName: nbProjectName };
              conversations.push(enriched);

              // Store project mapping for this conversation
              if (enriched.id && nbProjectId) {
                geminiConversationProjectMap[enriched.id] = nbProjectId;
              }

              if (enriched.id && enriched.title) {
                scrapedConversationTitles[enriched.id] = enriched.title;
              }
            }
          }
          console.log(`Total Gemini conversations after notebooks: ${conversations.length}`);
        } catch (nbErr) {
          console.warn('⚠️ Failed to load notebook conversations:', nbErr.message);
        }

        // Skip keyword prompt — capture everything automatically
        let targetConversations = conversations;

        // 3. Check backend status to find new/stale from the filtered list
        // Collect all unique project IDs (global + all notebook projects)
        const allProjectIds = [...new Set([
          projectId,
          ...conversations.map(c => c.notebookProjectId).filter(Boolean)
        ])];

        // Fetch status for all projects and merge into one map
        const existingConvMap = new Map();
        for (const pid of allProjectIds) {
          const resp = await authFetch(`${BACKEND_URL}/api/projects/${pid}/conversations/status`);
          const data = await resp.json();
          (data.conversations || []).forEach(c => {
            existingConvMap.set(c.id, {
              captured_at: c.captured_at ? new Date(c.captured_at).getTime() : 0
            });
          });
        }

        console.log(`[Status] allProjectIds: ${JSON.stringify(allProjectIds)}`);
        console.log(`[Status] existingConvMap size: ${existingConvMap.size}`);

        const currentActiveTabId = tab.url.match(/\/app\/([a-f0-9]+)/i)?.[1];

        const brandNewConversations = targetConversations.filter(c => !existingConvMap.has(c.id));
        const staleConversations = targetConversations.filter(c => {
          if (!existingConvMap.has(c.id)) return false;
          
          // Because Gemini provides no global timestamps, we assume existing conversations 
          // are up to date to prevent infinite recaptures. However, we ALWAYS force-sync 
          // the conversation the user is currently viewing, as it may have just been updated.
          if (c.originalId === currentActiveTabId) {
            return true;
          }
          
          const existing = existingConvMap.get(c.id);
          const geminiUpdatedAt = geminiConversationTimestamps[c.id];
          
          // FIX: If we have no timestamp, we MUST return false (assume up to date) 
          // otherwise it will recapture all 55 every single time.
          if (!geminiUpdatedAt) return false; 
          
          return new Date(geminiUpdatedAt).getTime() > existing.captured_at;
        });

        conversationsToCapture = [...brandNewConversations, ...staleConversations];
        console.log(`🎯 Will navigate to ${conversationsToCapture.length} Gemini conversations`);

        if (!conversationsToCapture.length) {
          const msg = 'All conversations are up to date!';
          chrome.notifications.create({
            type: 'basic', iconUrl: 'icons/icon128.png', title: 'ContextBridge', message: msg
          });
          captureActive = false;
          await updateWidgetState('active');
          return;
        }
        
        // --- BATCHING & ETA LOGIC ---
        const BATCH_SIZE = 200;
        let currentIndex = 0;
        let userCancelled = false;

        while (currentIndex < conversationsToCapture.length && !userCancelled) {
          const remainingTotal = conversationsToCapture.length - currentIndex;
          const currentBatchSize = Math.min(BATCH_SIZE, remainingTotal);
          const currentBatch = conversationsToCapture.slice(currentIndex, currentIndex + currentBatchSize);

          if (currentIndex === 0) {
            await openProgressPopup();
          }

          // 2. Process Current Batch
          let batchStartTime = Date.now();

          for (let i = 0; i < currentBatch.length; i++) {
            const conv = currentBatch[i];
            
            // Calculate Moving Average ETA
            const elapsedMs = Date.now() - batchStartTime;
            const avgTimeMs = i > 0 ? elapsedMs / i : 8000;
            const remainingMs = avgTimeMs * (currentBatch.length - i);
            const remainingMins = Math.max(1, Math.ceil(remainingMs / 60000));

            console.log(`[${currentIndex + i + 1}/${conversationsToCapture.length}] Navigating to: ${conv.title}`);

            await sendProgressUpdate({
              message: `📖 Capturing ${currentIndex + i + 1}/${conversationsToCapture.length}: ${conv.title.substring(0, 35)}...`,
              current: currentIndex + i,
              total: conversationsToCapture.length,
              captureEtaMins: remainingMins 
            });

            await chrome.tabs.update(tab.id, { url: conv.url });

            await new Promise(resolve => {
              const listener = (tabId, info) => {
                if (tabId === tab.id && info.status === 'complete') {
                  chrome.tabs.onUpdated.removeListener(listener);
                  resolve();
                }
              };
              chrome.tabs.onUpdated.addListener(listener);
              setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }, 10000);
            });

            // --- Google Bot / CAPTCHA Detection ---
            let captchaCheck;
            try {
              [captchaCheck] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => document.body.textContent.includes('unusual traffic') || !!document.querySelector('iframe[src*="recaptcha"]')
              });
            } catch (e) {
              console.warn(`[CAPTCHA Check] Skipped for ${conv.originalId}: ${e.message}`);
            }

            if (captchaCheck && captchaCheck.result) {
              console.warn(`⚠️ Google Bot Detection triggered on: ${conv.originalId}`);
              const proceed = await promptUserInTab(
                tab.id,
                "Verification Required",
                "Google has temporarily paused traffic to verify you are not a robot. Please complete the CAPTCHA on the page, then click 'Resume' below.",
                "Resume Capture",
                "Cancel",
                false
              );
              
              if (!proceed.proceed) {
                userCancelled = true;
                break;
              }
              
              // Hard reload after solving CAPTCHA to re-trigger the interceptor
              await chrome.tabs.reload(tab.id);
              await new Promise(resolve => {
                const listener = (tabId, info) => {
                  if (tabId === tab.id && info.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                  }
                };
                chrome.tabs.onUpdated.addListener(listener);
                setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 10000);
              });
            }
            // --- END CAPTCHA CHECK ---

            // 3. Poll for Interceptor payload
            let captured = false;
            const pollStart = Date.now();
            const pollTimeout = 18000; // Reduced to 18s so we can trigger the fallback faster
            
            while (!captured && (Date.now() - pollStart) < pollTimeout) {
              if (capturedData[conv.id]) {
                captured = true;
                console.log(`   ✅ Interceptor confirmed capture for: ${conv.id}`);
                break;
              }
              await new Promise(resolve => setTimeout(resolve, 1000));
            }

            // 4. FALLBACK: Force a hard reload if the SPA got stuck
            if (!captured) {
              console.warn(`   ⚠️ SPA stalled. Forcing hard reload for: ${conv.id}`);
              await chrome.tabs.reload(tab.id);
              
              await new Promise(resolve => {
                const listener = (tabId, info) => {
                  if (tabId === tab.id && info.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                  }
                };
                chrome.tabs.onUpdated.addListener(listener);
                setTimeout(() => {
                  chrome.tabs.onUpdated.removeListener(listener);
                  resolve();
                }, 15000);
              });

              // Poll again after the hard reload
              const reloadPollStart = Date.now();
              while (!capturedData[conv.id] && (Date.now() - reloadPollStart) < 20000) {
                if (capturedData[conv.id]) break;
                await new Promise(resolve => setTimeout(resolve, 1000));
              }

              if (capturedData[conv.id]) {
                console.log(`   ✅ Captured after fallback reload: ${conv.id}`);
                captured = true;
              } else {
                console.warn(`   ❌ Failed to capture even after reload: ${conv.id}`);
              }
            }
            
            // 5. Adaptive delay to avoid rate limits
            const adaptiveDelay = conversationsToCapture.length > 20 ? 8000 : 5000;
            await new Promise(resolve => setTimeout(resolve, adaptiveDelay));
          }
          
          currentIndex += currentBatchSize;
        }

        // Handle early abort
        if (userCancelled && currentIndex === 0) {
          console.log('Capture aborted by user before starting.');
          captureActive = false;
          await updateWidgetState('active');
          if (progressWindowId) chrome.windows.remove(progressWindowId).catch(() => {});
          return;
        }

        // Adjust the master list to only include what we actually navigated to before stopping
        conversationsToCapture = conversationsToCapture.slice(0, currentIndex);

      } catch (error) {
        console.error('Gemini capture error:', error);
        throw error;
      }

    } else if (provider === 'openai') {
      
      // ✅ COMPLETELY SEPARATE OpenAI block (Registered Interceptor Version)
      try {
        console.log('🔄 Reloading page to trigger OpenAI API interceptor...');

        // 1. Store gizmo ID for filtering API responses
        currentOpenAIGizmoId = gizmoId;
        
        // 2. Clear previous timestamps
        for (const key in openaiConversationTimestamps) {
          delete openaiConversationTimestamps[key];
        }

        // 3. Reload page - registered document_start interceptor runs automatically
        await new Promise(resolve => {
          chrome.tabs.onUpdated.addListener(function listener(updatedTabId, info) {
            if (updatedTabId === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          });
          chrome.tabs.reload(tab.id);
        });

        // 4. Wait for page boot and API traffic (interceptor catches calls during this time)
        console.log('⏳ Waiting for OpenAI API traffic...');
        await new Promise(resolve => setTimeout(resolve, 6000));

        // 5. Check captured timestamps
        const capturedCount = Object.keys(openaiConversationTimestamps).length;
        console.log(`✅ Interceptor report: Captured ${capturedCount} OpenAI timestamps`);

        // 6. Load conversations from DOM
        const [result] = await loadAllOpenAIConversations(tab, gizmoId);
        const conversations = result.result;
        console.log(`Found ${conversations.length} OpenAI project conversations`);

        // 7. Log ID overlap for diagnostics (optional, can remove later)
        if (conversations.length > 0) {
          const apiIds = new Set(Object.keys(openaiConversationTimestamps));
          const domIds = conversations.map(c => c.id);
          const intersection = domIds.filter(id => apiIds.has(id));
          console.log(`📋 Captured timestamps for ${intersection.length}/${conversations.length} project conversations`);
        }

        // 8. Check existing conversations from backend
        const needsCaptureResponse = await authFetch(`${BACKEND_URL}/api/projects/${projectId}/conversations/status`);
        const projectData = await needsCaptureResponse.json();
        const existingConvs = projectData.conversations || [];
        const existingConvMap = new Map(
          existingConvs.map(c => [c.id, { 
            message_count: c.message_count,
            captured_at: c.captured_at ? new Date(c.captured_at).getTime() : 0
          }])
        );
        
        // 9. Filter conversations: brand new OR stale (updated since last capture)
        const brandNewConversations = conversations.filter(c => !existingConvMap.has(c.id));
        const staleConversations = conversations.filter(c => {
          if (!existingConvMap.has(c.id)) return false;
          const existing = existingConvMap.get(c.id);
          const openaiUpdatedAt = openaiConversationTimestamps[c.id];
          if (!openaiUpdatedAt) {
            // FAIL-SAFE: No timestamp available (ID mismatch with global API)
            // Capture to ensure data integrity - backend will dedupe
            return true;
          }
          const openaiTime = new Date(openaiUpdatedAt).getTime();
          return openaiTime > existing.captured_at;
        });
        const upToDateConversations = conversations.filter(c => {
          if (!existingConvMap.has(c.id)) return false;
          const existing = existingConvMap.get(c.id);
          const openaiUpdatedAt = openaiConversationTimestamps[c.id];
          if (!openaiUpdatedAt) {
            // FAIL-SAFE: No timestamp, so not "up to date" - needs checking
            return false;
          }
          const openaiTime = new Date(openaiUpdatedAt).getTime();
          return openaiTime <= existing.captured_at;
        });
        
        console.log(`📊 Conversation breakdown for openai:`);
        console.log(`  - Brand new: ${brandNewConversations.length}`);
        console.log(`  - Stale (need update): ${staleConversations.length}`);
        console.log(`  - Up to date (skip): ${upToDateConversations.length}`);
        
        // Only capture new + stale conversations
        conversationsToCapture = [...brandNewConversations, ...staleConversations];
        console.log(`\n🎯 Strategy: Smart incremental capture`);
        console.log(`  - Will navigate to ${conversationsToCapture.length} conversations (skipping ${upToDateConversations.length} unchanged)`);

        if (!conversationsToCapture.length) {
          // Distinguish between "no conversations at all" vs "all up to date"
          const totalConversations = conversations?.length || 0;
          const message = totalConversations === 0 
            ? 'No conversations found in this OpenAI project'
            : `All ${totalConversations} conversations are up to date!`;
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'ContextBridge',
            message: message
          });
          captureActive = false;
          await updateWidgetState('active');
          return;
        }

      // 🔔 Same UX as Claude: show notification + open the progress popup
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'ContextBridge',
        message: `Checking ${conversationsToCapture.length} conversations for updates...`
      });

      await openProgressPopup();
      await sendProgressUpdate({
        message: `📋 Found ${conversationsToCapture.length} conversations to capture`,
        total: conversationsToCapture.length
      });

      // OpenAI navigation
      const openaiLoopStartTime = Date.now();
      for (let i = 0; i < conversationsToCapture.length; i++) {
        const conv = conversationsToCapture[i];
        console.log(
          `[${i + 1}/${conversationsToCapture.length}] Navigating to OpenAI conversation: ${conv.title}`
        );

        const oaiElapsed = Date.now() - openaiLoopStartTime;
        const oaiAvgMs = i > 0 ? oaiElapsed / i : 10000;
        const oaiRemainingMins = Math.max(1, Math.ceil((oaiAvgMs * (conversationsToCapture.length - i)) / 60000));

        await sendProgressUpdate({
          message: `📖 Capturing conversation ${i + 1}/${conversationsToCapture.length}: ${conv.title.substring(0, 40)}...`,
          current: i,
          total: conversationsToCapture.length,
          captureEtaMins: oaiRemainingMins
        });

        await chrome.tabs.update(tab.id, { url: conv.url });
        
        await new Promise(resolve => {
          const listener = (tabId, info) => {
            if (tabId === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 10000);
        });
        
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } catch (error) {
      console.error('OpenAI capture error:', error);
      throw error;
    }
    
    } else if (provider === 'grok') {
      // ✅ GROK capture block
      try {
        console.log('🔄 Reloading page to trigger Grok API interceptor...');

        // 1. Clear previous timestamps and response nodes
        for (const key in grokConversationTimestamps) {
          delete grokConversationTimestamps[key];
        }
        for (const key in grokResponseNodes) {
          delete grokResponseNodes[key];
        }

        // 2. Reload page - interceptor runs automatically
        await new Promise(resolve => {
          chrome.tabs.onUpdated.addListener(function listener(updatedTabId, info) {
            if (updatedTabId === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          });
          chrome.tabs.reload(tab.id);
        });

        // 3. Wait for page boot and API traffic
        console.log('⏳ Waiting for Grok API traffic...');
        await new Promise(resolve => setTimeout(resolve, 6000));

        // 4. Check captured timestamps
        const capturedCount = Object.keys(grokConversationTimestamps).length;
        console.log(`✅ Interceptor report: Captured ${capturedCount} Grok timestamps`);

        // 5. Load conversations from DOM
        const [result] = await loadAllGrokConversations(tab, projectId);
        const conversations = result.result || [];
        console.log(`Found ${conversations.length} Grok project conversations`);

        // 6. Check existing conversations from backend
        const needsCaptureResponse = await authFetch(`${BACKEND_URL}/api/projects/${projectId}/conversations/status`);
        const projectData = await needsCaptureResponse.json();
        const existingConvs = projectData.conversations || [];
        const existingConvMap = new Map(
          existingConvs.map(c => [c.id, { 
            message_count: c.message_count,
            captured_at: c.captured_at ? new Date(c.captured_at).getTime() : 0
          }])
        );

        // 7. Filter conversations: brand new OR stale
        const brandNewConversations = conversations.filter(c => !existingConvMap.has(c.id));
        const staleConversations = conversations.filter(c => {
          if (!existingConvMap.has(c.id)) return false;
          const existing = existingConvMap.get(c.id);
          const grokUpdatedAt = grokConversationTimestamps[c.id];
          if (!grokUpdatedAt) return true; // No timestamp, capture to be safe
          const grokTime = new Date(grokUpdatedAt).getTime();
          return grokTime > existing.captured_at;
        });
        const upToDateConversations = conversations.filter(c => {
          if (!existingConvMap.has(c.id)) return false;
          const existing = existingConvMap.get(c.id);
          const grokUpdatedAt = grokConversationTimestamps[c.id];
          if (!grokUpdatedAt) return false;
          const grokTime = new Date(grokUpdatedAt).getTime();
          return grokTime <= existing.captured_at;
        });

        console.log(`📊 Conversation breakdown for grok:`);
        console.log(`  - Brand new: ${brandNewConversations.length}`);
        console.log(`  - Stale (need update): ${staleConversations.length}`);
        console.log(`  - Up to date (skip): ${upToDateConversations.length}`);

        // Only capture new + stale conversations
        conversationsToCapture = [...brandNewConversations, ...staleConversations];
        console.log(`\n🎯 Strategy: Smart incremental capture`);
        console.log(`  - Will navigate to ${conversationsToCapture.length} conversations (skipping ${upToDateConversations.length} unchanged)`);

        if (!conversationsToCapture.length) {
          const totalConversations = conversations?.length || 0;
          const message = totalConversations === 0 
            ? 'No conversations found in this Grok project'
            : `All ${totalConversations} conversations are up to date!`;
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'ContextBridge',
            message: message
          });
          captureActive = false;
          await updateWidgetState('active');
          return;
        }

        // Show notification + open progress popup
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'ContextBridge',
          message: `Checking ${conversationsToCapture.length} conversations for updates...`
        });

        await openProgressPopup();
        await sendProgressUpdate({
          message: `📋 Found ${conversationsToCapture.length} conversations to capture`,
          total: conversationsToCapture.length
        });

        // Navigate to each Grok conversation
        const grokLoopStartTime = Date.now();
        for (let i = 0; i < conversationsToCapture.length; i++) {
          const conv = conversationsToCapture[i];
          console.log(`[${i + 1}/${conversationsToCapture.length}] Navigating to Grok conversation: ${conv.title}`);

          const grokElapsed = Date.now() - grokLoopStartTime;
          const grokAvgMs = i > 0 ? grokElapsed / i : 10000;
          const grokRemainingMins = Math.max(1, Math.ceil((grokAvgMs * (conversationsToCapture.length - i)) / 60000));

          await sendProgressUpdate({
            message: `📖 Capturing conversation ${i + 1}/${conversationsToCapture.length}: ${conv.title.substring(0, 40)}...`,
            current: i,
            total: conversationsToCapture.length,
            captureEtaMins: grokRemainingMins
          });

          await chrome.tabs.update(tab.id, { url: conv.url });

          await new Promise(resolve => {
            const listener = (tabId, info) => {
              if (tabId === tab.id && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
            setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }, 10000);
          });

          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      } catch (error) {
        console.error('Grok capture error:', error);
        throw error;
      }
    }
    
    // ✅ Wait for ALL API calls to complete before proceeding
    console.log(`\n⏳ Waiting for all ${conversationsToCapture.length} conversations to be captured...`);

    let attempts = 0;
    const expectedCount = conversationsToCapture.length;
    const maxAttempts = 30; // Max 60 seconds (30 × 2s)

    while (Object.keys(capturedData).length < expectedCount && attempts < maxAttempts) {
      const current = Object.keys(capturedData).length;
      const remaining = expectedCount - current;
      console.log(`⏳ [Attempt ${attempts + 1}/${maxAttempts}] ${current}/${expectedCount} conversations captured (${remaining} remaining)...`);
      await new Promise(resolve => setTimeout(resolve, 2000)); // Check every 2 seconds
      attempts++;
    }

    const finalCount = Object.keys(capturedData).length;

    // Identify missing conversations
    const capturedIds = new Set(Object.keys(capturedData));
    const missingConversations = conversationsToCapture.filter(c => !capturedIds.has(c.id));

    if (finalCount < expectedCount) {
      console.warn(`⚠️ Only captured ${finalCount}/${expectedCount} conversations`);
      console.warn(`Missing ${missingConversations.length} conversations:`, missingConversations.map(c => c.id));
      
      // Try to recapture missing conversations ONE MORE TIME
      if (missingConversations.length > 0 && missingConversations.length <= 10) {
        console.log(`\n🔄 Attempting to recapture ${missingConversations.length} missing conversations...`);
        
        for (let i = 0; i < missingConversations.length; i++) {
          const conv = missingConversations[i];
          console.log(`🔄 [${i + 1}/${missingConversations.length}] Retrying: ${conv.title.substring(0, 40)}...`);
          
          // Navigate
          await chrome.tabs.update(tab.id, { url: conv.url });
          
          // Wait for navigation
          await new Promise(resolve => {
            const listener = (tabId, info) => {
              if (tabId === tab.id && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
            setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }, 10000);
          });
          
          // Wait for content and API calls
          await new Promise(resolve => setTimeout(resolve, 8000)); // Longer wait
          
          // Check if captured now
          if (capturedData[conv.id]) {
            console.log(`✅ Successfully recaptured: ${conv.id}`);
          } else {
            console.warn(`❌ Still missing after retry: ${conv.id}`);
          }
        }
        
        // Update final count
        const retryCount = Object.keys(capturedData).length;
        console.log(`🔄 After retry: ${retryCount}/${expectedCount} conversations captured`);
      }
    } else {
      console.log(`✅ All ${finalCount} conversations captured successfully!`);
    }

    if (conversationsToCapture.length === 0) {
      console.warn('No conversations to capture (after provider detection).');
    } else {
      console.log(`\n⏳ Waiting for all ${conversationsToCapture.length} conversations to be captured...`);
    }

    console.log(`\n📦 Proceeding to save ${Object.keys(capturedData).length} captured conversations...`);
    
    // Prepare capture data
    const captureCount = Object.keys(capturedData).length;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `claude-project-${projectId}-${timestamp}.json`;
    
    if (captureCount === 0) {
      throw new Error('No conversation data was captured. Try refreshing the page and clicking the extension again.');
    }
    
    // Send to Supabase backend
    if (storageMode === 'supabase' || storageMode === 'both') {
      try {
        console.log('Sending data to backend...');

        // ✅ Convert capturedData object to array
        const capturedConversations = Object.values(capturedData);

        console.log(`\n🔍 Filtering ${capturedConversations.length} captured conversations for new content...`);

        // Filter each conversation for incremental content
        const filteredConversations = [];
        for (const convData of capturedConversations) {
          const convId = convData.id;
          
          // Get existing content IDs from backend/cache
          const existingContent = await getExistingContent(convId);
          
          // Filter to only new messages/files/blocks
          const filteredData = await filterExistingContent(convData, existingContent);
          
          // Only include conversations that have NEW content
          if (filteredData.messages && filteredData.messages.length > 0) {
            filteredConversations.push(filteredData);
            console.log(`✅ ${convId}: ${filteredData.messages.length} new messages to capture`);
          } else {
            console.log(`⏭️ ${convId}: No new content, skipping`);
          }
        }

        console.log(`\n📊 Summary: ${filteredConversations.length}/${capturedConversations.length} conversations have new content\n`);

        // Send each FILTERED conversation to backend
        let savedCount = 0;
        let successCount = 0;
        let failedCount = 0;
        const totalToSave = filteredConversations.length;
        const savedConversationIds = [];
        const failedConversations = [];  // ✅ Track failures

        // Handle case where no new content found
        if (totalToSave === 0) {
          console.log('🎉 All conversations are already up to date!');
          
          await sendProgressUpdate({
            message: '✅ All conversations already captured! No new content found.',
            status: 'complete',
            autoClose: true
          });

          // Update widget to synced state
          await updateWidgetState('synced', new Date().toISOString());
          
          // Open dashboard anyway
          /*
          let dashboardUrl = `${BACKEND_URL}/project-dashboard?projectId=${projectId}&userId=${encodeURIComponent(userId)}`;
          if (authTokens.accessToken) {
            dashboardUrl += `#token=${encodeURIComponent(authTokens.accessToken)}`;
          }
          await chrome.tabs.create({ url: dashboardUrl });
          */
          
          // Close progress after 2 seconds
          setTimeout(() => {
            if (progressWindowId) {
              chrome.windows.remove(progressWindowId).catch(() => {});
              progressWindowId = null;
              progressPopupId = null;
            }
          }, 2000);
          
          return; // Exit early
        }

        for (const convData of filteredConversations) {
          savedCount++;
          const convId = convData.id;
          
          try {
            await sendProgressUpdate({
              message: `💾 Saving conversation ${savedCount}/${totalToSave}...`,
              current: savedCount,
              total: totalToSave
            });
            
            // Add project name to conversation data
            convData.project_name = convData.notebookProjectName || projectName;
            convData.project_id = convData.notebookProjectId || projectId;
            
            const response = await authFetch(`${BACKEND_URL}/api/extension/capture`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                projectId: convData.notebookProjectId || projectId,
                conversationId: convId,
                conversation: convData,
                userId: userId,
                captureMetadata: { source: 'extension', version: '1.0' }
              })
            });
            
            if (response.ok) {
              console.log(`✅ Saved to Supabase: ${convId}`);
              successCount++;
              savedConversationIds.push(convId);
            } else {
              console.error(`Failed to save conversation ${convId}:`, await response.text());
              failedCount++;
              failedConversations.push(convId);  // ✅ Track failure
              await sendProgressUpdate({
                message: `❌ Failed to save conversation ${savedCount}`,
                status: 'error'
              });
            }
          } catch (error) {
            console.error(`Error saving conversation ${convId}:`, error);
            failedCount++;
            failedConversations.push(convId);  // ✅ Track failure
          }
        }

        // ✅ Wait for ALL saved conversations to finish embedding
        if (savedConversationIds.length > 0) {
          await sendProgressUpdate({
            message: `🎉 Capture complete! Saved ${successCount}/${totalToSave} conversations. Generating embeddings...`,
            status: 'embedding'
          });
          
          // Single project-level auto-embed — conversationId is logging-only on the
          // backend; all per-conversation calls were doing identical work and
          // competing via the semaphore. One call processes everything.
          console.log('⚡ Triggering project-level embeddings for ' + savedConversationIds.length + ' conversations...');
          await authFetch(BACKEND_URL + '/api/context/_auto-embed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId })
          }).catch(e => console.error('Failed to trigger auto-embed:', e));

          // Wait for project-level embeddings to complete (messages, files, blocks, conversations)
          console.log('⏳ Waiting for all embeddings to complete...');
          await sendProgressUpdate({
            message: `🔄 Generating embeddings for ${successCount} conversations...`,
            status: 'embedding'
          });

          // Use project-level wait (not per-conversation)
          await waitForEmbeddingsComplete(projectId, progressPopupId);
                    
          // ✅ Now open dashboard (all embeddings complete!)
          /*
          const dashboardUrl = `${BACKEND_URL}/project-dashboard?projectId=${projectId}&userId=${encodeURIComponent(userId)}#token=${encodeURIComponent(authTokens.accessToken || '')}`;
          console.log('Opening dashboard:', dashboardUrl);
          
          await chrome.tabs.create({ url: dashboardUrl });
          */

          await sendProgressUpdate({
            message: '✅ All embeddings complete! Dashboard ready.',
            status: 'complete',
            autoClose: true,
          });
          // Update widget to synced state
          await updateWidgetState('synced', new Date().toISOString());
        }
        
      } catch (error) {
        console.error('Backend save failed:', error);
        storageMode = 'download';
      }
    }
        
    // Save failed or all conversations locally if needed
    if (failedConversations.length > 0 || storageMode === 'download' || storageMode === 'both') {
      const dataToSave = failedConversations.length > 0 
        ? Object.fromEntries(failedConversations.map(id => [id, capturedData[id]]).filter(([,v]) => v))
        : capturedData;
        
      const saveFilename = failedConversations.length > 0 
        ? `failed-conversations-${projectId}-${timestamp}.json`
        : filename;
      
      const jsonString = JSON.stringify(dataToSave, null, 2);
      const base64 = btoa(unescape(encodeURIComponent(jsonString)));
      const dataUrl = `data:application/json;base64,${base64}`;
      
      chrome.downloads.download({
        url: dataUrl,
        filename: saveFilename,
        saveAs: false
      });
      
      if (failedConversations.length > 0) {
        console.log(`Downloaded ${failedConversations.length} failed conversations as backup`);
      }
    }
    
    // Navigate back to project page
    console.log('Returning to project page...');
      await chrome.tabs.update(tab.id, { url: originalProjectUrl });
      
    } catch (error) {
      console.error('Capture error:', error);

      await sendProgressUpdate({
        message: `Error: ${error.message}`,
        status: 'error'
      });

      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'ContextBridge Error',
        message: error.message || 'An error occurred during capture'
      });
    
    // Clean up
    if (originalProjectUrl) {
      try {
        await chrome.tabs.update(tab.id, { url: originalProjectUrl });
      } catch (e) {
        console.error('Could not return to project page:', e);
      }
    }
    
  } finally {
    captureActive = false;
    
    // Always clean up progress window to prevent orphaned extension pages
    // (ERR_BLOCKED_BY_CLIENT when service worker goes inactive)
    if (progressWindowId) {
      try {
        // Small delay to let any final progress message render
        await new Promise(resolve => setTimeout(resolve, 3000));
        chrome.windows.remove(progressWindowId).catch(() => {});
      } catch (e) {
        // Window may already be closed by user
      }
      progressWindowId = null;
      progressPopupId = null;
    }
    
    // Widget handles its own state transitions via timeout
  }
}

// Handle extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  console.log('Extension clicked on tab:', tab.url);
  await startProjectCapture(tab);
});

/**
 * Generates a deterministic 36-char UUID for Gemini messages 
 * so Supabase deduplication succeeds.
 */
function getGeminiMessageUUID(geminiId, index, type) {
  const hexType = type === 'user' ? '1111' : '2222';
  const hexIndex = String(index).padStart(8, '0');
  const paddedBase = geminiId.padEnd(16, '0').slice(0, 16);
  const raw32 = paddedBase + hexType + hexIndex + "0000";
  return `${raw32.slice(0,8)}-${raw32.slice(8,12)}-${raw32.slice(12,16)}-${raw32.slice(16,20)}-${raw32.slice(20,32)}`;
}

/**
 * Extracts markdown code blocks and formats them as standard attachments
 * Includes console logging and strict backend schema fields.
 */
function extractMarkdownBlocksAsAttachments(text) {
  const attachments = [];
  if (!text) return attachments;
  
  // Broadened regex: matches backticks, optional language tag, any whitespace/newlines, then content
  const regex = /```([\w-]*)\s*([\s\S]*?)```/g;
  let match;
  let index = 1;
  
  while ((match = regex.exec(text)) !== null) {
    const lang = match[1] || 'txt';
    const content = match[2].trim();
    
    console.log(`[Block Extractor] Found block ${index}: Language=${lang}, Length=${content.length}`);
    
    attachments.push({
      file_name: `code_block_${index}.${lang}`,
      extracted_content: content,
      // Provide robust metadata fields to prevent backend rejection
      content_type: 'text/plain', 
      type: 'file',
      size: content.length
    });
    index++;
  }
  
  if (attachments.length > 0) {
    console.log(`[Block Extractor] Total blocks extracted for this message: ${attachments.length}`);
  }
  
  return attachments;
}

/**
 * Intelligently extracts and reconstructs text from a Gemini turn array part,
 * filtering out base64 garbage and detecting code blocks to wrap in markdown.
 */
function extractTextFromTurnPart(partArray) {
  if (!Array.isArray(partArray)) return null;

  // 1. Extract all meaningful strings
  const allStrings = partArray.flat(Infinity).filter(item =>
    typeof item === 'string' &&
    item.length > 15 &&
    !item.startsWith('http') && // Ignore URLs
    !/^[a-zA-Z0-9+/=]{40,}$/.test(item) && // Ignore base64 image data
    !item.startsWith('$AedX') // Ignore Google's internal RPC encodings
  );

  // 2. Deduplicate (Gemini payload often repeats the same text 2-3 times)
  const uniqueStrings = [];
  for (const str of allStrings) {
    const cleanStr = str.trim();
    const isDuplicate = uniqueStrings.some(existing => existing.includes(cleanStr));
    if (!isDuplicate) {
      // If the new string is a LARGER version of an existing one, replace it
      const index = uniqueStrings.findIndex(existing => cleanStr.includes(existing));
      if (index !== -1) {
        uniqueStrings[index] = cleanStr;
      } else {
        uniqueStrings.push(cleanStr);
      }
    }
  }

  // 3. Reconstruct the full message, applying heuristics to detect stripped code blocks
  return uniqueStrings.map(str => {
    const codeIndicators = ['function ', 'const ', 'let ', 'var ', '=>', '{', '}', 'import ', '<div', 'class=', 'return ', 'console.log', 'background.js'];
    const lineCount = (str.match(/\n/g) || []).length;
    
    // If it has multiple lines and contains several coding keywords, treat it as a code block
    const matchCount = codeIndicators.filter(ind => str.includes(ind)).length;
    if (lineCount >= 1 && matchCount >= 2) {
        return `\`\`\`text\n${str}\n\`\`\``; // Re-inject the missing backticks!
    }
    return str;
  }).join('\n\n');
}

/**
 * Normalizes Gemini's nested hNvQHb array into standard message objects.
 */
function parseGeminiTurns(turnsArray, originalConvId) {
  // Google stores the actual array of exchanges inside the first element
  if (!Array.isArray(turnsArray) || !Array.isArray(turnsArray[0])) return { messages: [], lastModified: null };
  
  const extractedMessages = [];
  const exchanges = turnsArray[0]; // Isolate the actual turns
  
  exchanges.forEach((exchange, index) => {
    if (!Array.isArray(exchange)) return;

    // exchange[2] is ALWAYS the User's input array
    const userPart = exchange[2];
    
    // The Assistant's response and files are spread across the remaining array elements
    // We slice from index 3 to the end to ensure we capture all of it
    const assistantPart = exchange.slice(3);

    const userText = extractTextFromTurnPart(userPart);
    const assistantText = extractTextFromTurnPart(assistantPart);

    if (userText) {
      extractedMessages.push({ 
        uuid: getGeminiMessageUUID(originalConvId, index, 'user'), 
        sender: 'user', 
        text: userText,
        created_at: new Date().toISOString()
      });
    }
    if (assistantText) {
      extractedMessages.push({ 
        uuid: getGeminiMessageUUID(originalConvId, index, 'assistant'), 
        sender: 'assistant', 
        text: assistantText,
        attachments: extractMarkdownBlocksAsAttachments(assistantText), 
        created_at: new Date().toISOString()
      });
    }
  });

  // Extract last-modified timestamp from the last exchange's index 4
  let lastModified = null;
  const lastExchange = exchanges[exchanges.length - 1];
  if (Array.isArray(lastExchange?.[4]) && typeof lastExchange[4][0] === 'number') {
    lastModified = new Date(lastExchange[4][0] * 1000).toISOString();
  }

  return { messages: extractedMessages, lastModified };
  }

/**
 * Utility to safely extract text from Gemini's nested arrays.
 */
function findDeepestString(arr, targetIndex = 0) {
  if (!Array.isArray(arr)) return null;
  
  const flatStrings = arr.flat(Infinity).filter(item => 
    typeof item === 'string' && 
    item.length > 10 && 
    !/^[a-zA-Z0-9_-]{10,30}$/.test(item) 
  );

  return flatStrings[targetIndex] || flatStrings[0] || null;
}

// Parse OpenAI's tree structure into flat message array
function parseOpenAIMessages(mapping) {
  console.log('[Parser] Starting to parse OpenAI messages...');
  console.log('[Parser] Mapping keys:', Object.keys(mapping).slice(0, 10));

  // ============================================
  // PHASE 1: Build extracted content map from file_search tool messages
  // ============================================
  const extractedContentMap = new Map(); // messageId -> extracted text
  const fileIdToContentMap = new Map();  // fileId -> extracted text
  
  // First pass: collect all file_search results
  for (const nodeId of Object.keys(mapping)) {
    const node = mapping[nodeId];
    const msg = node.message;
    if (!msg) continue;
    
    // Look for file_search tool messages with multimodal_text content
    if (msg.author?.role === 'tool' && 
        msg.author?.name === 'file_search' &&
        msg.content?.content_type === 'multimodal_text' &&
        Array.isArray(msg.content?.parts)) {
      
      // Extract text from parts (skip citation instructions)
      let extractedText = '';
      for (const part of msg.content.parts) {
        if (typeof part === 'string') {
          // Skip citation instruction parts (various formats)
          if (part.startsWith('Make sure to include')) continue;
          if (part.includes('@filecite@') || part.includes('fileciteturn')) continue;
          // Include parsed text (may have page markers like "<PARSED TEXT FOR PAGE: 1 / 1>")
          extractedText += part + '\n';
        }
      }
      
      if (extractedText.trim()) {
        extractedContentMap.set(msg.id, extractedText.trim());
        console.log(`[OpenAI FILE EXTRACT] Found file_search content in message ${msg.id}: ${extractedText.length} chars`);
      }
    }
  }
  
  // Second pass: link file IDs to extracted content via content_references
  for (const nodeId of Object.keys(mapping)) {
    const node = mapping[nodeId];
    const msg = node.message;
    if (!msg) continue;
    
    // Look for assistant messages with content_references
    const contentRefs = msg.metadata?.content_references || [];
    for (const ref of contentRefs) {
      if (ref.type === 'file' && ref.id && ref.input_pointer?.message_id) {
        const extractedText = extractedContentMap.get(ref.input_pointer.message_id);
        if (extractedText) {
          fileIdToContentMap.set(ref.id, extractedText);
          console.log(`[OpenAI FILE EXTRACT] Linked file ${ref.id} (${ref.name}) to extracted content`);
        }
      }
    }
    
    // Also check citations array (alternative location)
    const citations = msg.metadata?.citations || [];
    for (const citation of citations) {
      if (citation.metadata?.type === 'file' && 
          citation.metadata?.id && 
          citation.metadata?.extra?.cited_message_id) {
        const extractedText = extractedContentMap.get(citation.metadata.extra.cited_message_id);
        if (extractedText && !fileIdToContentMap.has(citation.metadata.id)) {
          fileIdToContentMap.set(citation.metadata.id, extractedText);
          console.log(`[OpenAI FILE EXTRACT] Linked file ${citation.metadata.id} (${citation.metadata.name}) via citation`);
        }
      }
    }
  }
  
  console.log(`[OpenAI FILE EXTRACT] Total files with extracted content: ${fileIdToContentMap.size}`);
  // ============================================
  // END PHASE 1
  // ============================================
  
  const messages = [];
  
  function traverse(nodeId, depth = 0) {
    const node = mapping[nodeId];
    if (!node) return;
    
    if (!node.message) {
      if (node.children) {
        for (const childId of node.children) {
          traverse(childId, depth + 1);
        }
      }
      return;
    }
    
    const msg = node.message;

    // DEBUG: Look for AI-generated file download links
    if (msg.author?.role === 'assistant') {
      // Check for any field containing 'estuary' or 'download'
      const msgStr = JSON.stringify(msg);
      if (msgStr.includes('estuary') || msgStr.includes('download') || msgStr.includes('file_')) {
        console.log('[OpenAI ARTIFACT DEBUG] Assistant message with file reference:', msgStr.substring(0, 2000));
      }
    }

    // DEBUG: Log file-related structures in OpenAI messages
    if (msg.metadata?.attachments?.length > 0) {
      // Check all possible locations for extracted content
      console.log('[OpenAI USER FILE] Checking message structure for file content:');
      console.log('[OpenAI USER FILE] - msg.metadata keys:', Object.keys(msg.metadata || {}));
      console.log('[OpenAI USER FILE] - msg.content keys:', Object.keys(msg.content || {}));
      console.log('[OpenAI USER FILE] - Full msg.metadata:', JSON.stringify(msg.metadata, null, 2).substring(0, 2000));
      console.log(`[OpenAI FILE DEBUG] Message ${msg.id} has attachments:`, 
        JSON.stringify(msg.metadata.attachments, null, 2));
    }
    if (msg.content?.parts) {
      msg.content.parts.forEach((part, idx) => {
        if (typeof part !== 'string' && part?.content_type !== 'text') {
          console.log(`[OpenAI FILE DEBUG] Message ${msg.id} part[${idx}]:`, 
            JSON.stringify(part, null, 2));
        }
      });
    }
    
    if (msg.author?.role === 'user' || msg.author?.role === 'assistant') {
      let textContent = '';
      if (msg.content?.parts) {
        for (const part of msg.content.parts) {
          if (typeof part === 'string') {
            textContent += part;
          } else if (part?.content_type === 'text') {
            textContent += part.text || '';
          } else if (part?.content_type === 'image_asset_pointer') {
            textContent += `[Image: ${part.asset_pointer}]\n`;
          }
        }
      }

    // DEBUG: Check content.parts for extracted file text
    if (msg.metadata?.attachments?.length > 0 && msg.content?.parts) {
      console.log('[OpenAI USER FILE] Content parts count:', msg.content.parts.length);
      msg.content.parts.forEach((part, idx) => {
        if (typeof part === 'string') {
          console.log(`[OpenAI USER FILE] Part ${idx} (string, ${part.length} chars):`, part.substring(0, 500));
        } else if (typeof part === 'object') {
          console.log(`[OpenAI USER FILE] Part ${idx} (object):`, JSON.stringify(part, null, 2).substring(0, 1000));
        }
      });
    }
      
      // Enrich attachments with extracted content
      const enrichedAttachments = (msg.metadata?.attachments || []).map(attachment => {
        const extractedContent = fileIdToContentMap.get(attachment.id);
        if (extractedContent) {
          console.log(`[OpenAI FILE EXTRACT] Enriching attachment ${attachment.name} with ${extractedContent.length} chars`);
          return {
            ...attachment,
            extracted_content: extractedContent,
            file_name: attachment.name  // Normalize field name for backend compatibility
          };
        }
        return {
          ...attachment,
          file_name: attachment.name  // Normalize field name for backend compatibility
        };
      });

      messages.push({
        uuid: msg.id,
        sender: msg.author.role,
        text: textContent,
        created_at: new Date(msg.create_time * 1000).toISOString(),
        updated_at: new Date((msg.update_time || msg.create_time) * 1000).toISOString(),
        attachments: enrichedAttachments,
        index: messages.length
      });
      
      console.log(`[Parser] Added message #${messages.length}: ${msg.author.role}, ${textContent.length} chars`);
    }
    
    if (node.children && node.children.length > 0) {
      for (const childId of node.children) {
        traverse(childId, depth + 1);
      }
    }
  }
  
  const rootNode = Object.keys(mapping).find(id => {
    const node = mapping[id];
    return !node.parent || node.parent === null;
  });
  
  console.log(`[Parser] Root node: ${rootNode}`);
  
  if (rootNode) {
    traverse(rootNode);
  }
  
  console.log(`[Parser] Total messages extracted: ${messages.length}`);
  
  return messages;
}