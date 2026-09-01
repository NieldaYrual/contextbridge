// Universal Context Injection Modal for Claude.ai and OpenAI ChatGPT
(function() {
  'use strict';

  // === PLATFORM DETECTION ===
  const PLATFORM = detectPlatform();
  
  function detectPlatform() {
    const hostname = location.hostname;
    if (hostname.includes('claude.ai')) return 'claude';
    if (hostname.includes('chatgpt.com') || hostname.includes('chat.openai.com')) return 'openai';
    if (hostname.includes('gemini.google.com')) return 'gemini';
    if (hostname.includes('grok.com') || hostname.includes('x.com') || hostname.includes('grok.x.ai')) return 'grok';
    return null; // Not on a supported platform
  }

  // --- Display Helpers ---
  function getProjectProviderLabel(provider) {
    if (!provider) return 'Other';
    const p = String(provider).toLowerCase();
    if (p === 'claude') return 'ClaudeAI';
    if (p === 'openai') return 'OpenAI';
    if (p === 'gemini') return 'Gemini';
    if (p === 'grok') return 'Grok';
    if (p === 'codex') return 'Codex';
    return p.charAt(0).toUpperCase() + p.slice(1);
  }

  // Exit early if not on supported platform
  if (!PLATFORM) {
    console.log('[CB] Not on supported platform, exiting');
    return;
  }

  console.log(`[CB] Platform detected: ${PLATFORM}`);

  // === AUTH HELPER ===
  async function getAccessToken() {
    try {
      // Always get fresh token from storage (background.js keeps it updated)
      const result = await chrome.storage.sync.get(['accessToken']);
      return result.accessToken || null;
    } catch (e) {
      console.warn('[CB] Failed to get access token:', e);
      return null;
    }
  }
  
  async function authFetch(url, options = {}) {
    const token = await getAccessToken();
    if (token) {
      options.headers = {
        ...options.headers,
        'Authorization': `Bearer ${token}`
      };
    }
    
    const response = await fetch(url, options);
    
    // If 401, try to refresh token via background and retry once
    if (response.status === 401) {
      console.log('[CB] Got 401, requesting token refresh...');
      try {
        const refreshResult = await chrome.runtime.sendMessage({ action: 'refreshToken' });
        if (refreshResult?.success && refreshResult.accessToken) {
          // Retry with new token
          options.headers['Authorization'] = `Bearer ${refreshResult.accessToken}`;
          return fetch(url, options);
        }
      } catch (e) {
        console.warn('[CB] Token refresh failed:', e);
      }
    }
    
    return response;
  }

  const PANEL_ID = 'cb-simple-panel';
  // Backend URL - loaded from storage with fallback
  const DEFAULT_BACKEND_URL = 'http://localhost:3001';
  let API_BASE = DEFAULT_BACKEND_URL;

  // ============================================================================
  // SCROLL-TO-MESSAGE: If opened from a search result, scroll to the target message
  // ============================================================================
  (function checkScrollTarget() {
    chrome.storage.local.get(['cb_scroll_target'], (result) => {
      const target = result?.cb_scroll_target;
      if (!target || !target.searchText) return;

      // Only act if the target is recent (< 30 seconds old)
      if (Date.now() - target.timestamp > 30000) {
        chrome.storage.local.remove('cb_scroll_target');
        return;
      }

      // Check if this page matches the target conversation
      const currentUrl = location.href;
      if (target.conversationId && !currentUrl.includes(target.conversationId)) return;

      // Clear immediately so it doesn't trigger again on refresh
      chrome.storage.local.remove('cb_scroll_target');

      console.log('[CB] Scroll-to-message: looking for:', target.searchText.substring(0, 40));

      // Retry up to 15 times over ~15 seconds (pages lazy-load messages)
      let attempts = 0;
      const maxAttempts = 15;

      function highlightAndScroll(el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const origOutline = el.style.outline;
        const origBg = el.style.backgroundColor;
        el.style.outline = '2px solid #8B5CF6';
        el.style.backgroundColor = 'rgba(59, 130, 246, 0.08)';
        setTimeout(() => {
          el.style.outline = origOutline;
          el.style.backgroundColor = origBg;
        }, 3000);
      }

      function tryScroll() {
        attempts++;

        // Phase 1: Direct messageId lookup (Claude has data-message-id attributes)
        if (target.messageId) {
          const directMatch = document.querySelector(`[data-message-id="${target.messageId}"]`);
          if (directMatch) {
            console.log('[CB] Scroll-to-message: direct messageId match on attempt', attempts);
            highlightAndScroll(directMatch);
            return;
          }
        }

        // Phase 2: Fallback to text search
        const searchStr = target.searchText.substring(0, 60).toLowerCase();

        // Search all message elements on the page
        const messageSelectors = [
          '[data-message-id]',           // Claude
          '.message',                     // ChatGPT
          '.markdown',                    // ChatGPT rendered
          '[class*="message"]',           // Generic
          '[class*="conversation"]',      // Generic
          'article',                      // Some platforms
        ];

        let bestMatch = null;
        let bestScore = 0;

        for (const selector of messageSelectors) {
          const elements = document.querySelectorAll(selector);
          for (const el of elements) {
            const text = el.textContent?.toLowerCase() || '';
            if (text.includes(searchStr)) {
              // Prefer shorter elements (more specific match)
              const score = searchStr.length / Math.max(text.length, 1);
              if (score > bestScore) {
                bestScore = score;
                bestMatch = el;
              }
            }
          }
        }

        if (bestMatch) {
          console.log('[CB] Scroll-to-message: text match on attempt', attempts);
          highlightAndScroll(bestMatch);
          return;
        }

        // Retry
        if (attempts < maxAttempts) {
          setTimeout(tryScroll, 1000);
        } else {
          console.log('[CB] Scroll-to-message: gave up after', maxAttempts, 'attempts');
        }
      }

      // Start after a short delay to let the page begin rendering
      setTimeout(tryScroll, 2000);
    });
  })();
  
  // Load backend URL from storage
  chrome.storage.sync.get(['backendUrl'], (result) => {
    if (result.backendUrl) {
      API_BASE = result.backendUrl;
      console.log('[CB] Using backend:', API_BASE);
    }
  });
  // const PROJECT_ID_KEY = 'cb_current_project_id';
  const SELECTED_PROJECTS_KEY = 'cb_selected_project_ids';

  // Codex State
  const INCLUDE_CODEX_KEY = 'cb_include_codex';

  const TIERED_CONFIG = {
    maxArtifacts: 3,           // Show 3 initially, expandable
    maxArtifactsTotal: 10,     // Maximum total files to show (including expanded)
    maxMemory: 3,              // Show 3 initially, expandable
    maxMemoryTotal: 10,        // Maximum total conversations to show
    highlightColor: '#fef08a', // Yellow highlight for keyword matches
  }
  
  let availableProjects = [];
  let selectedProjectIds = [];
  let includeCodex = false; // Default, will be overwritten by async load
  // let settingsLoaded = false; // Track if initial load is complete

  // Load all settings from chrome.storage.local
  async function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get([INCLUDE_CODEX_KEY, SELECTED_PROJECTS_KEY, 'cb_use_context_pack'], (result) => {
        // Load includeCodex (default false if not set)
        if (result[INCLUDE_CODEX_KEY] !== undefined) {
          includeCodex = result[INCLUDE_CODEX_KEY] === true;
        } else {
          includeCodex = false;
          chrome.storage.local.set({ [INCLUDE_CODEX_KEY]: false });
        }
        
        // Load selectedProjectIds
        if (result[SELECTED_PROJECTS_KEY]) {
          try {
            selectedProjectIds = Array.isArray(result[SELECTED_PROJECTS_KEY]) 
              ? result[SELECTED_PROJECTS_KEY] 
              : JSON.parse(result[SELECTED_PROJECTS_KEY]);
          } catch (e) {
            selectedProjectIds = [];
          }
        } else {
          selectedProjectIds = [];
        }

        // Load USE_CONTEXT_PACK (default true if not set)
        USE_CONTEXT_PACK = result['cb_use_context_pack'] === true;
        
        // settingsLoaded = true;
        console.log('[CB] Settings loaded:', { includeCodex, selectedProjectIds });
        resolve({ includeCodex, selectedProjectIds });
      });
    });
  }

  // Load selected projects from storage (Async)
  function loadSelectedProjects() {
    return new Promise((resolve) => {
      // Try chrome.storage.local first (cross-domain)
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([SELECTED_PROJECTS_KEY], (result) => {
          let ids = [];
          if (result[SELECTED_PROJECTS_KEY]) {
            try {
              ids = JSON.parse(result[SELECTED_PROJECTS_KEY]);
            } catch (e) { ids = []; }
          }
          selectedProjectIds = ids; // No fallback to hardcoded ID
          resolve(selectedProjectIds);
        });
      } else {
        // Fallback to localStorage (dev/testing)
        const stored = localStorage.getItem(SELECTED_PROJECTS_KEY);
        if (stored) {
          try {
            selectedProjectIds = JSON.parse(stored);
          } catch (e) { selectedProjectIds = []; }
        } else {
          selectedProjectIds = [];
        }
        resolve(selectedProjectIds);
      }
    });
  }

  // Save selected projects to storage (Async-safe)
  function saveSelectedProjects() {
    // 1. Save to Chrome Storage (The Source of Truth)
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [SELECTED_PROJECTS_KEY]: JSON.stringify(selectedProjectIds) });
    }
    
    // 2. Save to LocalStorage (Fallback/Dev)
    localStorage.setItem(SELECTED_PROJECTS_KEY, JSON.stringify(selectedProjectIds));
    
    updateProjectCount();
  }

  function saveCodexState() {
    chrome.storage.local.set({ [INCLUDE_CODEX_KEY]: includeCodex });
    updateProjectCount();
  }

  // Update project count badge
  function updateProjectCount() {
    const badge = document.getElementById('cb-project-count');
    if (badge) {
      // Count actual projects + 1 if Codex is enabled
      const total = selectedProjectIds.length + (includeCodex ? 1 : 0);
      badge.textContent = total;
    }
  }

  let currentResult = null;

  // === Mode toggle (persisted) ===
  let USE_CONTEXT_PACK = false; // Default, will be overwritten by async load

  // === DRAGGABLE LOGIC ===
  function makeDraggable(el) {
    const header = el.querySelector('#cb-header');
    if (!header) return;

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
      // Don't drag if clicking buttons/inputs/labels inside header
      if (['BUTTON', 'INPUT', 'LABEL', 'SELECT'].includes(e.target.tagName)) return;
      if (e.target.closest('button') || e.target.closest('label')) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      
      const rect = el.getBoundingClientRect();
      
      // Switch from right/bottom positioning to left/top for dragging
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.left = rect.left + 'px';
      el.style.top = rect.top + 'px';
      
      initialLeft = rect.left;
      initialTop = rect.top;
      
      header.style.cursor = 'grabbing';
      e.preventDefault(); // Prevent text selection
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.left = `${initialLeft + dx}px`;
      el.style.top = `${initialTop + dy}px`;
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      if (header) header.style.cursor = 'move';
    });
  }

  function togglePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) { 
      panel.remove(); 
      return; 
    }

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    
    panel.innerHTML = `
      <div id="cb-simple-shell" style="
        position:fixed; right:20px; bottom:80px;
        width:500px; max-width:90vw;
        background:#0A0A0B; color:#FAFAFA; 
        border:1px solid #27272A; border-radius:14px;
        box-shadow:0 20px 50px rgba(0,0,0,.6);
        z-index:2147483647;
        display:flex; flex-direction:column;
        font-family: system-ui, -apple-system, sans-serif;">
        
        <div id="cb-header" style="padding:16px; background:#141415; border-bottom:1px solid #27272A; 
                    border-radius:12px 12px 0 0; cursor: move; user-select: none;">
          
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <div style="font-weight:600; font-size:16px; color:#FAFAFA; pointer-events: none;">
              🔍 Context Injection Assistant
            </div>
            <button id="cb-close" style="padding:6px 12px; border-radius:6px; border:1px solid #3F3F46; 
                                          background:#27272A; color:#A1A1AA; cursor:pointer; font-size:13px; transition:all 0.2s;">
              Close
            </button>
          </div>

          <div style="display:flex; align-items:center; gap:12px; position:relative; flex-wrap: wrap;">
            
            <div style="position:relative;">
              <button id="cb-select-projects" style="padding:8px 14px; border-radius:6px; border:1px solid #3F3F46; 
                                                      background:#27272A; color:#FAFAFA; cursor:pointer; font-size:13px;
                                                      display:flex; align-items:center; gap:6px;">
                📂 <span>Projects (<span id="cb-project-count">1</span>)</span>
              </button>
              
              <div id="cb-project-dropdown" style="display:none; position:absolute; top:100%; left:0; 
                                                  min-width:320px; background:#0A0A0B; border:1px solid #27272A; 
                                                  border-radius:8px; margin-top:8px; max-height:400px; overflow-y:auto; 
                                                  z-index:1000; box-shadow:0 10px 30px rgba(0,0,0,0.5);">
                <div id="cb-project-dropdown-list" style="padding:8px;">
                  <div style="text-align:center; padding:20px; color:#71717A; font-size:13px;">
                    Loading projects...
                  </div>
                </div>
              </div>
            </div>
            
            <!-- COMPACT FORMAT CHECKBOX HIDDEN - confusing for beta users, re-enable when ready
            <label style="display:flex; align-items:center; gap:6px; font-size:13px; color:#A1A1AA; cursor:pointer; margin-left:auto;">
              <input type="checkbox" id="cb-use-context-pack" style="cursor:pointer; accent-color: #8B5CF6;">
              <span>Compact Format</span>
            </label>
            -->
          </div>
        </div>

        <div style="padding:16px; background:#141415; border-bottom:1px solid #27272A;">
        <input id="cb-query" type="text" placeholder="What context do you need? (e.g., 'Find the auth logic in the user controller')"
                style="width:100%; padding:12px; border-radius:8px; border:1px solid #3F3F46; 
                    background:#0A0A0B; color:#FAFAFA; font-size:14px; box-sizing:border-box;"/>
        
        <div style="display:flex; gap:8px; margin-top:12px;">
            <button id="cb-search" style="flex:1; padding:12px; border-radius:8px; border:1px solid #3F3F46; 
                                        background:#1C1C1E; color:#A1A1AA; font-weight:600; cursor:pointer; font-size:14px; transition:all 0.2s;">
            🔍 Search
            </button>
            <button id="cb-summarize" style="padding:12px 16px; border-radius:8px; border:1px solid #3F3F46; 
                                        background:#1C1C1E; color:#A1A1AA; font-weight:600; cursor:pointer; font-size:14px; transition:all 0.2s;">
            ✨ Summarize
            </button>
            <button id="cb-dashboard" style="padding:12px 16px; border-radius:8px; border:1px solid #3F3F46; 
                                        background:#1C1C1E; color:#A1A1AA; font-weight:600; cursor:pointer; font-size:14px; transition:all 0.2s;">
            🏠 Dashboard
            </button>
        </div>
        </div>

        <!-- Summarize popup (inline, hidden by default) -->
        <div id="cb-summarize-popup" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:2147483648; align-items:center; justify-content:center;">
          <div style="background:#141415; border:1px solid #27272A; border-radius:14px; width:580px; max-width:92vw; max-height:86vh; display:flex; flex-direction:column; overflow:hidden; box-shadow:0 24px 60px rgba(0,0,0,0.8); font-family:system-ui,-apple-system,sans-serif;">
            <div style="display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid #27272A;">
              <strong style="font-size:15px; color:#FAFAFA;">✨ Summarize Conversation</strong>
              <button id="cb-summarize-close" style="padding:6px 12px; border-radius:6px; border:1px solid #3F3F46; background:#27272A; color:#A1A1AA; cursor:pointer; font-size:13px; transition:all 0.2s;">Close</button>
            </div>
            <div id="cb-summarize-body" style="padding:20px; overflow-y:auto; flex:1;">
              <div id="cb-summarize-step1">
                <div style="display:flex; gap:10px; align-items:center; margin-bottom:6px;">
                  <input id="cb-summarize-title" type="text" placeholder="Title of next conversation (optional)"
                    style="flex:1; padding:8px 12px; border-radius:6px; border:1px solid #3F3F46; background:#0A0A0B; color:#FAFAFA; font-size:13px;"/>
                  <button id="cb-summarize-generate" style="padding:8px 16px; border-radius:6px; border:1px solid #8b5cf6; background:#8b5cf6; color:white; font-weight:600; cursor:pointer; font-size:13px; white-space:nowrap;">Generate</button>
                </div>
                <div style="font-size:12px; color:#71717A;">Optionally name the conversation you're about to start, then click Generate.</div>
              </div>
              <div id="cb-summarize-generating" style="display:none; text-align:center; padding:32px 20px; color:#A1A1AA; font-size:13px;">
                <div>✨ Generating summary...</div>
                <div style="margin-top:12px; background:#27272A; border-radius:100px; height:4px; overflow:hidden;">
                  <div id="cb-summarize-progress" style="height:4px; width:0%; background:#8b5cf6; border-radius:100px; transition:width 0.4s ease;"></div>
                </div>
              </div>
              <div id="cb-summarize-results" style="display:none;">
                <div style="margin-bottom:16px;">
                  <div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; color:#8b5cf6; margin-bottom:6px;">Summary</div>
                  <pre id="cb-sum-summary" style="white-space:pre-wrap; font-family:inherit; font-size:13px; color:#A1A1AA; margin:0; line-height:1.6;"></pre>
                </div>
                <div style="margin-bottom:16px;">
                  <div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; color:#8b5cf6; margin-bottom:6px;">Key Decisions</div>
                  <pre id="cb-sum-decisions" style="white-space:pre-wrap; font-family:inherit; font-size:13px; color:#A1A1AA; margin:0; line-height:1.6;"></pre>
                </div>
                <div style="margin-bottom:16px;">
                  <div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; color:#8b5cf6; margin-bottom:6px;">Open Items</div>
                  <pre id="cb-sum-open" style="white-space:pre-wrap; font-family:inherit; font-size:13px; color:#A1A1AA; margin:0; line-height:1.6;"></pre>
                </div>
                <div style="margin-bottom:16px;">
                  <div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; color:#8b5cf6; margin-bottom:6px;">Primer for Next Conversation</div>
                  <pre id="cb-sum-primer" style="white-space:pre-wrap; font-family:inherit; font-size:13px; color:#A1A1AA; margin:0; line-height:1.6;"></pre>
                </div>
              </div>
              <div id="cb-summarize-error" style="display:none; color:#ef4444; font-size:13px; padding:12px 0;"></div>
            </div>
            <div id="cb-summarize-footer" style="display:flex; gap:10px; padding:14px 20px; border-top:1px solid #27272A;">
              <button id="cb-summarize-close2" style="padding:8px 16px; border-radius:6px; border:1px solid #3F3F46; background:#27272A; color:#A1A1AA; cursor:pointer; font-size:13px; transition:all 0.2s;">Close</button>
            </div>
          </div>
        </div>

        <div id="cb-loading" style="display:none; padding:40px; text-align:center; color:#A1A1AA;">
          <div style="display:inline-block; width:40px; height:40px; border:4px solid #27272A; 
                      border-top-color:#8B5CF6; border-radius:50%; animation:spin 1s linear infinite;"></div>
          <div style="margin-top:16px;">Searching your knowledge base...</div>
        </div>

        <div id="cb-result" style="display:none; padding:16px; background:#0A0A0B; max-height:500px; overflow-y:auto;">
        
        <div style="margin-bottom:24px; padding-bottom:24px; border-bottom:1px solid #27272A;">
            <div style="font-size:13px; color:#71717A; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; font-weight:600;">
            📝 Answer
            </div>
            <div id="cb-answer" style="padding:16px; background:#141415; border:1px solid #27272A; 
                        border-radius:8px; color:#A1A1AA; line-height:1.7; white-space:pre-wrap; font-size:14px;">
            </div>

            <div style="display:flex; gap:8px; margin-top:12px;">
            <button id="cb-copy-answer" style="flex:1; padding:10px; border-radius:8px; border:1px solid #3F3F46; 
                                                background:#27272A; color:#A1A1AA; font-weight:500; cursor:pointer; font-size:13px; transition:all 0.2s;">
                📋 Copy Answer
            </button>
            <button id="cb-insert-answer" style="flex:1; padding:10px; border-radius:8px; border:1px solid #22c55e; 
                                        background:#22c55e; color:white; font-weight:600; cursor:pointer; font-size:13px;">
                ✨ Insert Answer
            </button>
            </div>

            <div id="cb-codex-section" style="margin-top:16px; display:none;">
              <div style="font-size:12px; color:#8B5CF6; text-transform:uppercase; letter-spacing:.5px; margin:8px 0; font-weight:600;">
                📦 Codex (Local)
              </div>
              <div id="cb-codex-list"></div>
              <div style="display:flex; gap:8px; margin-top:8px;">
                <button id="cb-copy-codex" style="flex:1; padding:8px; border-radius:6px; border:1px solid #3F3F46; 
                                                  background:#27272A; color:#FAFAFA; font-weight:500; cursor:pointer; font-size:12px;">
                  📋 Copy Codex
                </button>
                <button id="cb-insert-codex" style="flex:1; padding:8px; border-radius:6px; border:1px solid #22c55e; 
                                            background:#22c55e; color:white; font-weight:600; cursor:pointer; font-size:12px;">
                  ✨ Insert Codex
                </button>
              </div>
            </div>

            <div id="cb-top-picks" style="margin-top:12px; display:none;">
              <div style="font-size:12px; color:#71717A; text-transform:uppercase; letter-spacing:.5px; margin:8px 0;">
                ⭐ Top Picks
              </div>
              <div id="cb-top-picks-list" style="display:flex; flex-direction:column; gap:8px;"></div>
              <div style="display:flex; gap:8px; margin-top:8px;">
                <button id="cb-copy-picks" style="flex:1; padding:8px; border-radius:6px; border:1px solid #3F3F46; 
                                                  background:#27272A; color:#FAFAFA; font-weight:500; cursor:pointer; font-size:12px;">
                  📋 Copy Picks
                </button>
                <button id="cb-insert-picks" style="flex:1; padding:8px; border-radius:6px; border:1px solid #22c55e; 
                                                    background:#22c55e; color:white; font-weight:600; cursor:pointer; font-size:12px;">
                  ✨ Insert Picks
                </button>
              </div>
            </div>
        </div>

        <div id="cb-sources-section">
            <div style="font-size:13px; color:#71717A; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; font-weight:600;">
            📦 Source Files & Code
            </div>
            <div id="cb-paste" style="padding:16px; background:#141415; border:1px solid #27272A; 
                                    border-radius:8px; color:#A1A1AA; font-family:monospace; font-size:12px; 
                                    line-height:1.6; max-height:250px; overflow-y:auto; white-space:pre-wrap;">
            </div>
            <div id="cb-tokens" style="margin-top:8px; font-size:12px; color:#71717A; text-align:right;">
            </div>
            
              <div style="display:flex; gap:8px; margin-top:12px;">
                <button id="cb-copy-sources" style="flex:1; padding:10px; border-radius:8px; border:1px solid #3F3F46; 
                                                    background:#27272A; color:#FAFAFA; font-weight:500; cursor:pointer; font-size:13px;">
                    📋 Copy Sources
                </button>
                <button id="cb-insert-sources" style="flex:1; padding:10px; border-radius:8px; border:1px solid #22c55e; 
                                                        background:#22c55e; color:white; font-weight:600; cursor:pointer; font-size:13px;">
                    💾 Insert Sources
                </button>
                </div>
              </div>

              <div style="margin-top:20px; padding-top:20px; border-top:1px solid #27272A;">
                  <button id="cb-retry" style="width:100%; padding:10px; border-radius:8px; border:1px solid #3F3F46; 
                                              background:#141415; color:#A1A1AA; font-weight:500; cursor:pointer; font-size:13px; transition:all 0.2s;">
                  🔄 Retry Search
                  </button>
              </div>
            </div>

      <style>
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
          .cb-tiered-memory-card:hover, .cb-tiered-artifact-card:hover {
          border-color: #8B5CF6 !important;
          background: #141415 !important;
        }
      </style>
    `;

    document.body.appendChild(panel);
    
    const shell = panel.querySelector('#cb-simple-shell');
    makeDraggable(shell);
    
    setupEventListeners(panel);
  }

  // Fetch available projects from backend
  async function fetchProjects() {
    try {
      const storageResult = await chrome.storage.sync.get(['userId', 'accessToken']);
      const userId = storageResult.userId || 'default';
      const accessToken = storageResult.accessToken;
      
      const headers = {};
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }
      
      const response = await fetch(`${API_BASE}/api/projects/list?userId=${encodeURIComponent(userId)}`, {
        headers
      });
      if (!response.ok) throw new Error(`Failed to fetch projects: ${response.status}`);
      const data = await response.json();
      availableProjects = data.projects || [];
      return availableProjects;
    } catch (error) {
      console.error('[CB] Failed to fetch projects:', error);
      return [];
    }
  }

  // Toggle project dropdown
  let dropdownOpen = false;

  async function toggleProjectDropdown() {
    const dropdown = document.getElementById('cb-project-dropdown');
    const listDiv = document.getElementById('cb-project-dropdown-list');
    
    if (!dropdown || !listDiv) return;

    dropdownOpen = !dropdownOpen;
    dropdown.style.display = dropdownOpen ? 'block' : 'none';
    
    if (!dropdownOpen) return;

    listDiv.innerHTML = '<div style="text-align:center; padding:20px; color:#71717A; font-size:13px;">Loading...</div>';
    await fetchProjects();
    
    if (availableProjects.length === 0) {
      listDiv.innerHTML = '<div style="text-align:center; padding:20px; color:#71717A; font-size:13px;">No projects found</div>';
      return;
    }

    const groups = {};
    availableProjects.forEach(p => {
        const provider = getProjectProviderLabel(p.provider);
        if (!groups[provider]) groups[provider] = [];
        groups[provider].push(p);
    });

    // --- VIRTUAL GROUP: CODEX ---
    if (!groups['Codex']) groups['Codex'] = [];
    groups['Codex'].push({
      id: 'virtual-codex-local',
      name: 'VS Code / Local',
      virtual: true
    });

    let html = '';
    const sortedKeys = Object.keys(groups).sort((a,b) => {
      if (a === 'Codex') return 1; 
      if (b === 'Codex') return -1;
      return a.localeCompare(b);
    });

    sortedKeys.forEach(provider => {
        html += `
            <div style="padding: 4px 8px; margin-top: 8px; margin-bottom:4px; font-size: 11px; font-weight: 700; color: #A1A1AA; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #27272A;">
                ${escapeHtml(provider)}
            </div>
        `;
        
        groups[provider].forEach(project => {
            const isSelected = project.virtual ? includeCodex : selectedProjectIds.includes(project.id);
            const subtext = project.virtual ? 'Local Codebase' : `${project.conversation_count || 0} conversations`;
            
            html += `
            <label style="display:flex; align-items:center; gap:10px; padding:10px; 
                          border-radius:6px; cursor:pointer; 
                          background:${isSelected ? 'rgba(139,92,246,0.15)' : 'transparent'}; 
                          transition:background 0.2s;">
              <input type="checkbox" 
                    class="cb-project-checkbox" 
                    data-project-id="${project.id}" 
                    data-is-virtual="${!!project.virtual}"
                    ${isSelected ? 'checked' : ''}
                    style="width:16px; height:16px; cursor:pointer;">
                <div style="flex:1;">
                  <div style="font-weight:600; color:#FAFAFA; font-size:13px;">
                    ${escapeHtml(project.name)}
                  </div>
                <div style="color:#71717A; font-size:11px; margin-top:2px;">
                  ${subtext}
                </div>
              </div>
            </label>
          `;
        });
    });

    listDiv.innerHTML = html;

    const checkboxes = listDiv.querySelectorAll('.cb-project-checkbox');
    checkboxes.forEach(cb => {
      cb.addEventListener('change', (e) => {
        const projectId = e.target.dataset.projectId;
        const isVirtual = e.target.dataset.isVirtual === 'true';

        console.log('[Dropdown] Clicked:', { projectId, isVirtual, checked: e.target.checked });

        if (isVirtual) {
          // Toggle Codex Global Flag
          includeCodex = e.target.checked;
          saveCodexState(); // This saves to localStorage
          console.log('[Dropdown] Updated Codex state to:', includeCodex);
        } else {
          if (e.target.checked) {
            if (!selectedProjectIds.includes(projectId)) selectedProjectIds.push(projectId);
          } else {
            selectedProjectIds = selectedProjectIds.filter(id => id !== projectId);
            // Allow unchecking last project ONLY if Codex is enabled, otherwise enforce at least one source
            if (selectedProjectIds.length === 0 && !includeCodex) {
              e.target.checked = true;
              selectedProjectIds.push(projectId);
              toast('⚠️ Select at least one source');
            }
          }
          saveSelectedProjects();
        }
      });
    });
  }

  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('cb-project-dropdown');
    const button = document.getElementById('cb-select-projects');
    if (dropdownOpen && dropdown && button && !dropdown.contains(e.target) && !button.contains(e.target)) {
      dropdownOpen = false;
      dropdown.style.display = 'none';
    }
  });

  function setupEventListeners(panel) {
    const queryInput = panel.querySelector('#cb-query');

    // ── Summarize button logic ──
    const summarizeBtn = panel.querySelector('#cb-summarize');
    const summarizePopup = panel.querySelector('#cb-summarize-popup');
    const summarizeClose = panel.querySelector('#cb-summarize-close');
    const summarizeClose2 = panel.querySelector('#cb-summarize-close2');
    const summarizeGenerate = panel.querySelector('#cb-summarize-generate');

    function cbOpenSummarizePopup() {
      panel.querySelector('#cb-summarize-step1').style.display = 'block';
      panel.querySelector('#cb-summarize-generating').style.display = 'none';
      panel.querySelector('#cb-summarize-results').style.display = 'none';
      panel.querySelector('#cb-summarize-error').style.display = 'none';
      panel.querySelector('#cb-summarize-title').value = '';
      panel.querySelector('#cb-summarize-footer').innerHTML = `
        <button id="cb-summarize-close2" style="padding:8px 16px; border-radius:6px; border:1px solid #3F3F46; background:#27272A; color:#A1A1AA; cursor:pointer; font-size:13px; transition:all 0.2s;">Close</button>
      `;
      panel.querySelector('#cb-summarize-footer').querySelector('button').addEventListener('click', () => {
        summarizePopup.style.display = 'none';
      });
      summarizePopup.style.display = 'flex';
      panel.querySelector('#cb-summarize-title').focus();
    }

    function cbCloseSummarizePopup() {
      summarizePopup.style.display = 'none';
    }

    summarizeBtn.addEventListener('click', cbOpenSummarizePopup);
    panel.querySelector('#cb-dashboard')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'openDashboard' });
    });
    summarizeClose.addEventListener('click', cbCloseSummarizePopup);
    summarizeClose2.addEventListener('click', cbCloseSummarizePopup);

    summarizeGenerate.addEventListener('click', async () => {
      const nextTitle = panel.querySelector('#cb-summarize-title').value.trim();
      const step1 = panel.querySelector('#cb-summarize-step1');
      const generating = panel.querySelector('#cb-summarize-generating');
      const results = panel.querySelector('#cb-summarize-results');
      const errorEl = panel.querySelector('#cb-summarize-error');
      const progressBar = panel.querySelector('#cb-summarize-progress');

      step1.style.display = 'none';
      generating.style.display = 'block';
      results.style.display = 'none';
      errorEl.style.display = 'none';

      // Animate fake progress
      let _prog = 0;
      const _interval = setInterval(() => {
        const inc = _prog < 50 ? 2.5 : _prog < 75 ? 1.2 : _prog < 88 ? 0.4 : 0;
        _prog = Math.min(90, _prog + inc);
        if (progressBar) progressBar.style.width = _prog + '%';
      }, 500);

      try {
        // Step 1: look up conversation by current URL
        // Grok uses ?conversation=ID — preserve that param, strip others
        let cleanUrl;
        if (location.href.includes('x.com/i/grok')) {
          // Old Grok URL format
          const u = new URL(location.href);
          const convParam = u.searchParams.get('conversation');
          cleanUrl = convParam
            ? `https://x.com/i/grok?conversation=${convParam}`
            : location.href.split('?')[0];
        } else if (location.href.includes('grok.com')) {
          // New Grok URL format — extract chat UUID from ?chat= param
          const u = new URL(location.href);
          const chatParam = u.searchParams.get('chat');
          // Pass the UUID directly — backend fallback will match it via ilike
          cleanUrl = chatParam
            ? `https://x.com/i/grok?conversation=${chatParam}`
            : location.href.split('?')[0];
        } else {
          cleanUrl = location.href.split('?')[0].split('#')[0];
        }
        const lookupResp = await authFetch(
          `${API_BASE}/api/agent/conversation-by-url?url=${encodeURIComponent(cleanUrl)}`
        );

        if (!lookupResp.ok) {
          throw new Error('This conversation has not been captured in ContextBridge yet.');
        }

        const lookupData = await lookupResp.json();
        console.log('[CB Summarize] Found conversation:', lookupData.conversation);
        const conversationId = lookupData.conversation?.id;
        if (!conversationId) throw new Error('Could not find conversation ID.');

        // Step 2: generate summary
        const sumResp = await authFetch(`${API_BASE}/api/agent/summarize-conversation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId, nextTitle: nextTitle || undefined })
        });

        const sumData = await sumResp.json();
        clearInterval(_interval);
        if (progressBar) progressBar.style.width = '100%';

        if (!sumResp.ok || !sumData.ok) {
          throw new Error(sumData.error || 'Failed to generate summary.');
        }

        setTimeout(() => { generating.style.display = 'none'; }, 400);

        panel.querySelector('#cb-sum-summary').textContent = sumData.summary || '—';
        panel.querySelector('#cb-sum-decisions').textContent = sumData.keyDecisions || '—';
        panel.querySelector('#cb-sum-open').textContent = sumData.openItems || '—';
        panel.querySelector('#cb-sum-primer').textContent = sumData.primer || '—';
        results.style.display = 'block';

        // Update footer with Copy + Inject buttons
        panel.querySelector('#cb-summarize-footer').innerHTML = `
          <button id="cb-sum-close-final" style="padding:8px 16px; border-radius:6px; border:1px solid #3F3F46; background:#27272A; color:#A1A1AA; cursor:pointer; font-size:13px; transition:all 0.2s;">Close</button>
          <button id="cb-sum-copy" style="flex:1; padding:8px 16px; border-radius:6px; border:1px solid #8b5cf6; background:#8b5cf6; color:white; font-weight:600; cursor:pointer; font-size:13px;">Copy All</button>
          <button id="cb-sum-inject" style="flex:1; padding:8px 16px; border-radius:6px; border:1px solid #22c55e; background:#22c55e; color:white; font-weight:600; cursor:pointer; font-size:13px;">Inject into Chat</button>
        `;
        panel.querySelector('#cb-sum-close-final').addEventListener('click', cbCloseSummarizePopup);
        panel.querySelector('#cb-sum-copy').addEventListener('click', () => {
          const text = [
            '## Summary\n' + panel.querySelector('#cb-sum-summary').textContent,
            '## Key Decisions\n' + panel.querySelector('#cb-sum-decisions').textContent,
            '## Open Items\n' + panel.querySelector('#cb-sum-open').textContent,
            '## Primer for Next Conversation\n' + panel.querySelector('#cb-sum-primer').textContent,
          ].join('\n\n');
          navigator.clipboard.writeText(text).then(() => alert('Copied to clipboard!'));
        });
        panel.querySelector('#cb-sum-inject').addEventListener('click', () => {
          const primer = panel.querySelector('#cb-sum-primer').textContent;
          if (!primer || primer === '—') return;
          const composer = findComposer();
          if (composer) {
            composer.focus();
            document.execCommand('insertText', false, primer);
            cbCloseSummarizePopup();
          } else {
            alert('Could not find the chat input. Copy manually instead.');
          }
        });

      } catch (err) {
        clearInterval(_interval);
        generating.style.display = 'none';
        errorEl.textContent = 'Error: ' + err.message;
        errorEl.style.display = 'block';
        step1.style.display = 'block';
      }
    });
    // ── End summarize logic ──

    const searchBtn = panel.querySelector('#cb-search');
    const closeBtn  = panel.querySelector('#cb-close');

    // Ghost hover helper — reliable in content scripts, avoids CSP issues with inline handlers
    function ghostHover(btn, defaultBg) {
      if (!btn) return;
      btn.addEventListener('mouseenter', () => {
        btn.style.borderColor = '#8B5CF6';
        btn.style.color       = '#8B5CF6';
        btn.style.background  = 'rgba(139,92,246,0.08)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.borderColor = '#3F3F46';
        btn.style.color       = '#A1A1AA';
        btn.style.background  = defaultBg;
      });
    }

    // Apply ghost hover to all panel buttons
    ghostHover(closeBtn,                                    '#1C1C1E');
    ghostHover(searchBtn,                                   '#1C1C1E');
    ghostHover(panel.querySelector('#cb-summarize'),        '#1C1C1E');
    ghostHover(panel.querySelector('#cb-copy-answer'),      '#27272A');
    ghostHover(panel.querySelector('#cb-insert-answer'),    '#27272A');
    ghostHover(panel.querySelector('#cb-copy-sources'),     '#27272A');
    ghostHover(panel.querySelector('#cb-insert-sources'),   '#27272A');
    ghostHover(panel.querySelector('#cb-copy-codex'),       '#27272A');
    ghostHover(panel.querySelector('#cb-insert-codex'),     '#27272A');
    ghostHover(panel.querySelector('#cb-copy-picks'),       '#27272A');
    ghostHover(panel.querySelector('#cb-insert-picks'),     '#27272A');
    ghostHover(panel.querySelector('#cb-retry'),            '#141415');
    ghostHover(panel.querySelector('#cb-summarize-close'),  '#27272A');
    ghostHover(panel.querySelector('#cb-summarize-close2'), '#27272A');

    closeBtn.addEventListener('click', () => panel.remove());
    searchBtn.addEventListener('click', () => doAgentSearch(panel));
    queryInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doAgentSearch(panel);
    });

    const copyAnswerBtn   = panel.querySelector('#cb-copy-answer');
    const insertAnswerBtn = panel.querySelector('#cb-insert-answer');
    const copySourcesBtn  = panel.querySelector('#cb-copy-sources');
    const insertSourcesBtn= panel.querySelector('#cb-insert-sources');

    // Codex section buttons
    const copyCodexBtn = panel.querySelector('#cb-copy-codex');
    const insertCodexBtn = panel.querySelector('#cb-insert-codex');

    if (copyCodexBtn) {
      copyCodexBtn.addEventListener('click', () => {
        const codexList = panel.querySelector('#cb-codex-list');
        if (!codexList) return;
        
        // Gather all code snippets from Codex section
        const snippets = [];
        codexList.querySelectorAll('pre').forEach(pre => {
          snippets.push(pre.textContent || '');
        });
        
        if (snippets.length === 0) {
          toast('⚠️ No Codex content to copy');
          return;
        }
        
        const text = snippets.join('\n\n---\n\n');
        navigator.clipboard.writeText(text);
        toast('✅ Codex content copied!');
      });
    }

    if (insertCodexBtn) {
      insertCodexBtn.addEventListener('click', () => {
        const codexList = panel.querySelector('#cb-codex-list');
        if (!codexList) return;
        
        const snippets = [];
        codexList.querySelectorAll('pre').forEach(pre => {
          snippets.push(pre.textContent || '');
        });
        
        if (snippets.length === 0) {
          toast('⚠️ No Codex content to insert');
          return;
        }
        
        const text = snippets.join('\n\n---\n\n');
        const composer = findComposer();
        if (!composer) {
          toast('❌ Click in the chat box first');
          return;
        }
        insertText(composer, text);
        toast('✅ Codex content inserted!');
      });
    }

    // Top Picks section buttons
    const copyPicksBtn = panel.querySelector('#cb-copy-picks');
    const insertPicksBtn = panel.querySelector('#cb-insert-picks');

    if (copyPicksBtn) {
      copyPicksBtn.addEventListener('click', () => {
        const picksList = panel.querySelector('#cb-top-picks-list');
        if (!picksList) return;
        
        // Gather titles and previews from Top Picks cards
        const picks = [];
        picksList.querySelectorAll('.cb-top-pick-card').forEach(card => {
          const title = card.querySelector('div[style*="font-weight:600"]')?.textContent?.trim() || '';
          const preview = card.querySelector('div[style*="color:#A1A1AA"]')?.textContent?.trim() || '';
          if (title) {
            picks.push(`**${title}**\n${preview}`);
          }
        });
        
        if (picks.length === 0) {
          toast('⚠️ No Top Picks to copy');
          return;
        }
        
        const text = picks.join('\n\n');
        navigator.clipboard.writeText(text);
        toast('✅ Top Picks copied!');
      });
    }

    if (insertPicksBtn) {
      insertPicksBtn.addEventListener('click', () => {
        const picksList = panel.querySelector('#cb-top-picks-list');
        if (!picksList) return;
        
        const picks = [];
        picksList.querySelectorAll('.cb-top-pick-card').forEach(card => {
          const title = card.querySelector('div[style*="font-weight:600"]')?.textContent?.trim() || '';
          const preview = card.querySelector('div[style*="color:#A1A1AA"]')?.textContent?.trim() || '';
          if (title) {
            picks.push(`**${title}**\n${preview}`);
          }
        });
        
        if (picks.length === 0) {
          toast('⚠️ No Top Picks to insert');
          return;
        }
        
        const text = picks.join('\n\n');
        const composer = findComposer();
        if (!composer) {
          toast('❌ Click in the chat box first');
          return;
        }
        insertText(composer, text);
        toast('✅ Top Picks inserted!');
      });
    }

    if (copyAnswerBtn)   copyAnswerBtn.addEventListener('click', () => {
      const txt = panel.querySelector('#cb-answer')?.textContent || '';
      navigator.clipboard.writeText(txt);
      toast('✅ Answer copied!');
    });
    if (copySourcesBtn)  copySourcesBtn.addEventListener('click', () => {
      const txt = panel.querySelector('#cb-paste')?.textContent || '';
      navigator.clipboard.writeText(txt);
      toast('✅ Sources copied!');
    });
    if (insertAnswerBtn) insertAnswerBtn.addEventListener('click', () => {
      const txt = panel.querySelector('#cb-answer')?.textContent || '';
      const composer = findComposer();
      if (!composer) return showError(panel, 'Click in the chat box first.');
      insertText(composer, txt);
      toast('✅ Answer inserted!');
    });
    if (insertSourcesBtn) insertSourcesBtn.addEventListener('click', () => {
      const txt = panel.querySelector('#cb-paste')?.textContent || '';
      const composer = findComposer();
      if (!composer) return showError(panel, 'Click in the chat box first.');
      insertText(composer, txt);
      toast('✅ Sources inserted!');
    });

    const selectProjectsBtn = panel.querySelector('#cb-select-projects');
    if (selectProjectsBtn) {
      selectProjectsBtn.addEventListener('click', (e) => {
        e.stopPropagation(); 
        toggleProjectDropdown();
      });
    }

    // Compact Format toggle
    const compactCheckbox = panel.querySelector('#cb-use-context-pack');
    if (compactCheckbox) {
      // Set initial state from variable
      compactCheckbox.checked = USE_CONTEXT_PACK;
      
      compactCheckbox.addEventListener('change', (e) => {
        USE_CONTEXT_PACK = e.target.checked;
        // Persist to storage
        chrome.storage.local.set({ 'cb_use_context_pack': USE_CONTEXT_PACK });
        console.log('[CB] Compact Format changed to:', USE_CONTEXT_PACK);
      });
    }

    // Load selected projects (Async), then check if empty
    loadSelectedProjects().then(ids => {
        if (ids.length === 0) {
            // No projects selected? Fetch list and auto-select the first one.
            fetchProjects().then(projects => {
                if (projects && projects.length > 0) {
                    selectedProjectIds = [projects[0].id];
                    saveSelectedProjects(); // Saves to storage
                }
                updateProjectCount();
            });
        } else {
            updateProjectCount();
        }
    });
    
    console.log('[CB] Event listeners attached to search UI');
  }

  async function doAgentSearch(panel) {
    console.log('[CB] doAgentSearch called!');
    console.log('[CB] USE_CONTEXT_PACK:', USE_CONTEXT_PACK);
    const queryInput = panel.querySelector('#cb-query');
    const query = queryInput.value.trim();

    if (!query) {
        showError(panel, 'Please enter a search query');
        return;
    }
    
    // 1. Get State
    const activeProjectIds = selectedProjectIds || []; 
    
    // Ensure includeCodex is boolean
    if (typeof includeCodex === 'undefined') {
        const stored = localStorage.getItem('cb_include_codex');
        includeCodex = (stored !== 'true');
    }
    
    console.log('[CB] State:', { projectIds: activeProjectIds, includeCodex });
    
    // 2. Validation
    if (activeProjectIds.length === 0 && !includeCodex) {
        showError(panel, 'Please select at least one source (Project or Codex).');
        return;
    }

    try {
      showLoading(panel, true);

      // === PARALLEL API CALLS ===
      const contextPackPayload = { 
        instruction: query, 
        projectIds: activeProjectIds, 
        projectId: activeProjectIds[0],
        tokenBudget: 12000,
        includeCodex: includeCodex 
      };

      console.log('[CB] Sending parallel requests...');

      console.log('[CB] Source selection:', {
        activeProjectIds,
        includeCodex,
        selectedProjectIds,
        firstProjectId: activeProjectIds[0]
      });

      // Determine which context endpoint to use
      const contextEndpoint = USE_CONTEXT_PACK 
        ? `${API_BASE}/api/agent/context-pack`
        : `${API_BASE}/api/agent/context-pack-friendly`;

      // Determine project ID for tiered search
      // Use first selected project, or if only Codex, use first Codex project
      let tieredProjectId = activeProjectIds[0];
      
      // If no regular project but Codex is enabled, we still need a project ID for code search
      if (!tieredProjectId && includeCodex) {
        // Get Codex project IDs from localStorage or use default
        const codexProjectIds = JSON.parse(localStorage.getItem('cb_codex_project_ids') || '[]');
        tieredProjectId = codexProjectIds[0];
        console.log('[CB] Using Codex project ID for tiered search:', tieredProjectId);
      }

      const tieredPayload = {
        query: query,
        projectId: tieredProjectId,
        projectIds: activeProjectIds,
        includeCodex: includeCodex
      };
    
      console.log('[CB] Tiered payload:', tieredPayload);

      // Call both endpoints in parallel
      const [contextResp, tieredResp] = await Promise.all([
        authFetch(contextEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(contextPackPayload)
        }),
        // Only call tiered if we have a project ID
        tieredProjectId 
          ? authFetch(`${API_BASE}/api/agent/search-tiered`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(tieredPayload)
            })
          : Promise.resolve(null)
      ]);

      // Process context-pack response
      if (!contextResp.ok) {
        const errText = await contextResp.text();
        throw new Error(`HTTP ${contextResp.status}: ${errText}`);
      }
      
      const contextData = await contextResp.json();
      const packData = USE_CONTEXT_PACK ? contextData.pack : contextData.result;

      // Process tiered response (may be null if no project ID)
      let tieredData = null;
      if (tieredResp && tieredResp.ok) {
        tieredData = await tieredResp.json();
        console.log('[CB] Tiered search results:', {
          intent: tieredData.intent,
          artifacts: tieredData.artifacts?.files?.length || 0,
          memory: tieredData.memory?.messages?.length || 0,
          timeMs: tieredData.meta?.searchTimeMs
        });
      } else if (tieredResp) {
        console.warn('[CB] Tiered search failed:', tieredResp.status);
      }

      // If tiered search failed but we have Codex data, retry with extracted project ID
      const subquestions = packData?.subquestions || packData?.pack?.subquestions;
      if (!tieredData && includeCodex && subquestions?.[0]?.code?.[0]?.project_id) {
        const codexProjectId = subquestions[0].code[0].project_id;
        console.log('[CB] Retrying tiered search with Codex project ID:', codexProjectId);
        
        try {
          const retryResp = await authFetch(`${API_BASE}/api/agent/search-tiered`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: query,
              projectId: codexProjectId,
              includeCodex: true
            })
          });
          
          if (retryResp.ok) {
            tieredData = await retryResp.json();
            console.log('[CB] Tiered search retry succeeded:', {
              intent: tieredData.intent,
              artifacts: tieredData.artifacts?.files?.length || 0,
              memory: tieredData.memory?.messages?.length || 0
            });
          } else {
            console.warn('[CB] Tiered search retry failed:', retryResp.status);
          }
        } catch (err) {
          console.warn('[CB] Tiered search retry error:', err);
        }
      }

      // Store both results
      currentResult = packData;
      currentResult._tiered = tieredData;  // Attach tiered results
      currentResult._query = query;        // Store query for highlighting
      
      if (USE_CONTEXT_PACK) {
        showPack(panel, packData, tieredData, query);
      } else {
        showResult(panel, packData, tieredData, query);
      }

    } catch (err) {
      console.error('[CB] Agent search failed:', err);
      showError(panel, err.message || 'Search failed. Please try again.');
    } finally {
      showLoading(panel, false);
    }
  }

  function showLoading(panel, show) {
    const loading = panel.querySelector('#cb-loading');
    const result = panel.querySelector('#cb-result');
    
    console.log('[CB] showLoading called:', { show, hasLoading: !!loading, hasResult: !!result });
    
    if (!loading || !result) {
        console.error('[CB] Missing loading or result elements');
        return;
    }
    
    if (show) {
        loading.style.display = 'block';
        result.style.display = 'none';
    } else {
        loading.style.display = 'none';
        // Don't hide result here - showResult() will show it
    }
    }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // === TIERED SEARCH RESULTS RENDERER ===

  /**
   * Highlights query keywords in text with yellow background
   */
  function highlightKeywords(text, query) {
    if (!text || !query) return escapeHtml(text);
    
    // Extract meaningful keywords (skip common words)
    const stopWords = new Set(['the', 'is', 'are', 'where', 'what', 'how', 'in', 'at', 'to', 'for', 'of', 'a', 'an', 'and', 'or', 'it', 'this', 'that']);
    const keywords = query.toLowerCase()
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
    
    if (keywords.length === 0) return escapeHtml(text);
    
    // Escape HTML first, then highlight
    let result = escapeHtml(text);
    
    keywords.forEach(keyword => {
      const regex = new RegExp(`(${keyword})`, 'gi');
      result = result.replace(regex, `<mark style="background:${TIERED_CONFIG.highlightColor}; padding:1px 2px; border-radius:2px;">$1</mark>`);
    });
    
    return result;
  }

  /**
   * Renders tiered search results as clickable cards
   * @param {Object} tieredResponse - Response from /api/agent/search-tiered
   * @param {string} query - Original search query (for highlighting)
   * @returns {string} HTML string
   */
  function renderTieredResults(tieredResponse, query, pack) {
    if (!tieredResponse) return '<div style="color:#71717A; padding:8px;">No search results</div>';
    
    const { intent, artifacts, memory, meta } = tieredResponse;
    const artifactFiles = artifacts?.files || [];
    const memoryMessages = memory?.messages || [];

    if (memoryMessages.length > 0) {
      console.log('[CB DEBUG] First memory message:', JSON.stringify(memoryMessages[0], null, 2));
    }
    
    // Check if user has conversation projects selected (not just Codex)
    const hasConversationProjects = (selectedProjectIds?.length > 0);
    
    const showArtifactsFirst = intent === 'code_seeking' || intent === 'general';
    
    const intentLabels = {
      'code_seeking': '🔧 Code Search',
      'memory_seeking': '💭 Memory Search', 
      'general': '🔍 General Search'
    };
    
    // Adjust message count display based on what we'll actually show
    const displayMsgCount = hasConversationProjects ? memoryMessages.length : 0;
    
    let html = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding:4px 0;">
        <span style="font-size:10px; color:#71717A; background:#141415; padding:2px 6px; border-radius:3px;">
          ${intentLabels[intent] || intent}
        </span>
        <span style="font-size:10px; color:#71717A;">
          ${meta?.searchTimeMs || 0}ms · ${artifactFiles.length} files · ${displayMsgCount} msgs
        </span>
      </div>
    `;
    
    if (showArtifactsFirst) {
      html += renderArtifactsSection(artifactFiles, query, pack);
      // Only show memory section if user has conversation projects selected
      if (hasConversationProjects) {
        html += renderMemorySection(memoryMessages, query, memory?.bestMessage);
      }
    } else {
      // Only show memory section if user has conversation projects selected
      if (hasConversationProjects) {
        html += renderMemorySection(memoryMessages, query, memory?.bestMessage);
      }
      html += renderArtifactsSection(artifactFiles, query, pack);
    }
    
    return html;
  }

  /**
   * Renders artifacts (files) section
   */
  function renderArtifactsSection(files, query, pack) {
    const initialCount = TIERED_CONFIG.maxArtifacts;
    
    if (files.length === 0) {
      return `
        <div style="margin-bottom:8px;">
          <div style="font-size:10px; color:#71717A; text-transform:uppercase; letter-spacing:0.3px; margin-bottom:4px; font-weight:600;">
            💻 Code Files
          </div>
          <div style="color:#71717A; font-size:11px; padding:6px 8px; background:#141415; border-radius:4px;">
            No matching code files
          </div>
        </div>
      `;
    }
    
    // Build snippet map from pack data
    const snippetMap = new Map();
    if (pack) {
      for (const sq of (pack.subquestions || [])) {
        for (const c of sq.code || []) {
          const path = c.path || '';
          if (!path || path.startsWith('msg_')) continue;
          let cleanSnippet = c.snippet || '';
          cleanSnippet = cleanSnippet.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
          if (!snippetMap.has(path)) {
            snippetMap.set(path, {
              snippet: cleanSnippet,
              startLine: c.startLine,
              endLine: c.endLine
            });
          }
        }
      }
    }
    
    console.log('[CB DEBUG] renderArtifactsSection snippetMap:', snippetMap.size, 'entries, pack has subquestions:', !!pack?.subquestions);
    
    const renderCards = (filesToRender) => filesToRender.map((file, index) => {
      const filename = file.filename || file.path?.split('/').pop() || 'Unknown';
      const path = file.path || '';
      const similarity = file.similarity ? Math.round(file.similarity * 100) : 0;
      const snippetData = snippetMap.get(path);
      const hasSnippet = snippetData?.snippet && snippetData.snippet.length > 10;
      const lineInfo = (snippetData?.startLine && snippetData?.endLine) 
        ? `L${snippetData.startLine}-${snippetData.endLine}` 
        : (file.startLine && file.endLine) ? `L${file.startLine}-${file.endLine}` : '';
      
      const snippetPreview = hasSnippet
        ? (snippetData.snippet.length > 500 ? snippetData.snippet.slice(0, 500) + '\n// ... (truncated)' : snippetData.snippet)
        : '';
      
      return `
        <div class="cb-tiered-artifact-card" 
            data-index="${index}" data-path="${escapeHtml(path)}"
            data-start-line="${file.startLine || ''}" data-end-line="${file.endLine || ''}"
            style="background:#0A0A0B; border:1px solid #27272A; border-radius:4px; margin-bottom:4px; transition: all 0.15s; overflow:hidden;">
          <div class="cb-artifact-header" style="display:flex; justify-content:space-between; align-items:center; gap:6px; padding:6px 8px; cursor:pointer;">
            <div style="flex:1; min-width:0; display:flex; align-items:center; gap:4px; overflow:hidden;">
              <span class="cb-expand-icon" style="font-size:9px; color:#8B5CF6; flex-shrink:0; transition:transform 0.15s; ${hasSnippet ? '' : 'visibility:hidden;'}">${hasSnippet ? '▶' : ''}</span>
              <span style="font-size:11px; flex-shrink:0;">📄</span>
              <span style="font-weight:600; color:#FAFAFA; font-size:12px; white-space:nowrap;">${escapeHtml(filename)}</span>
              <span style="font-size:10px; color:#71717A; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(path)}</span>
            </div>
            <div style="display:flex; align-items:center; gap:4px; flex-shrink:0;">
              ${lineInfo ? `<span style="font-size:9px; color:#A1A1AA; background:#141415; padding:1px 3px; border-radius:2px;">${lineInfo}</span>` : ''}
              <button class="cb-copy-source-btn" data-path="${escapeHtml(path)}"
                      style="font-size:9px; color:#8B5CF6; background:transparent; border:1px solid #8B5CF6; border-radius:3px; padding:2px 6px; cursor:pointer; white-space:nowrap;">
                📋 Copy
              </button>
              <span style="font-size:11px; color:#22c55e; font-weight:600; min-width:28px; text-align:right;">${similarity}%</span>
            </div>
          </div>
          ${hasSnippet ? `
            <div class="cb-snippet-container" style="display:none; border-top:1px solid #27272A;">
              <pre style="margin:0; padding:8px 10px; font-family:'Fira Code','Consolas',monospace; font-size:11px; color:#A1A1AA; overflow-x:auto; max-height:200px; overflow-y:auto; line-height:1.4; white-space:pre-wrap;">${escapeHtml(snippetPreview)}</pre>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
    
    const maxTotal = TIERED_CONFIG.maxArtifactsTotal || 10;
    const cappedFiles = files.slice(0, maxTotal);
    const initialCards = renderCards(cappedFiles.slice(0, initialCount));
    const extraCards = cappedFiles.length > initialCount ? renderCards(cappedFiles.slice(initialCount)) : '';
    const hasMore = cappedFiles.length > initialCount;
    
    return `
      <div style="margin-bottom:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <div style="font-size:10px; color:#71717A; text-transform:uppercase; letter-spacing:0.3px; font-weight:600;">
            💻 Code Files <span style="font-weight:400; text-transform:none;">(${Math.min(initialCount, cappedFiles.length)} of ${cappedFiles.length})</span>
          </div>
          ${hasMore ? `
            <button class="cb-show-more-artifacts" style="font-size:10px; color:#8B5CF6; background:none; border:none; cursor:pointer; padding:2px 6px;">
              Show ${cappedFiles.length - initialCount} more ▼
            </button>
          ` : ''}
        </div>
        <div class="cb-artifacts-initial">${initialCards}</div>
        ${hasMore ? `<div class="cb-artifacts-extra" style="display:none;">${extraCards}</div>` : ''}
      </div>
    `;
  }

  /**
   * Renders memory (messages) section
   */
  function renderMemorySection(messages, query, bestMessage) {
    const initialCount = TIERED_CONFIG.maxMemory;
    const maxTotal = TIERED_CONFIG.maxMemoryTotal || 10;
    const cappedMessages = messages.slice(0, maxTotal);
    
    if (cappedMessages.length === 0) {
      return `
        <div style="margin-bottom:8px;">
          <div style="font-size:10px; color:#71717A; text-transform:uppercase; letter-spacing:0.3px; margin-bottom:4px; font-weight:600;">
            💬 Conversations
          </div>
          <div style="color:#71717A; font-size:11px; padding:6px 8px; background:#141415; border-radius:4px;">
            No matching conversations
          </div>
        </div>
      `;
    }
    
    const renderCards = (messagesToRender) => messagesToRender.map((msg, index) => {
      const similarity = msg.similarity ? Math.round(msg.similarity * 100) : 0;
      const fullPreview = msg.preview || '';
      
      const firstSentence = fullPreview.split(/[.!?\n]/)[0]?.trim() || '';
      const title = msg.title || (firstSentence.length > 60 ? firstSentence.slice(0, 57) + '...' : firstSentence) || `Conversation ${msg.conversationId?.slice(0, 8) || ''}`;
      
      const previewText = fullPreview.length > title.length + 5 
        ? highlightKeywords(fullPreview.slice(title.length).trim().substring(0, 100), query)
        : highlightKeywords(fullPreview.substring(0, 100), query);
      
      const isBest = bestMessage && msg.id === bestMessage.id;
      
      return `
        <div class="cb-tiered-memory-card" 
            data-index="${index}" data-conversation-id="${msg.conversationId || ''}" data-message-id="${msg.id || ''}" data-provider="${msg.provider || ''}" data-url="${msg.url || ''}"
            style="background:#0A0A0B; border:1px solid ${isBest ? '#8B5CF6' : '#27272A'}; border-radius:4px; padding:6px 8px; margin-bottom:4px; cursor:pointer; transition: all 0.15s; position:relative;">
          ${isBest ? `<span style="position:absolute; top:-5px; right:6px; font-size:8px; background:#8B5CF6; color:white; padding:1px 4px; border-radius:2px;">⭐ Best</span>` : ''}
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:6px;">
            <div style="flex:1; min-width:0;">
              <div style="font-weight:600; color:#FAFAFA; font-size:12px; display:flex; align-items:center; gap:3px; margin-bottom:2px;">
                <span style="font-size:11px;">💬</span>
                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(fullPreview.substring(0, 200))}">${escapeHtml(title)}</span>
                <span style="font-size:9px; color:#8B5CF6;">🔗</span>
              </div>
              <div style="font-size:10px; color:#A1A1AA; line-height:1.3; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">
                ${previewText}
              </div>
            </div>
            <span style="font-size:11px; color:#22c55e; font-weight:600; flex-shrink:0;">${similarity}%</span>
          </div>
        </div>
      `;
    }).join('');
    
    const initialCards = renderCards(cappedMessages.slice(0, initialCount));
    const extraCards = cappedMessages.length > initialCount ? renderCards(cappedMessages.slice(initialCount)) : '';
    const hasMore = cappedMessages.length > initialCount;
    
    return `
      <div style="margin-bottom:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <div style="font-size:10px; color:#71717A; text-transform:uppercase; letter-spacing:0.3px; font-weight:600;">
            💬 Conversations <span style="font-weight:400; text-transform:none;">(${Math.min(initialCount, cappedMessages.length)} of ${cappedMessages.length})</span>
          </div>
          ${hasMore ? `
            <button class="cb-show-more-memory" style="font-size:10px; color:#8B5CF6; background:none; border:none; cursor:pointer; padding:2px 6px;">
              Show ${cappedMessages.length - initialCount} more ▼
            </button>
          ` : ''}
        </div>
        <div class="cb-memory-initial">${initialCards}</div>
        ${hasMore ? `<div class="cb-memory-extra" style="display:none;">${extraCards}</div>` : ''}
      </div>
    `;
  }

  /**
 * Formats tiered results as clean text for copying/inserting
 */
function formatTieredResultsAsText(panel) {
  const lines = [];
  
  // Get intent label
  const intentBadge = panel.querySelector('#cb-tiered-results span[style*="background:#141415"]');
  if (intentBadge) {
    lines.push(intentBadge.textContent.trim());
    lines.push('');
  }
  
  // Code Files section (tiered format)
  const artifactCards = panel.querySelectorAll('.cb-tiered-artifact-card');
  if (artifactCards.length > 0) {
    lines.push('CODE FILES:');
    artifactCards.forEach(card => {
      const filename = card.querySelector('span[style*="font-weight:600"]')?.textContent?.trim() || '';
      const path = card.dataset.path || '';
      const similarity = card.querySelector('span[style*="color:#22c55e"]')?.textContent?.trim() || '';
      lines.push(`  • ${filename} ${similarity} - ${path}`);
    });
    lines.push('');
  }
  
  // Source cards (compact format) - include if tiered cards are empty
  const sourceCards = panel.querySelectorAll('.cb-source-card');
  if (artifactCards.length === 0 && sourceCards.length > 0) {
    lines.push('SOURCE FILES:');
    sourceCards.forEach(card => {
      const filename = card.querySelector('span[style*="font-weight:600"]')?.textContent?.trim() || 'Unknown';
      const path = card.querySelector('span[style*="color:#71717A"]')?.textContent?.trim() || '';
      const similarity = card.querySelector('span[style*="color:#22c55e"]')?.textContent?.trim() || '';
      lines.push(`  • ${filename} ${similarity} - ${path}`);
    });
    lines.push('');
  }
  
  // Conversations section
  const memoryCards = panel.querySelectorAll('.cb-tiered-memory-card');
  if (memoryCards.length > 0) {
    lines.push('CONVERSATIONS:');
    memoryCards.forEach(card => {
      const title = card.querySelector('span[style*="overflow:hidden"]')?.textContent?.trim() || '';
      const preview = card.querySelector('div[style*="font-size:10px"]')?.textContent?.trim() || '';
      const similarity = card.querySelector('span[style*="color:#22c55e"]')?.textContent?.trim() || '';
      lines.push(`  • ${title} ${similarity}`);
      if (preview) lines.push(`    ${preview}`);
    });
    lines.push('');
  }
  
  return lines.join('\n').trim();
}

  /**
   * Attaches click handlers to tiered result cards
   * Call this after inserting the HTML into the DOM
   */
  function attachTieredCardHandlers(container) {
    if (!container) return;
    
    // Artifact cards - use event delegation (single handler, no duplicates)
    if (!container.dataset.artifactDelegated) {
      container.dataset.artifactDelegated = 'true';
      container.addEventListener('click', (e) => {
        const card = e.target.closest('.cb-tiered-artifact-card');
        if (!card || e.target.closest('.cb-copy-source-btn')) return; // Skip if copy button clicked
        e.stopPropagation();
        const path = card.dataset.path;
        const startLine = card.dataset.startLine;
        const endLine = card.dataset.endLine;
        const copyText = startLine && endLine ? `${path}:${startLine}-${endLine}` : path;
        navigator.clipboard.writeText(copyText);
        toast(`✅ Copied: ${copyText}`);
      });
    }

    // Artifact expand/collapse for inline code snippets
    if (!container.dataset.expandDelegated) {
      container.dataset.expandDelegated = 'true';
      container.addEventListener('click', (e) => {
        const header = e.target.closest('.cb-artifact-header');
        if (!header) return;
        // Don't toggle if clicking the copy button
        if (e.target.closest('.cb-copy-source-btn')) return;
        
        const card = header.closest('.cb-tiered-artifact-card');
        if (!card) return;
        
        const snippet = card.querySelector('.cb-snippet-container');
        const icon = card.querySelector('.cb-expand-icon');
        if (!snippet) return; // No snippet available
        
        const isExpanded = snippet.style.display !== 'none';
        snippet.style.display = isExpanded ? 'none' : 'block';
        if (icon) icon.textContent = isExpanded ? '▶' : '▼';
      });
    }
    
    // Memory cards - use event delegation (single handler, no duplicates)
    if (!container.dataset.memoryDelegated) {
      container.dataset.memoryDelegated = 'true';
      container.addEventListener('click', (e) => {
        const card = e.target.closest('.cb-tiered-memory-card');
        if (!card) return;
        e.stopPropagation();
        const conversationId = card.dataset.conversationId;
        const provider = card.dataset.provider;
        const messageId = card.dataset.messageId;
        if (conversationId) {
          let url = card.dataset.url || buildConversationUrl(conversationId, provider || PLATFORM || 'claude');
          // Normalize Claude project URLs to direct chat URLs
          if (url && url.includes('claude.ai/project/')) {
            url = url.replace(/\/project\/[^/]+\/chat\//, '/chat/');
          }
          if (url) {
            // Store scroll target so the content script on the new page can find and scroll to it
            // Use the full preview from the data, not just the visible truncated text
            const fullPreview = card.querySelector('[title]')?.getAttribute('title') || '';
            const previewEl = card.querySelector('div[style*="line-clamp"]');
            const visibleText = previewEl?.textContent?.trim() || '';
            // Prefer the title attribute (has up to 200 chars) over visible text
            const rawText = fullPreview || visibleText;
            // Skip first 20 chars (often generic) and take a longer middle chunk
            const searchText = rawText.length > 40 
              ? rawText.substring(20, 150).trim()
              : rawText.substring(0, 80).trim();
            if (searchText) {
              chrome.storage.local.set({
                cb_scroll_target: {
                  conversationId,
                  messageId: messageId || '',
                  searchText,
                  timestamp: Date.now(),
                }
              });
            }
            window.open(url, '_blank');
          }
        }
      });
    }

    // "Show more" toggle for artifacts
    const showMoreBtn = container.querySelector('.cb-show-more-artifacts');
    const extraCards = container.querySelector('.cb-artifacts-extra');
    
    if (showMoreBtn && extraCards) {
      showMoreBtn.addEventListener('click', () => {
        const isExpanded = extraCards.style.display !== 'none';
        extraCards.style.display = isExpanded ? 'none' : 'block';
        showMoreBtn.innerHTML = isExpanded 
          ? `Show ${extraCards.children.length} more ▼`
          : 'Show less ▲';
      });
    }

    // "Show more" toggle for memory/conversations
    const showMoreMemoryBtn = container.querySelector('.cb-show-more-memory');
    const extraMemoryCards = container.querySelector('.cb-memory-extra');
    
    if (showMoreMemoryBtn && extraMemoryCards) {
      showMoreMemoryBtn.addEventListener('click', () => {
        const isExpanded = extraMemoryCards.style.display !== 'none';
        extraMemoryCards.style.display = isExpanded ? 'none' : 'block';
        showMoreMemoryBtn.innerHTML = isExpanded 
          ? `Show ${extraMemoryCards.children.length} more ▼`
          : 'Show less ▲';
      });
    }
  }

  // Build conversation URL based on provider
  function buildConversationUrl(conversationId, provider) {
    if (!conversationId) return null;
    if (!provider) return null; // No provider = can't build URL
    
    const providerLower = provider.toLowerCase();
    
    switch (providerLower) {
      case 'openai':
      case 'chatgpt':
        return `https://chatgpt.com/c/${conversationId}`;
      case 'gemini':
      case 'google':
        return `https://gemini.google.com/app/${conversationId}`;
      case 'grok':
      case 'x':
        return `https://x.com/i/grok?conversation=${conversationId}`;
      case 'claude':
      case 'anthropic':
      default:
        return `https://claude.ai/chat/${conversationId}`;
    }
  }

  function showPack(panel, pack, tieredData, query) {
    const resultDiv = panel.querySelector('#cb-result');
    const answerDiv = panel.querySelector('#cb-answer');
    const pasteDiv  = panel.querySelector('#cb-paste');
    const tokensDiv = panel.querySelector('#cb-tokens');

    console.log('[CB] Pack structure:', JSON.stringify(pack, null, 2).slice(0, 1500));
    console.log('[CB] Tiered data:', tieredData ? { 
      intent: tieredData.intent,
      artifacts: tieredData.artifacts?.files?.length,
      memory: tieredData.memory?.messages?.length 
    } : 'none');

    // === ANSWER SECTION: Render tiered search results ===
    if (tieredData) {
      const tieredHtml = renderTieredResults(tieredData, query, pack);
      answerDiv.innerHTML = tieredHtml;
      // Override parent container styles for compact tiered display
      answerDiv.style.padding = '8px';
      answerDiv.style.whiteSpace = 'normal';
      answerDiv.style.lineHeight = '1.4';
      // Attach click handlers after DOM update
      attachTieredCardHandlers(answerDiv);
    } else {
      // Fallback to old behavior if tiered search failed
      const sq0 = pack.subquestions?.[0];
      let direct = 'Context Pack ready.';
      let conversationUrl = null;
      
      if (sq0 && sq0.locations && sq0.locations.length) {
        const locPath = sq0.locations[0].path;
        
        if (locPath.startsWith('msg_')) {
          const codeBlock = (sq0.code || []).find(c => c.path === locPath);
          if (codeBlock && codeBlock.displayName) {
            direct = `Likely here: ${codeBlock.displayName}${codeBlock.contentSummary ? ': ' + codeBlock.contentSummary : ''}`;
            if (codeBlock.conversationId) {
              conversationUrl = buildConversationUrl(codeBlock.conversationId, codeBlock.provider);
            }
          } else {
            direct = `Likely here: ${locPath}`;
          }
        } else {
          direct = `Likely here: ${locPath}`;
        }
      }
      
      if (conversationUrl) {
        answerDiv.innerHTML = `<a href="${conversationUrl}" target="_blank" style="color: #60a5fa; text-decoration: underline; cursor: pointer;">${escapeHtml(direct)}</a>`;
      } else {
        answerDiv.textContent = direct;
      }
    }

    // Hide SOURCE FILES section (now merged inline into code file cards)
    const sourcesSection = panel.querySelector('#cb-sources-section');
    if (sourcesSection) sourcesSection.style.display = 'none';
    if (pasteDiv) pasteDiv.style.display = 'none';
    if (tokensDiv) tokensDiv.style.display = 'none';
    const copySourcesBtn = panel.querySelector('#cb-copy-sources');
    if (copySourcesBtn) copySourcesBtn.parentElement.style.display = 'none';

    // Remove border from retry button wrapper
    const retryWrapper = panel.querySelector('#cb-retry')?.parentElement;
    if (retryWrapper) retryWrapper.style.borderTop = 'none';

    // Rename buttons for compact format
    const copyAnswerBtn = panel.querySelector('#cb-copy-answer');
    const insertAnswerBtn = panel.querySelector('#cb-insert-answer');
    if (copyAnswerBtn) copyAnswerBtn.innerHTML = '📋 Copy Results';
    if (insertAnswerBtn) insertAnswerBtn.innerHTML = '✨ Insert Results';

    // NOTE: Removed renderCodexSection and renderTopPicks - replaced by tiered results

    resultDiv.style.display = 'block';
  }

  function showResult(panel, result, tieredData, query) {
    const resultDiv = panel.querySelector('#cb-result');
    const answerDiv = panel.querySelector('#cb-answer');
    const pasteDiv = panel.querySelector('#cb-paste');
    const tokensDiv = panel.querySelector('#cb-tokens');
    
    console.log('[CB] Result structure:', { 
      hasSynthesizedAnswer: !!result.synthesizedAnswer,
      selectedItems: result.selectedItems?.length,
      hasPasteBlock: !!result.pasteBlock
    });
    console.log('[CB] Tiered data:', tieredData ? { 
      intent: tieredData.intent,
      artifacts: tieredData.artifacts?.files?.length,
      memory: tieredData.memory?.messages?.length 
    } : 'none');

    // === ANSWER SECTION: Synthesized answer + Tiered results ===
    const answer = result.synthesizedAnswer 
      || (result.selectedItems?.length 
          ? `✅ Found ${result.selectedItems.length} matches.` 
          : '⚠️ No matches.');
    
    let answerHtml = `
      <div style="margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid #27272A;">
        <div style="font-size:12px; color:#8B5CF6; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; font-weight:600;">
          🤖 AI Summary
        </div>
        <div id="cb-ai-summary-text" style="color:#A1A1AA; line-height:1.7; white-space:pre-wrap; margin-bottom:10px;">
          ${escapeHtml(answer)}
        </div>
        <div style="display:flex; gap:8px;">
          <button id="cb-copy-ai-summary" style="flex:1; padding:8px; border-radius:6px; border:1px solid #3F3F46; 
                                                  background:#27272A; color:#FAFAFA; font-weight:500; cursor:pointer; font-size:12px;">
            📋 Copy Answer
          </button>
          <button id="cb-insert-ai-summary" style="flex:1; padding:8px; border-radius:6px; border:1px solid #22c55e; 
                                                    background:#22c55e; color:white; font-weight:600; cursor:pointer; font-size:12px;">
            ✨ Insert Answer
          </button>
        </div>
      </div>
    `;
    
    // Add tiered search results below the AI summary
    if (tieredData) {
      answerHtml += `
        <div id="cb-tiered-results">
          <div style="font-size:12px; color:#71717A; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; font-weight:600;">
            🔍 Search Results
          </div>
          ${renderTieredResults(tieredData, query, result.pack)}
        </div>
      `;
    }
    
    answerDiv.innerHTML = answerHtml;
  
    // Override parent container styles for compact display
    answerDiv.style.padding = '8px';
    answerDiv.style.whiteSpace = 'normal';
    answerDiv.style.lineHeight = '1.4';
    
    // Attach click handlers for tiered cards
    if (tieredData) {
      attachTieredCardHandlers(answerDiv);
    }

    // Hide SOURCE FILES section (now merged inline into code file cards)
    const sourcesSection = panel.querySelector('#cb-sources-section');
    if (sourcesSection) sourcesSection.style.display = 'none';
    if (pasteDiv) pasteDiv.style.display = 'none';
    const copySourcesBtn = panel.querySelector('#cb-copy-sources');
    if (copySourcesBtn) copySourcesBtn.parentElement.style.display = 'none';

    // Remove border from retry button wrapper
    const retryWrapper = panel.querySelector('#cb-retry')?.parentElement;
    if (retryWrapper) retryWrapper.style.borderTop = 'none';
    
    resultDiv.style.display = 'block';

    // NOTE: Removed renderCodexSection and renderTopPicks - replaced by tiered results
    
    // === RE-ATTACH BUTTON HANDLERS ===
    const copyAnswerBtn = panel.querySelector('#cb-copy-answer');
    const insertAnswerBtn = panel.querySelector('#cb-insert-answer');

    if (copyAnswerBtn) copyAnswerBtn.innerHTML = '📋 Copy Results';
    if (insertAnswerBtn) insertAnswerBtn.innerHTML = '✨ Insert Results';

    const retryBtn = panel.querySelector('#cb-retry');
    
    if (copyAnswerBtn) {
      const newCopyAnswer = copyAnswerBtn.cloneNode(true);
      copyAnswerBtn.parentNode.replaceChild(newCopyAnswer, copyAnswerBtn);
      newCopyAnswer.addEventListener('click', () => {
        const tieredResults = formatTieredResultsAsText(panel);
        navigator.clipboard.writeText(tieredResults);
        toast('✅ Results copied!');
      });
    }
    
    if (insertAnswerBtn) {
      const newInsertAnswer = insertAnswerBtn.cloneNode(true);
      insertAnswerBtn.parentNode.replaceChild(newInsertAnswer, insertAnswerBtn);
      newInsertAnswer.addEventListener('click', () => {
        const tieredResults = formatTieredResultsAsText(panel);
        const composer = findComposer();
        if (!composer) {
          toast('❌ Click in the chat box first');
          return;
        }
        insertText(composer, tieredResults);
        toast('✅ Results inserted!');
      });
    }
    
    if (retryBtn) {
      const newRetry = retryBtn.cloneNode(true);
      retryBtn.parentNode.replaceChild(newRetry, retryBtn);
      newRetry.addEventListener('click', () => doAgentSearch(panel));
    }

    // AI Summary copy/insert buttons (user-friendly format)
    const copyAiSummaryBtn = panel.querySelector('#cb-copy-ai-summary');
    const insertAiSummaryBtn = panel.querySelector('#cb-insert-ai-summary');
    
    if (copyAiSummaryBtn) {
      copyAiSummaryBtn.addEventListener('click', () => {
        const summaryText = panel.querySelector('#cb-ai-summary-text')?.textContent || '';
        navigator.clipboard.writeText(summaryText);
        toast('✅ AI Summary copied!');
      });
    }
    
    if (insertAiSummaryBtn) {
      insertAiSummaryBtn.addEventListener('click', () => {
        const summaryText = panel.querySelector('#cb-ai-summary-text')?.textContent || '';
        const composer = findComposer();
        if (!composer) {
          toast('❌ Click in the chat box first');
          return;
        }
        insertText(composer, summaryText);
        toast('✅ AI Summary inserted!');
      });
    }
  }

  function showError(panel, message) {
    const resultDiv = panel.querySelector('#cb-result');
    const answerDiv = panel.querySelector('#cb-answer');
    if (answerDiv) answerDiv.textContent = `❌ ${message}`;
    if (resultDiv) resultDiv.style.display = 'block';
  }

  // === PLATFORM-SPECIFIC COMPOSER DETECTION ===
  function findComposer() {
    const adapter = getAutoContextAdapter(PLATFORM);
    if (adapter) return adapter.findComposer();
    return null;
  }

  // Outer-scope flags so cancelLoop() and showAgentSpinner() share state
  // with startAutoContextObserver() regardless of call order.
  let loopCancelled = false;
  let cbSpinnerActive = false;

  function cancelLoop() {
    loopCancelled = true;
    cbSpinnerActive = false;
    hideAgentSpinner();
    toast('⏹ ContextBridge loop stopped');
    console.log('[CB Auto-context] Loop cancelled by user');
  }

  function showAgentSpinner() {
    const btn = document.getElementById('cb-toolbar-btn');
    if (!btn) return;
    // Inject keyframes once
    if (!document.getElementById('cb-spin-style')) {
      const style = document.createElement('style');
      style.id = 'cb-spin-style';
      style.textContent = '@keyframes cb-spin { to { transform: rotate(360deg); } } .cb-spinning { animation: cb-spin 1s linear infinite; }';
      document.head.appendChild(style);
    }
    // Toggle class on the dedicated spin target (defensive fallback: first span)
    const target = btn.querySelector('.cb-spin-target') || btn.querySelector('span');
    if (target) target.classList.add('cb-spinning');
    btn.title = 'Click to stop ContextBridge';
    cbSpinnerActive = true;
  }

  function hideAgentSpinner() {
    const btn = document.getElementById('cb-toolbar-btn');
    if (!btn) return;
    const target = btn.querySelector('.cb-spin-target') || btn.querySelector('span');
    if (target) target.classList.remove('cb-spinning');
    btn.title = 'ContextBridge';
    cbSpinnerActive = false;
  }

  function insertText(el, text) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const val = el.value;
      el.value = val.slice(0, start) + text + val.slice(end);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    el.focus();
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  function toast(msg) {
    const n = document.createElement('div');
    n.textContent = msg;
    Object.assign(n.style, {
      position: 'fixed', right: '20px', bottom: '20px', padding: '12px 16px',
      background: '#1a2a56', color: '#e7ecff', border: '1px solid #324066',
      borderRadius: '8px', zIndex: 2147483647, fontWeight: '500'
    });
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 2000);
  }

  function ensureToolbarButton() {
    if (document.getElementById('cb-toolbar-btn')) return;

    const nativeBtn = document.querySelector('button[aria-label="Add files, connectors, and more"]');
    if (!nativeBtn) return; // toolbar not ready yet

    const nativeBtnWrapper = nativeBtn.parentElement;
    if (!nativeBtnWrapper) return;

    const siblingsContainer = nativeBtnWrapper.parentElement;
    if (!siblingsContainer) return;

    const btn = document.createElement('button');
    btn.id = 'cb-toolbar-btn';
    btn.title = 'ContextBridge';
    btn.setAttribute('aria-label', 'ContextBridge Tool');

    Object.assign(btn.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '32px',
      width: '32px',
      borderRadius: '8px',
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      color: 'currentColor',
      flexShrink: '0',
      padding: '0'
    });

    btn.innerHTML = `<span style="display:inline-flex; align-items:center; gap:5px; font-size:13px; font-weight:500; white-space:nowrap; padding: 0 8px;"><span class="cb-spin-target" style="display:inline-block;">🔍</span> <span>ContextBridge</span></span>`;
    btn.style.width = 'auto'; // override the fixed 32px width

    btn.addEventListener('mouseenter', () => {
      if (!cbSpinnerActive) btn.style.background = 'var(--bg-200, rgba(0,0,0,0.08))';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'transparent';
    });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (cbSpinnerActive) {
        cancelLoop();
        return;
      }
      togglePanel();
    });

    // Insert immediately after the native button's wrapper
    nativeBtnWrapper.insertAdjacentElement('afterend', btn);
    // nativeBtnWrapper.style.display = 'none';
  }

  function ensureAutoContextDropdown() {
  if (document.getElementById('cb-ac-dropdown-btn')) return;

  const toolbarBtn = document.getElementById('cb-toolbar-btn');
  if (!toolbarBtn) return;

  const btn = document.createElement('button');
  btn.id = 'cb-ac-dropdown-btn';
  btn.title = 'Auto-Context project scope';
  btn.setAttribute('aria-label', 'Auto-Context Projects');

  Object.assign(btn.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '32px',
    width: 'auto',
    borderRadius: '8px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    color: 'currentColor',
    flexShrink: '0',
    padding: '0 8px',
    fontSize: '13px',
    fontWeight: '500',
    whiteSpace: 'nowrap'
  });

  btn.innerHTML = `📂 <span style="margin-left:4px;">Auto-Context Selection</span> <span style="margin-left:2px; font-size:10px;">▾</span>`;

  btn.addEventListener('mouseenter', () => {
    btn.style.background = 'var(--bg-200, rgba(0,0,0,0.08))';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.background = 'transparent';
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleAutoContextDropdown();
  });

  // Insert immediately after cb-toolbar-btn
  toolbarBtn.insertAdjacentElement('afterend', btn);
}

function toggleAutoContextDropdown() {
  let platformProjectId = null;
  if (PLATFORM === 'claude') {
    const m = window.location.href.match(/\/project\/([a-f0-9-]{36})/);
    if (m) platformProjectId = m[1];
  } else if (PLATFORM === 'openai') {
    const m = window.location.href.match(/\/(g-p-[a-z0-9]+)/i);
    if (m) platformProjectId = m[1];
  } else if (PLATFORM === 'gemini') {
    const m = window.location.href.match(/notebooks?(?:%2F|\/)([a-f0-9-]{36})/i);
    if (m) platformProjectId = m[1];
  }

  let panel = document.getElementById('cb-ac-panel');
  if (panel) {
    panel.remove();
    return;
  }

  const btn = document.getElementById('cb-ac-dropdown-btn');
  if (!btn) return;

  panel = document.createElement('div');
  panel.id = 'cb-ac-panel';
  Object.assign(panel.style, {
    position: 'fixed',
    zIndex: '2147483640',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: '12px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    width: '260px',
    maxHeight: '400px',
    overflowY: 'auto',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: '13px',
    color: '#e2e8f0'
  });

  // Position above the button
  const rect = btn.getBoundingClientRect();
  panel.style.left = rect.left + 'px';
  // Decide direction: open upward if not enough space below
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  const panelHeight = 400; // max-height
  if (spaceBelow >= panelHeight || spaceBelow >= spaceAbove) {
    panel.style.top = (rect.bottom + 8) + 'px';
  } else {
    panel.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
  }

  panel.innerHTML = `
    <div style="padding: 10px 12px; border-bottom: 1px solid #334155; font-weight: 600; color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">
      Auto-Context Projects
    </div>
    <div id="cb-ac-project-list" style="padding: 4px 0;">
      <div style="padding: 12px; color: #64748b; font-size: 12px;">Loading projects...</div>
    </div>
  `;

  document.body.appendChild(panel);

  // Populate project list
  populateAutoContextProjectList(platformProjectId);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function closePanel(e) {
      if (!panel.contains(e.target) && e.target !== btn) {
        panel.remove();
        document.removeEventListener('click', closePanel);
      }
    });
  }, 50);
}

async function populateAutoContextProjectList(platformProjectId) {
  const listDiv = document.getElementById('cb-ac-project-list');
  if (!listDiv) return;

  // Load saved selection for this platform project
  const storageKey = platformProjectId ? `cb_autocontext_projects_${platformProjectId}` : 'cb_autocontext_projects_default';
  const codexKey = platformProjectId ? `cb_autocontext_codex_${platformProjectId}` : 'cb_autocontext_codex_default';
  const saved = await new Promise(resolve =>
    chrome.storage.local.get([storageKey, codexKey], r => resolve({
      projectIds: r[storageKey] ? JSON.parse(r[storageKey]) : null,
      includeCodex: !!r[codexKey]  // defaults to false if never set
    }))
  );

  // Fetch all available projects
  await fetchProjects();
  if (!availableProjects.length) {
    listDiv.innerHTML = '<div style="padding: 12px; color: #64748b; font-size: 12px;">No projects found</div>';
    return;
  }

  // Determine default selection: saved, or auto-match via platformProjectId
  let selectedIds = saved.projectIds;
  if (!selectedIds) {
    // First visit — auto-select matching ContextBridge project
    // Prefer same-platform match first, then fall back to any match
    const currentProvider = PLATFORM === 'claude' ? 'claude' : PLATFORM === 'openai' ? 'openai' : PLATFORM;
    const matched = availableProjects.find(p => p.provider === currentProvider && (p.provider_project_id === platformProjectId || p.id === platformProjectId))
      || availableProjects.find(p => p.provider_project_id === platformProjectId || p.id === platformProjectId);
    console.log('[CB AC] platformProjectId:', platformProjectId, '| matched:', matched?.name ?? 'null');
    selectedIds = matched ? [matched.id] : [];
  }
  let includeCodex = saved.includeCodex;

  // Group by provider
  const groups = {};
  availableProjects.forEach(p => {
    const provider = getProjectProviderLabel(p.provider);
    if (!groups[provider]) groups[provider] = [];
    groups[provider].push(p);
  });
  if (!groups['Codex']) groups['Codex'] = [];
  groups['Codex'].push({ id: 'virtual-codex-local', name: 'VS Code / Local', virtual: true });

  const sortedKeys = Object.keys(groups).sort((a, b) => {
    if (a === 'Codex') return 1;
    if (b === 'Codex') return -1;
    return a.localeCompare(b);
  });

  let html = '';
  sortedKeys.forEach(provider => {
    html += `<div style="padding: 4px 8px; margin-top: 8px; margin-bottom: 4px; font-size: 11px; font-weight: 700; color: #A1A1AA; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #27272A;">${escapeHtml(provider)}</div>`;
    groups[provider].forEach(project => {
      const isSelected = project.virtual ? includeCodex : selectedIds.includes(project.id);
      const subtext = project.virtual ? 'Local Codebase' : `${project.conversation_count || 0} conversations`;
      html += `
        <label style="display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:6px; cursor:pointer; background:${isSelected ? 'rgba(139,92,246,0.15)' : 'transparent'}; transition:background 0.2s;">
          <input type="checkbox" class="cb-ac-checkbox" data-project-id="${project.id}" data-is-virtual="${!!project.virtual}" ${isSelected ? 'checked' : ''} style="width:14px; height:14px; cursor:pointer;">
          <div style="flex:1;">
            <div style="font-weight:600; color:#FAFAFA; font-size:13px;">${escapeHtml(project.name)}</div>
            <div style="color:#71717A; font-size:11px; margin-top:1px;">${subtext}</div>
          </div>
        </label>`;
    });
  });

  listDiv.innerHTML = html;

  // Save selection on checkbox change
  listDiv.querySelectorAll('.cb-ac-checkbox').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const projectId = e.target.dataset.projectId;
      const isVirtual = e.target.dataset.isVirtual === 'true';
      const label = e.target.closest('label');

      if (isVirtual) {
        includeCodex = e.target.checked;
        chrome.storage.local.set({ [codexKey]: includeCodex });
      } else {
        if (e.target.checked) {
          if (!selectedIds.includes(projectId)) selectedIds.push(projectId);
        } else {
          selectedIds = selectedIds.filter(id => id !== projectId);
          if (selectedIds.length === 0 && !includeCodex) {
            e.target.checked = true;
            selectedIds.push(projectId);
            toast('⚠️ Select at least one source');
            return;
          }
        }
        chrome.storage.local.set({ [storageKey]: JSON.stringify(selectedIds) });
      }

      if (label) label.style.background = e.target.checked ? 'rgba(139,92,246,0.15)' : 'transparent';
    });
  });
}

  function ensureOpenAIToolbarButton() {
    if (document.getElementById('cb-toolbar-btn')) return;

    const footerActions = document.querySelector('[data-testid="composer-footer-actions"]');
    if (!footerActions) return;

    const footerFlex = footerActions.querySelector('.flex');
    if (!footerFlex) return;

    const btn = document.createElement('button');
    btn.id = 'cb-toolbar-btn';
    btn.type = 'button';
    btn.title = 'ContextBridge';
    btn.setAttribute('aria-label', 'ContextBridge Tool');

    Object.assign(btn.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '36px',
      width: 'auto',
      borderRadius: '8px',
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      color: 'currentColor',
      flexShrink: '0',
      padding: '0 8px'
    });

    btn.innerHTML = `<span style="display:inline-flex; align-items:center; gap:5px; font-size:13px; font-weight:500; white-space:nowrap;"><span class="cb-spin-target" style="display:inline-block;">🔍</span> <span>ContextBridge</span></span>`;

    btn.addEventListener('mouseenter', () => {
      if (!cbSpinnerActive) btn.style.background = 'rgba(0,0,0,0.08)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'transparent';
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (cbSpinnerActive) {
        cancelLoop();
        return;
      }
      togglePanel();
    });

    footerFlex.insertBefore(btn, footerFlex.firstChild);
  }

  function hideNativeProjectButton() {
    const projectBtn = document.querySelector('button[aria-pressed="true"]');
    if (!projectBtn) return;
    projectBtn.parentElement.style.display = 'none';
  }

  function injectToolbarCSS() {
    if (document.getElementById('cb-toolbar-style')) return;
    const style = document.createElement('style');
    style.id = 'cb-toolbar-style';
    style.textContent = `
      /* ContextBridge toolbar button hover */
      #cb-toolbar-btn:hover {
        background: var(--bg-200, rgba(0,0,0,0.08)) !important;
      }
    `;
    document.head.appendChild(style);
  }

  // ── AUTO-CONTEXT ADAPTERS ────────────────────────────────────────────────────

  const claudeAutoContextAdapter = {
    getAssistantMessages() {
      return Array.from(document.querySelectorAll('[data-is-streaming]'));
    },
    isMessageComplete(node) {
      return node.dataset?.isStreaming === 'false';
    },
    extractMessageText(node) {
      return node.querySelector('.font-claude-response')?.innerText?.trim() 
        || node.innerText?.trim() || '';
    },
    findComposer() {
      return document.querySelector('div[contenteditable="true"]') ||
            document.querySelector('textarea[placeholder*="Reply"]');
    },
    findSendButton() {
      return document.querySelector('button[aria-label="Send message"]');
    },
    async insertText(composer, text) {
      composer.focus();
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt
        });
        composer.dispatchEvent(pasteEvent);
        // If Lexical handled the paste, we're done
        await new Promise(r => setTimeout(r, 100));
        if (composer.innerText?.trim()) return;
        // Fallback if paste event wasn't consumed
        document.execCommand('insertText', false, text);
      } catch (e) {
        document.execCommand('insertText', false, text);
      }
    },
    getComposerText(composer) {
      return composer.innerText || composer.value || '';
    },
    isComposerStable(composer, expectedText) {
      const sendBtn = this.findSendButton();
      return !!(sendBtn && !sendBtn.disabled);
    },
    isSendButtonEnabled(button) {
      return button && !button.disabled;
    },
      async getProjectId() {
        const stored = await new Promise(resolve =>
          chrome.storage.sync.get(['activeProjectId'], resolve)
        );
        return stored.activeProjectId || null;
      }
    };
    const openAIAutoContextAdapter = {
    getAssistantMessages() {
      return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    },
    isMessageComplete(node) {
      const turn = node.closest('[data-turn="assistant"]') ||
                  node.closest('[data-testid*="conversation-turn"]') ||
                  node.closest('section[data-scroll-anchor]') ||
                  node.parentElement;
      if (!turn) {
        console.log('[CB isMessageComplete] No turn found for node:', node);
        return false;
      }
      return !!turn.querySelector('[data-testid="copy-turn-action-button"]');
    },
    extractMessageText(node) {
      return node.innerText?.trim() || '';
    },
    findComposer() {
      return document.querySelector('#prompt-textarea') ||
            document.querySelector('div[contenteditable="true"]');
    },
    findSendButton() {
      return document.querySelector('button[aria-label="Send prompt"]') ||
            document.querySelector('#composer-submit-button');
    },
    async insertText(composer, text) {
      // Ensure the composer has focus before inserting
      composer.click();
      composer.focus();
      await new Promise(r => setTimeout(r, 50));

      // execCommand works on ProseMirror when focus is established first
      const inserted = document.execCommand('insertText', false, text);
      
      if (!inserted) {
        // Fallback: set via input event on the underlying textarea if present
        const textarea = document.querySelector('textarea[name="prompt-textarea"]');
        if (textarea) {
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          ).set;
          nativeSetter.call(textarea, text);
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      // Give ProseMirror time to reconcile
      await new Promise(r => setTimeout(r, 200));
    },

    getComposerText(composer) {
      return composer.innerText || composer.value || '';
    },
    isComposerStable(composer, expectedText) {
      // ProseMirror doesn't expose inserted text reliably via innerText
      // Just verify the send button is enabled instead
      const sendBtn = this.findSendButton();
      return !!(sendBtn && !sendBtn.disabled && !sendBtn.hasAttribute('disabled'));
    },
    isSendButtonEnabled(button) {
      return button && !button.disabled && !button.hasAttribute('disabled');
    },
    async getProjectId() {
      const gizmoMatch = window.location.pathname.match(/\/g\/(g-p-[a-z0-9]+)/i)
                      || window.location.pathname.match(/\/g\/(g-[a-zA-Z0-9]+)/);
      const gizmoId = gizmoMatch?.[1];
      if (!gizmoId) {
        const stored = await new Promise(resolve => chrome.storage.sync.get(['activeProjectId'], resolve));
        return stored.activeProjectId || null;
      }
      try {
        const uuidRes = await authFetch(`${API_BASE}/api/utils/gizmo-to-uuid`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gizmoId })
        });
        const uuidData = await uuidRes.json();
        console.log('[CB Auto-context] Resolved gizmoId to projectId:', gizmoId, '->', uuidData?.uuid);
        return uuidData?.uuid || null;
      } catch (e) {
        console.warn('[CB Auto-context] gizmo-to-uuid failed, falling back to activeProjectId:', e);
        const stored = await new Promise(resolve => chrome.storage.sync.get(['activeProjectId'], resolve));
        return stored.activeProjectId || null;
      }
    }
  };

// ─── Gemini toolbar button ───────────────────────────────────────────────────
function ensureGeminiToolbarButton() {
  const existing = document.getElementById('cb-toolbar-btn');
  if (existing && existing.isConnected) return;

  const leadingActions = document.querySelector('.leading-actions-wrapper');
  if (!leadingActions) return;

  const toolboxDrawer = leadingActions.querySelector('toolbox-drawer');
  if (!toolboxDrawer) return;

  const btn = document.createElement('button');
  btn.id = 'cb-toolbar-btn';
  btn.title = 'ContextBridge';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'ContextBridge Tool');

  Object.assign(btn.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '32px',
    width: 'auto',
    borderRadius: '8px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    color: 'currentColor',
    flexShrink: '0',
    padding: '0'
  });

  btn.innerHTML = `<span style="display:inline-flex; align-items:center; gap:5px; font-size:13px; font-weight:500; white-space:nowrap; padding: 0 8px;"><span class="cb-spin-target" style="display:inline-block;">🔍</span> <span>ContextBridge</span></span>`;

  btn.addEventListener('mouseenter', () => {
    if (!cbSpinnerActive) btn.style.background = 'rgba(0,0,0,0.08)';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.background = 'transparent';
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (cbSpinnerActive) {
      cancelLoop();
      return;
    }
    togglePanel();
  });

  leadingActions.insertBefore(btn, toolboxDrawer);
}

// ─── Gemini adapter ──────────────────────────────────────────────────────────
const geminiAutoContextAdapter = {
  getAssistantMessages() {
    return Array.from(document.querySelectorAll('model-response'));
  },

  isMessageComplete(el) {
    const md = el.querySelector('div.markdown');
    if (!md) return false;
    return md.getAttribute('aria-busy') === 'false';
  },

  extractMessageText(el) {
    const md = el.querySelector('div.markdown');
    return md ? md.innerText.trim() : '';
  },

  findComposer() {
    return document.querySelector('div.ql-editor[contenteditable="true"]');
  },

  findSendButton() {
    return document.querySelector('button.send-button');
  },

  isSendButtonEnabled() {
    const btn = this.findSendButton();
    if (!btn) return false;
    return btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled;
  },

  getComposerText() {
    const c = this.findComposer();
    return c ? c.innerText.trim() : '';
  },

  insertText(composer, text) {
    composer.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    if (!composer.innerText.trim()) {
      composer.innerHTML = `<p>${text}</p>`;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  },

  isComposerStable() {
    const btn = this.findSendButton();
    if (!btn) return false;
    return !btn.classList.contains('loading');
  },

  async getProjectId() {
    return new Promise(resolve => {
      chrome.storage.sync.get(['activeProjectId'], result => {
        resolve(result.activeProjectId || null);
      });
    });
  }
};

  // Placeholder — selectors TBD after DOM inspection
  const grokAutoContextAdapter   = null;

  function getAutoContextAdapter(platform) {
    switch (platform) {
      case 'claude': return claudeAutoContextAdapter;
      case 'openai': return openAIAutoContextAdapter;
      case 'gemini': return geminiAutoContextAdapter;
      case 'grok':   return grokAutoContextAdapter;
      default:       return null;
    }
  }

  // Shared stability poller — replaces the old fixed 3s delay + autoSubmit
  async function waitForComposerReadyAndStable(adapter, composer, expectedText, timeoutMs = 5000) {
    const pollInterval = 150;
    const requiredStableTicks = 2; // two consecutive passing checks ~300ms apart
    let stableTicks = 0;
    let elapsed = 0;

    while (elapsed < timeoutMs) {
      await new Promise(r => setTimeout(r, pollInterval));
      elapsed += pollInterval;

      const sendBtn = adapter.findSendButton();
      const btnReady = sendBtn && (adapter.isSendButtonEnabled
        ? adapter.isSendButtonEnabled(sendBtn)
        : !sendBtn.disabled);
      const textReady = adapter.isComposerStable(composer, expectedText);

      if (btnReady && textReady) {
        stableTicks++;
        if (stableTicks >= requiredStableTicks) return true;
      } else {
        stableTicks = 0;
      }
    }

    console.warn('[CB Auto-context] waitForComposerReadyAndStable timed out');
    return false;
  }

  // ── SHARED ENGINE ────────────────────────────────────────────────────────────

  function startAutoContextObserver() {
    const adapter = getAutoContextAdapter(PLATFORM);
    if (!adapter) return;
    startProviderAutoContextObserver(adapter);
  }

  let activeAutoContextObserver = null;

  // ── AUTO-CONTEXT DISABLE FLAG ────────────────────────────────────────────────
  let autoContextDisabled = false;
  chrome.storage.local.get(['cb_autocontext_disabled'], (r) => {
    autoContextDisabled = !!r.cb_autocontext_disabled;
    if (autoContextDisabled) {
      const dropdownBtn = document.getElementById('cb-ac-dropdown-btn');
      if (dropdownBtn) dropdownBtn.style.display = 'none';
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.cb_autocontext_disabled !== undefined) {
      autoContextDisabled = !!changes.cb_autocontext_disabled.newValue;
      console.log('[CB Auto-context] Disabled flag updated:', autoContextDisabled);
      const dropdownBtn = document.getElementById('cb-ac-dropdown-btn');
      if (dropdownBtn) {
        dropdownBtn.style.display = autoContextDisabled ? 'none' : 'inline-flex';
      }
      // Also close the panel if open
      if (autoContextDisabled) {
        document.getElementById('cb-ac-panel')?.remove();
      }
    }
  });

  function startProviderAutoContextObserver(adapter) {
    if (activeAutoContextObserver) {
      activeAutoContextObserver.disconnect();
      activeAutoContextObserver = null;
      console.log('[CB Auto-context] Previous observer disconnected');
    }

    let lastSeenMessageCount = -1;
    let autoContextPending = false;

    const observer = new MutationObserver(async () => {
      if (autoContextDisabled) return;
      if (!autoContextPending && !cbSpinnerActive) loopCancelled = false;

      const completedMessages = adapter.getAssistantMessages()
        .filter(node => adapter.isMessageComplete(node));
      const currentCount = completedMessages.length;

      if (lastSeenMessageCount === -1) {
        lastSeenMessageCount = currentCount;
        return;
      }

      if (currentCount <= lastSeenMessageCount) return;
      if (autoContextPending) return;

      const lastMessage = completedMessages[completedMessages.length - 1];
      if (!lastMessage) return;

      autoContextPending = true;

      if (loopCancelled) {
        loopCancelled = false;
        autoContextPending = false;
        return;
      }

      const messageText = adapter.extractMessageText(lastMessage);
      if (!messageText || messageText.length < 20) {
        lastSeenMessageCount = currentCount;
        autoContextPending = false;
        return;
      }

      lastSeenMessageCount = currentCount;

      const projectId = await adapter.getProjectId();

      // Read platformProjectId from DOM
      let platformProjectId = null;
      const urlMatch = window.location.href.match(/\/project\/([a-f0-9-]{36})/);
      if (urlMatch) platformProjectId = urlMatch[1];

      // Load from per-platform-project dropdown selection, fall back to legacy stored IDs
      const acStorageKey = platformProjectId ? `cb_autocontext_projects_${platformProjectId}` : null;
      const codexKey = platformProjectId ? `cb_autocontext_codex_${platformProjectId}` : 'cb_autocontext_codex_default';

      const keysToFetch = ['cb_selected_project_ids', codexKey];
      if (acStorageKey) keysToFetch.push(acStorageKey);

      const storedData = await new Promise(resolve =>
        chrome.storage.local.get(keysToFetch, r => resolve(r))
      );

      let projectIds = [];
      if (acStorageKey && storedData[acStorageKey]) {
        try { projectIds = JSON.parse(storedData[acStorageKey]); } catch (e) { projectIds = []; }
      } else if (storedData.cb_selected_project_ids) {
        try { projectIds = JSON.parse(storedData.cb_selected_project_ids); } catch (e) { projectIds = []; }
      }
      if (!projectIds.length && projectId) projectIds = [projectId];

      const includeCodex = !!storedData[codexKey];

      if (!projectIds.length) {
        console.log('[CB Auto-context] No projectId resolved, skipping');
        autoContextPending = false;
        return;
      }

      console.log(`[CB Auto-context] New message on ${PLATFORM}, checking for questions...`);
      showAgentSpinner();

      try {
        const response = await authFetch(`${API_BASE}/api/agent/auto-context`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageText, projectId: projectIds[0], projectIds, platformProjectId, includeCodex })
        });

        if (!response.ok) {
          console.warn('[CB Auto-context] API error:', response.status);
          hideAgentSpinner();
          autoContextPending = false;
          return;
        }

        const data = await response.json();

        if (loopCancelled) {
          hideAgentSpinner();
          autoContextPending = false;
          return;
        }

        if (data.hasQuestions && data.qaBlock) {
          console.log('[CB Auto-context] Injecting Q&A block...');
          const composer = adapter.findComposer();
          if (composer) {
            await adapter.insertText(composer, data.qaBlock);
            const ready = await waitForComposerReadyAndStable(adapter, composer, data.qaBlock);
            if (loopCancelled) {
              hideAgentSpinner();
              autoContextPending = false;
              return;
            }
            if (ready) {
              const sendBtn = adapter.findSendButton();
              if (sendBtn && !sendBtn.disabled) {
                sendBtn.click();
                toast('⚡ ContextBridge auto-answered & submitted');
              } else {
                toast('⚡ ContextBridge injected — submit manually');
              }
            } else {
              toast('⚡ ContextBridge injected — submit manually');
            }
          }
        } else {
          console.log('[CB Auto-context] No answerable questions — loop complete');
          toast('✅ ContextBridge: No answerable questions detected, loop complete');
        }
      } catch (e) {
        console.warn('[CB Auto-context] Error:', e.message);
        hideAgentSpinner();
        autoContextPending = false;
      }

      hideAgentSpinner();
      autoContextPending = false;
    });

    observer.observe(document.body, { childList: true, subtree: true });
    activeAutoContextObserver = observer;
    console.log(`[CB Auto-context] Observer started for ${PLATFORM}`);
  }

 // Safe initialization that waits for the body to exist
  async function initUI() {
    injectToolbarCSS();
    console.log('[CB] initUI starting...');
    
    try {
      console.log('[CB] Calling loadSettings...');
      await loadSettings();
      console.log('[CB] loadSettings completed successfully');
    } catch (e) {
      console.error('[CB] Failed to load settings:', e);
    }
    
    console.log('[CB] About to check document.body...');
    
    if (document.body) {
      if (PLATFORM === 'claude') { ensureToolbarButton(); ensureAutoContextDropdown(); }
      if (PLATFORM === 'openai') { ensureOpenAIToolbarButton(); ensureAutoContextDropdown(); }
      if (PLATFORM === 'gemini') { ensureGeminiToolbarButton(); ensureAutoContextDropdown(); }

      let geminiDebounce = null;
      const obs = new MutationObserver(() => {
        if (PLATFORM === 'claude') { ensureToolbarButton(); ensureAutoContextDropdown(); hideNativeProjectButton(); }
        if (PLATFORM === 'openai') { ensureOpenAIToolbarButton(); ensureAutoContextDropdown(); }
        if (PLATFORM === 'gemini') {
          clearTimeout(geminiDebounce);
          geminiDebounce = setTimeout(() => { ensureGeminiToolbarButton(); ensureAutoContextDropdown(); }, 150);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });

      if (PLATFORM === 'gemini') {
        setTimeout(() => { ensureGeminiToolbarButton(); ensureAutoContextDropdown(); }, 500);
        setTimeout(() => { ensureGeminiToolbarButton(); ensureAutoContextDropdown(); }, 1500);
      }

      startAutoContextObserver();

      let lastUrl = location.href;
      setInterval(() => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          console.log('[CB] URL change detected, restarting observer...');
          startAutoContextObserver();
        }
      }, 1000);

    } else {
      const observer = new MutationObserver((mutations, obs) => {
        if (document.body) {
          if (PLATFORM === 'claude') { ensureToolbarButton(); ensureAutoContextDropdown(); }
          if (PLATFORM === 'openai') { ensureOpenAIToolbarButton(); ensureAutoContextDropdown(); }
          if (PLATFORM === 'gemini') { ensureGeminiToolbarButton(); ensureAutoContextDropdown(); }
          obs.disconnect();

          let geminiDebounce = null;
          const permObs = new MutationObserver(() => {
            if (PLATFORM === 'claude') { ensureToolbarButton(); ensureAutoContextDropdown(); hideNativeProjectButton(); }
            if (PLATFORM === 'openai') { ensureOpenAIToolbarButton(); ensureAutoContextDropdown(); }
            if (PLATFORM === 'gemini') {
              clearTimeout(geminiDebounce);
              geminiDebounce = setTimeout(() => { ensureGeminiToolbarButton(); ensureAutoContextDropdown(); }, 150);
            }
          });
          permObs.observe(document.body, { childList: true, subtree: true });

          if (PLATFORM === 'gemini') {
            setTimeout(() => { ensureGeminiToolbarButton(); ensureAutoContextDropdown(); }, 500);
            setTimeout(() => { ensureGeminiToolbarButton(); ensureAutoContextDropdown(); }, 1500);
          }

          startAutoContextObserver();

          let lastUrl = location.href;
          setInterval(() => {
            if (location.href !== lastUrl) {
              lastUrl = location.href;
              console.log('[CB] URL change detected, restarting observer...');
              startAutoContextObserver();
            }
          }, 1000);
        }
      });
      observer.observe(document.documentElement, { childList: true });
    }
  }

  window.addEventListener('cb-open-search', () => {
    togglePanel();
  
  });

  // Start the safe init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
  } else {
    initUI();
  }

  console.log(`[CB] Content script initialized for ${PLATFORM}`);

})();