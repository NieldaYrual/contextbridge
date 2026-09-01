// ============================================================================
// STEP 0: SKIP NON-SUPPORTED PAGES
// ============================================================================
if (window.location.protocol === 'chrome-extension:') {
  // Don't run on extension pages like progress.html
  console.log('⏭️ ContextBridge: Skipping extension page');
  // Use early return pattern - wrap rest of content.js in IIFE or just return
}

// ============================================================================
// STEP 1: INJECT INTERCEPTOR
// ============================================================================
(function injectInterceptor() {
  // Skip extension pages
  if (window.location.protocol === 'chrome-extension:') {
    return;
  }
  
  // OpenAI: Interceptor is registered via background.js (document_start, MAIN world)
  // No action needed here
  if (window.location.hostname.includes('chatgpt.com') || 
      window.location.hostname.includes('chat.openai.com')) {
    console.log('⏭️ ContextBridge: OpenAI interceptor handled by registered script');
    return;
  }
  
  // Claude and others: Use file injection
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected_interceptor.js');
    script.onload = function() { this.remove(); };
    (document.head || document.documentElement).appendChild(script);
    console.log('✅ ContextBridge: API Interceptor injected via file');
  } catch (e) {
    console.error('❌ ContextBridge: Failed to inject interceptor', e);
  }
})();

// ============================================================================
// STEP 2: LISTEN FOR INTERCEPTED DATA
// ============================================================================
window.addEventListener('message', function(event) {
  if (event.source !== window) return;

  // Handle Lists (Timestamps)
  if (event.data.type === 'CTX_INTERCEPT_LIST') {
    try {
      chrome.runtime.sendMessage({
        action: 'PROCESS_INTERCEPTED_DATA',
        platform: event.data.platform,
        payload: event.data.payload
      });
    } catch (e) {
      if (e.message && e.message.includes('Extension context invalidated')) {
        console.warn('[CB] Extension context lost on LIST, retrying...');
        setTimeout(() => {
          try {
            chrome.runtime.sendMessage({
              action: 'PROCESS_INTERCEPTED_DATA',
              platform: event.data.platform,
              payload: event.data.payload
            });
          } catch (e2) {
            console.warn('[CB] LIST retry failed:', e2.message);
          }
        }, 1000);
      }
    }
  }

  // Handle Details (Actual Capture)
  if (event.data.type === 'CTX_INTERCEPT_DETAIL') {
    console.log('📡 Content: Captured conversation detail via interceptor');
    try {
      chrome.runtime.sendMessage({
        action: 'PROCESS_INTERCEPTED_DETAIL',
        platform: event.data.platform,
        payload: event.data.payload
      });
    } catch (e) {
      if (e.message && e.message.includes('Extension context invalidated')) {
        console.warn('[CB] Extension context lost, retrying after reconnect...');
        setTimeout(() => {
          try {
            chrome.runtime.sendMessage({
              action: 'PROCESS_INTERCEPTED_DETAIL',
              platform: event.data.platform,
              payload: event.data.payload
            });
          } catch (e2) {
            console.warn('[CB] Retry failed, context still invalid:', e2.message);
          }
        }, 1000);
      }
    }
  }
});
// Drain any buffered captures that fired before this listener was ready
if (window.__cbPendingDetails && window.__cbPendingDetails.length > 0) {
  console.log(`[CB] Draining ${window.__cbPendingDetails.length} buffered detail(s)`);
  window.__cbPendingDetails.forEach(msg => {
    if (!chrome.runtime?.id) return;
    try {
      chrome.runtime.sendMessage({
        action: 'PROCESS_INTERCEPTED_DETAIL',
        platform: msg.platform,
        payload: msg.payload
      });
    } catch(e) {
      console.warn('[CB] Drain sendMessage failed:', e.message);
    }
  });
  window.__cbPendingDetails = [];
}
// ============================================================================
// content.js - Full capture implementation
console.log('🚀 ContextBridge injected on:', window.location.href);

// Get backend URL from storage (with fallback)
const DEFAULT_BACKEND_URL = 'https://api.ctxbridge.io';
let BACKEND_URL = DEFAULT_BACKEND_URL;

// Load from storage
chrome.storage.sync.get(['backendUrl'], (result) => {
  if (result.backendUrl) {
    BACKEND_URL = result.backendUrl;
    console.log('📡 Content script using backend:', BACKEND_URL);
  }
});

// Helper to check if we're on a dashboard page
function isOnDashboard() {
  const isLocalDashboard = window.location.hostname === 'localhost' && window.location.port === '3001';
  const isProdDashboard = window.location.hostname === 'api.ctxbridge.io';
  return isLocalDashboard || isProdDashboard;
}

// Immediately announce presence on dashboard pages
if (isOnDashboard()) {
  console.log('📢 Announcing to dashboard...');
  
  // Try multiple announcement methods
  setTimeout(() => {
    // Method 1: PostMessage
    window.postMessage({
      type: 'CONTEXTBRIDGE_READY',
      extensionId: chrome.runtime?.id || 'contextbridge-extension'
    }, '*');
    
    // Method 2: Custom event
    window.dispatchEvent(new CustomEvent('contextbridge-ready'));
    
    // Method 3: Respond to any pending PINGs
    window.postMessage({ type: 'CONTEXTBRIDGE_PONG', version: '1.0.0' }, '*');
    
    console.log('✅ Extension announced on', window.location.hostname);
  }, 100);
}

// ============================================================================
// STEP 3: INJECT AUTH TOKEN INTO DASHBOARD
// ============================================================================
async function injectAuthToken() {
  if (!isOnDashboard()) {
    return;
  }
  
  console.log('[CB] Dashboard detected, requesting fresh auth token...');
  
  try {
    // Ask background script to validate/refresh token before sending
    const response = await chrome.runtime.sendMessage({ action: 'GET_FRESH_AUTH_TOKEN' });
    
    if (response && response.success && response.accessToken) {
      console.log('[CB] Response from background:', response);
      console.log('[CB] User object:', response.user);
      window.postMessage({
        type: 'CONTEXTBRIDGE_AUTH_TOKEN',
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
        userId: response.userId,
        user: response.user
      }, '*');
      console.log('[CB] Fresh auth token injected into dashboard');
    } else {
      console.log('[CB] No valid auth token available:', response?.error);
    }
  } catch (e) {
    console.error('[CB] Failed to get auth token:', e);
  }
}

// Inject auth token when on dashboard
if (isOnDashboard()) {
  setTimeout(injectAuthToken, 200);
}

// Forward SET_ACTIVE_PROJECT from dashboard to background
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type === 'SET_ACTIVE_PROJECT' && event.data?.projectId) {
    chrome.runtime.sendMessage(
      { action: 'SET_ACTIVE_PROJECT', projectId: event.data.projectId },
      () => void chrome.runtime.lastError
    );
  }
});

const EXT_ID = chrome.runtime?.id;

// Check if we're on a Claude conversation page with capture params
if (window.location.hostname === 'claude.ai' && window.location.pathname.includes('/chat/')) {
  const urlParams = new URLSearchParams(window.location.search);
  const shouldCapture = urlParams.get('capture') === 'true';
  const projectId = urlParams.get('projectId');
  const conversationId = window.location.pathname.split('/chat/')[1];
  
  if (shouldCapture && projectId) {
    console.log('🎯 Capture mode activated for conversation:', conversationId);
    
    // Wait for page to load then capture
    setTimeout(() => {
      captureConversation(projectId, conversationId);
    }, 3000);
  }
}

// ---- helper: proxy POST via service worker (avoids CORS from content scripts)
async function postViaSW(url, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'postToBackend',
        url,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload) },
      (res) => {
        if (chrome.runtime.lastError) {
          console.error('SW message error:', chrome.runtime.lastError.message);
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || { ok: false, error: 'no response from SW' });
        }
      }
    );
  });
}

// ---- helper: extract messages (your selectors + quick cleanup)
function collectMessagesOnce() {
  const out = [];
  const nodes = document.querySelectorAll(
    '[data-testid*="message"], .message-content, div[class*="Message"]'
  );

  nodes.forEach((el) => {
    const text = (el.innerText || el.textContent || '').trim();
    if (!text) return;

    // naive role guess; keep your logic
    const role = el.classList.toString().includes('user') ? 'user' : 'assistant';
    out.push({ content: text, role, timestamp: new Date().toISOString() });
  });

  // fallback: grab some page text if nothing was found
  if (out.length === 0) {
    const allText = (document.body.innerText || '').trim();
    if (allText.length > 100) {
      out.push({
        content: allText.slice(0, 5000), // first 5k chars as fallback
        role: 'conversation',
        timestamp: new Date().toISOString()
      });
    }
  }

  return out;
}

// ---- helper: do one retry after a short delay (SPA rendering)
async function collectMessages() {
  let msgs = collectMessagesOnce();
  if (msgs.length === 0) {
    await new Promise((r) => setTimeout(r, 1200));
    msgs = collectMessagesOnce();
  }
  return msgs;
}

// ---- merged function (uses your logic + SW proxy)
async function captureConversation(projectId, conversationId) {
  try {
    console.log('📸 Starting capture…', { projectId, conversationId });

    const messages = await collectMessages();
    console.log(`Found ${messages.length} messages to capture`);

    if (messages.length === 0) {
      console.warn('No messages; aborting capture.');
      alert('No messages found on this page.');
      return;
    }

    const now = new Date().toISOString();
    const payload = {
      projectId,
      conversationId,
      conversation: {
        messages,
        name: document.title,
        created_at: now,
        updated_at: now
      },
      captureMetadata: {
        url: window.location.href,
        capturedAt: now
      }
    };

    // 🚀 post via service worker (no CORS issues)
    const res = await postViaSW(`${BACKEND_URL}/api/extension/capture`, payload);
    if (!res || !res.ok) {
      console.error('❌ Capture failed via proxy:', res);
      alert('Capture failed: ' + (res?.error || res?.status || 'unknown'));
      return;
    }

    let result = {};
    try { result = JSON.parse(res.body); } catch {} // body may be text
    console.log('✅ Capture result:', result);

    alert(`Captured ${messages.length} messages for conversation ${conversationId}`);

    // close tab after brief delay when in batch mode
    setTimeout(() => {
      if (new URLSearchParams(location.search).get('capture') === 'true') {
        window.close();
      }
    }, 1500);

  } catch (error) {
    console.error('❌ Capture failed:', error);
    alert('Capture failed: ' + (error?.message || String(error)));
  }
}

// ---- auto-capture when opened by dashboard with ?capture=true&projectId=…
(function maybeAutoCapture() {
  const url = new URL(location.href);
  const shouldCapture = url.searchParams.get('capture') === 'true';
  const projectId = url.searchParams.get('projectId');
  const isClaudeChat = /\/chat\//.test(location.pathname);

  if (shouldCapture && projectId && isClaudeChat) {
    const conversationId = location.pathname.split('/chat/')[1] || '';
    // small delay so Claude renders messages
    setTimeout(() => captureConversation(projectId, conversationId), 1500);
  }
})();

// ---- dashboard handshake (so “extension connected” turns green)
window.addEventListener('message', async (e) => {
  const msg = e.data || {};
  if (msg.type === 'CONTEXTBRIDGE_PING') {
    window.__CB_EXTENSION_READY__ = true;
    window.postMessage({ type: 'CONTEXTBRIDGE_PONG', version: '1.0.0' }, '*');
  }
  // optional: allow dashboard to command capture for this tab
  if (msg.type === 'CONTEXTBRIDGE_CAPTURE_TAB') {
    const { projectId } = msg;
    const conversationId = location.pathname.split('/chat/')[1] || '';
    await captureConversation(projectId, conversationId);
    window.postMessage({
      type: 'CONTEXTBRIDGE_PONG',
      extensionId: EXT_ID,
      version: '1.0.0'
    }, '*');
  }
});

// ---- announce availability when running on dashboard (localhost)
if (location.hostname === 'localhost' && location.port === '3001') {
  window.__CB_EXTENSION_READY__ = true;
  window.postMessage({ type: 'CONTEXTBRIDGE_READY', extensionId: EXT_ID }, '*');
}

// ---- manual trigger from popup / other parts of the extension
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'capture_conversation') {
    const conversationId = location.pathname.split('/chat/')[1] || '';
    captureConversation(request.projectId, conversationId);
    sendResponse({ success: true });
    return true;
  }
});

// === ContextBridge: Search & Inject panel (Claude) ===
(() => {
  const BTN_ID = 'cb-injector-toggle';
  const PANEL_ID = 'cb-injector-panel';
  const API_BASE = BACKEND_URL; // Uses configured backend URL
  const PROJECT_ID_KEY = 'cb_current_project';
  const DEFAULT_PROJECT_ID = '0198a07b-7fa1-75e2-8834-ca8a703c3469';

  function ensureButton() {
    if (document.getElementById(BTN_ID)) return;
    if (!/claude\.ai$/i.test(location.hostname)) return; // only show on Claude

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.textContent = '🔎 Inject';
    Object.assign(btn.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647,
      padding: '10px 14px', borderRadius: '10px', border: '1px solid #ccc',
      background: '#fff', boxShadow: '0 6px 18px rgba(0,0,0,.12)', cursor: 'pointer'
    });
    btn.addEventListener('click', togglePanel);
    document.body.appendChild(btn);
  }

  function togglePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) { panel.remove(); return; }

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div id="cb-shell"
          style="
            position:fixed; right:16px; bottom:64px;
            width:600px; height:500px; min-width:400px; min-height:300px; max-width:90vw; max-height:90vh;
            background:#0f172a; color:#e2e8f0; border:1px solid #334155; border-radius:16px;
            box-shadow:0 20px 50px rgba(0,0,0,.5);
            overflow:hidden;
            display:flex; flex-direction:column;
            box-sizing:border-box;
            z-index:2147483647;">
      
        <!-- Top-Left Resize Grip -->
        <div id="cb-grip-tl" title="Drag to resize"
            style="position:absolute; left:4px; top:4px; width:20px; height:20px;
                    cursor:nwse-resize; opacity:0.5; z-index:10;
                    background: linear-gradient(225deg, transparent 0 50%, #475569 50% 100%);
                    border-radius:16px 0 0 0;">
        </div>
      
        <!-- Draggable Header Bar -->
        <div id="cb-drag-handle" style="
            padding:12px 16px; background:#1e293b; border-bottom:1px solid #334155;
            border-radius:16px 16px 0 0; cursor:move;
            display:flex; justify-content:space-between; align-items:center;
            user-select:none;">
          <div style="font-weight:600; font-size:14px; color:#94a3b8; padding-left:20px;">
            🔍 ContextBridge Search
          </div>
          <button id="cbc" class="cb-btn cb-btn-close" style="padding:4px 12px; border-radius:8px; 
                                  border:1px solid #475569; background:#334155; color:#e2e8f0;
                                  font-size:13px; cursor:pointer; transition: all 0.2s;">Close</button>
        </div>
      
        <!-- Search & Controls -->
        <div id="cb-controls" style="
            display:flex; flex-direction:column; gap:8px; 
            padding:12px 16px; background:#1e293b; border-bottom:1px solid #334155;">
          
          <!-- Step 2: Overrides row -->
          <div id="cboverrides" style="display:flex; flex-wrap:wrap; gap:8px; align-items:center;">
            <input id="cbBudgetOverride" type="number" min="0" step="1"
                  placeholder="Budget tokens (optional)"
                  title="If set, overrides server-side token budget for /prepare"
                  style="flex:0 0 190px; padding:10px 12px; border-radius:10px; border:1px solid #475569; background:#0f172a; color:#e2e8f0;">
            <input id="cbSnippetOverride" type="text"
                  placeholder="Snippet override (optional)"
                  title="If set, forces a custom paste block for /prepare"
                  style="flex:1 1 220px; padding:10px 12px; border-radius:10px; border:1px solid #475569; background:#0f172a; color:#e2e8f0;">
          </div>

          <!-- Search row -->
          <div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px;">
            <input id="cbq" class="cb-input" placeholder="Search your ContextBridge (e.g., 'next priority', 'knowledge graph entities')"
                  style="flex:1 1 220px; min-width:200px; padding:10px 14px; 
                        border-radius:10px; border:1px solid #475569; 
                        background:#0f172a; color:#e2e8f0; font-size:14px;"/>
            <button id="cbs" class="cb-btn cb-btn-primary" style="padding:10px 16px; border-radius:10px; 
                                    border:1px solid #3b82f6; background:#3b82f6; color:white;
                                    font-weight:500; cursor:pointer; transition: all 0.2s;">Search</button>
            <button id="cbp" class="cb-btn cb-btn-secondary" style="padding:10px 16px; border-radius:10px; 
                                    border:1px solid #475569; background:#334155; color:#e2e8f0;
                                    font-weight:500; cursor:pointer; transition: all 0.2s;">Prepare & Insert</button>
          </div>

          <!-- Step 1: Token bar (estimate vs. budget) -->
          <div id="cbtokenbar" style="display:none; gap:8px; align-items:center;">
            <div id="cbtokenlabel" style="font-size:12px; color:#94a3b8;">Token estimate</div>
            <div style="flex:1 1 auto; height:10px; background:#0b1220; border:1px solid #2b395e; border-radius:999px; overflow:hidden;">
              <div id="cbtokenfill" style="height:100%; width:0%; background:#22c55e;"></div>
            </div>
            <div id="cbtokenfig" style="font-size:12px; color:#cbd5e1; min-width:120px; text-align:right;">—</div>
          </div>
        </div>
      
        <!-- Body -->
        <div id="cb-body" style="flex:1 1 auto; overflow:auto; padding:16px; background:#0f172a;">
          <div id="cbres"></div>
        </div>
      
        <!-- Bottom-Right Resize Grip -->
        <div id="cb-grip-br" title="Drag to resize"
            style="position:absolute; right:4px; bottom:4px; width:20px; height:20px;
                    cursor:nwse-resize; opacity:0.5;
                    background: linear-gradient(135deg, transparent 0 50%, #475569 50% 100%);
                    border-radius:0 0 16px 0;">
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    const shell = panel.querySelector('#cb-shell');
    const dragHandle = panel.querySelector('#cb-drag-handle');
    const gripTL = panel.querySelector('#cb-grip-tl');
    const gripBR = panel.querySelector('#cb-grip-br');
    const inputEl = panel.querySelector('#cbq');
    const searchBtn = panel.querySelector('#cbs');
    const prepareBtn = panel.querySelector('#cbp');
    const closeBtn = panel.querySelector('#cbc');

    const budgetEl = panel.querySelector('#cbBudgetOverride');
    const snippetEl = panel.querySelector('#cbSnippetOverride');
    if (budgetEl) {
      budgetEl.value = localStorage.getItem('CB_OVR_BUDGET') || '';
      budgetEl.addEventListener('input', () => localStorage.setItem('CB_OVR_BUDGET', budgetEl.value));
    }
    if (snippetEl) {
      snippetEl.value = localStorage.getItem('CB_OVR_SNIPPET') || '';
      snippetEl.addEventListener('input', () => localStorage.setItem('CB_OVR_SNIPPET', snippetEl.value));
    }

    // Safety check - if any critical element is missing, abort
    if (!shell || !dragHandle || !gripTL || !gripBR || !inputEl || !searchBtn || !prepareBtn || !closeBtn) {
      console.error('[CB] Failed to find panel elements:', {
        shell: !!shell,
        dragHandle: !!dragHandle,
        gripTL: !!gripTL,
        gripBR: !!gripBR,
        inputEl: !!inputEl,
        searchBtn: !!searchBtn,
        prepareBtn: !!prepareBtn,
        closeBtn: !!closeBtn
      });
      return;
    }

    // Add hover effects via JavaScript (CSP-compliant)
    const addHoverEffect = (el, normalBg, hoverBg) => {
      el.addEventListener('mouseenter', () => el.style.background = hoverBg);
      el.addEventListener('mouseleave', () => el.style.background = normalBg);
    };

    addHoverEffect(closeBtn, '#334155', '#475569');
    addHoverEffect(searchBtn, '#3b82f6', '#2563eb');
    addHoverEffect(prepareBtn, '#334155', '#475569');

    // Input focus effects
    inputEl.addEventListener('focus', () => inputEl.style.borderColor = '#3b82f6');
    inputEl.addEventListener('blur', () => inputEl.style.borderColor = '#475569');

    // Dragging functionality
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let initialRight = 0;
    let initialBottom = 0;

    dragHandle.addEventListener('mousedown', (e) => {
      if (e.target.id === 'cbc' || e.target.closest('#cb-grip-tl')) return;
      
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      
      const rect = shell.getBoundingClientRect();
      initialRight = window.innerWidth - rect.right;
      initialBottom = window.innerHeight - rect.bottom;
      
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      
      const deltaX = e.clientX - dragStartX;
      const deltaY = e.clientY - dragStartY;
      
      const newRight = Math.max(0, initialRight - deltaX);
      const newBottom = Math.max(0, initialBottom - deltaY);
      
      shell.style.right = newRight + 'px';
      shell.style.bottom = newBottom + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        document.body.style.userSelect = '';
      }
    });

    // Resize from Top-Left corner
    let isResizingTL = false;
    let isResizingBR = false;
    let resizeStartX = 0;
    let resizeStartY = 0;
    let startWidth = 0;
    let startHeight = 0;
    let startRight = 0;
    let startBottom = 0;

    if (gripTL) {
      gripTL.addEventListener('mousedown', (e) => {
        isResizingTL = true;
        resizeStartX = e.clientX;
        resizeStartY = e.clientY;
        
        const rect = shell.getBoundingClientRect();
        startWidth = rect.width;
        startHeight = rect.height;
        startRight = window.innerWidth - rect.right;
        startBottom = window.innerHeight - rect.bottom;
        
        document.body.style.userSelect = 'none';
        e.preventDefault();
        e.stopPropagation();
      });
    }

    // Resize from Bottom-Right corner
    if (gripBR) {
      gripBR.addEventListener('mousedown', (e) => {
        isResizingBR = true;
        resizeStartX = e.clientX;
        resizeStartY = e.clientY;
        
        const rect = shell.getBoundingClientRect();
        startWidth = rect.width;
        startHeight = rect.height;
        startRight = window.innerWidth - rect.right;
        startBottom = window.innerHeight - rect.bottom;
        
        document.body.style.userSelect = 'none';
        e.preventDefault();
        e.stopPropagation();
      });
    }

    document.addEventListener('mousemove', (e) => {
      if (isResizingTL) {
        const deltaX = e.clientX - resizeStartX;
        const deltaY = e.clientY - resizeStartY;
        
        const newWidth = Math.max(400, Math.min(window.innerWidth * 0.9, startWidth - deltaX));
        const newHeight = Math.max(300, Math.min(window.innerHeight * 0.9, startHeight - deltaY));
        
        const newRight = startRight + (startWidth - newWidth);
        const newBottom = startBottom + (startHeight - newHeight);
        
        shell.style.width = newWidth + 'px';
        shell.style.height = newHeight + 'px';
        shell.style.right = newRight + 'px';
        shell.style.bottom = newBottom + 'px';
      }
      
      if (isResizingBR) {
        const deltaX = e.clientX - resizeStartX;
        const deltaY = e.clientY - resizeStartY;
        
        const newWidth = Math.max(400, Math.min(window.innerWidth * 0.9, startWidth + deltaX));
        const newHeight = Math.max(300, Math.min(window.innerHeight * 0.9, startHeight + deltaY));
        
        shell.style.width = newWidth + 'px';
        shell.style.height = newHeight + 'px';
      }
    });

    document.addEventListener('mouseup', () => {
      if (isResizingTL || isResizingBR) {
        isResizingTL = false;
        isResizingBR = false;
        document.body.style.userSelect = '';
      }
    });

    // Event listeners for buttons
    closeBtn.addEventListener('click', () => panel.remove());
    searchBtn.addEventListener('click', doSearch);
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    prepareBtn.addEventListener('click', doPrepareAndInsertAll);

    const grip  = panel.querySelector('#cb-grip');
    let rsizing = false, sx = 0, sy = 0, sw = 0, sh = 0;
    function onMove(e) {
      if (!rsizing) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      const w = Math.min(Math.max(360, sw + dx), window.innerWidth  * 0.9);
      const h = Math.min(Math.max(260, sh + dy), window.innerHeight * 0.9);
      shell.style.width  = w + 'px';
      shell.style.height = h + 'px';
    }
    function stop() {
      if (!rsizing) return;
      rsizing = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', stop);
      document.body.style.userSelect = '';
    }
    grip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const rect = shell.getBoundingClientRect();
      rsizing = true; sx = e.clientX; sy = e.clientY; sw = rect.width; sh = rect.height;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', stop);
      document.body.style.userSelect = 'none';
    });
  }

  async function doSearch() {
    const qEl = document.getElementById('cbq');
    const resBox = document.getElementById('cbres');
    const q = (qEl?.value || '').trim();
    const projectId = localStorage.getItem(PROJECT_ID_KEY) || DEFAULT_PROJECT_ID;
    if (!q) return;

    resBox.innerHTML = `<div style="padding:8px;opacity:.8;">Searching…</div>`;
    try {
      const url = `${API_BASE}/api/context/inject/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}&limit=25`;
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      // DEBUG: Check what we're receiving
      console.log('[CB Extension] Search response:', {
        resultCount: data.results?.length,
        firstResult: data.results?.[0],
        hasTitle: !!data.results?.[0]?.title
      });

      const html = (data.results || []).map((it) => {
        // DEBUG: Log each item
        console.log('[CB Extension] Rendering item:', {
          id: it.id,
          kind: it.kind,
          title: it.title,
          hasSnippet: !!it.snippet
        });
        
        const s = it.scores || {};
        const score = s.overall ?? s.semantic ?? s.keyword ?? s.entity ?? '';
        const badge = score !== '' ? `<span style="font-size:12px;opacity:.8;">${typeof score === 'number' ? Math.round(score) : score}</span>` : '';
        
        return `
          <div data-id="${it.id}" data-kind="${it.kind}"
              data-src='${JSON.stringify(it.source || {}).replace(/&/g,"&amp;").replace(/'/g,"&apos;")}'
              class="cb-card"
              style="border:1px solid #2b395e; border-radius:10px; padding:10px; margin-bottom:10px; background:#0b1220;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <div style="font-weight:600;">${escapeHtml(it.title || it.kind)}</div>
              ${badge}
            </div>
            <pre style="white-space:pre-wrap; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; background:#0b1220; color:#e7ecff; margin:8px 0; max-height:180px; overflow:auto;">${escapeHtml(it.snippet || '')}</pre>
            <div style="display:flex; gap:8px;">
              <button class="cb-copy" style="padding:6px 10px; border-radius:8px; border:1px solid #2b395e; background:#172246; color:#e7ecff; cursor:pointer;">Copy</button>
              <button class="cb-insert" style="padding:6px 10px; border-radius:8px; border:1px solid #2b395e; background:#172246; color:#e7ecff; cursor:pointer;">Insert</button>
            </div>
          </div>
        `;
      }).join('') || `<div style="padding:8px;opacity:.8;">No results.</div>`;

      resBox.innerHTML = html;

      resBox.querySelectorAll('.cb-copy').forEach(btn => btn.addEventListener('click', e => handleAction(e, 'copy')));
      resBox.querySelectorAll('.cb-insert').forEach(btn => btn.addEventListener('click', e => handleAction(e, 'insert')));
    } catch (e) {
      resBox.innerHTML = `<div style="padding:8px;color:#ffa3a3;">Error: ${String(e)}</div>`;
    }
  }

  function findClaudeComposer() {
    // Strategy 1: Look for ProseMirror editor (Claude's current editor)
    const proseMirror = document.querySelector('.ProseMirror[contenteditable="true"]');
    if (proseMirror && isVisible(proseMirror)) {
      console.log('✅ Found ProseMirror editor');
      return proseMirror;
    }

    // Strategy 2: Look for any contenteditable in the composer area
    const contentEditables = document.querySelectorAll('[contenteditable="true"]');
    for (const el of contentEditables) {
      if (isVisible(el) && el.getBoundingClientRect().height > 40) {
        console.log('✅ Found contenteditable:', el.className);
        return el;
      }
    }

    // Strategy 3: Look inside shadow DOMs and iframes
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      // Check shadow roots
      if (el.shadowRoot) {
        const shadowEditor = el.shadowRoot.querySelector('[contenteditable="true"]');
        if (shadowEditor && isVisible(shadowEditor)) {
          console.log('✅ Found editor in shadow DOM');
          return shadowEditor;
        }
      }
    }

    console.warn('❌ Composer not found');
    return null;
  }

  // Helper function to check visibility
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 100 &&
      rect.height > 20 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      style.opacity !== '0'
    );
  }

  async function handleAction(ev, action) {
    const card = ev.target.closest('.cb-card');
    const kindSrc = card?.getAttribute('data-kind') || 'message';
    const itemId = card?.getAttribute('data-id') || null;
    const srcRaw = card?.getAttribute('data-src') || '{}';
    let source = {};
    try { source = JSON.parse(srcRaw.replace(/&apos;/g, "'")); } catch {}

    const pre = card?.querySelector('pre');
    const snippet = pre?.innerText || '';
    if (!snippet) return;

    if (action === 'copy') {
      await navigator.clipboard.writeText(snippet);
      toast('Copied to clipboard');
      await logInjection({
        snippet,
        snippetType: kindSrc,
        source,                               // ← include source ids
        event: { event_type: 'copied', details: { itemId } } // ← include itemId
      });
    } else {
      // Insert with tiny retry (unchanged)
      let composer = findClaudeComposer();
      if (!composer) { await new Promise(r => setTimeout(r, 150)); composer = findClaudeComposer(); }
      if (!composer) { await new Promise(r => setTimeout(r, 400)); composer = findClaudeComposer(); }
      if (!composer) { toast('Composer not found'); return; }

      insertText(composer, snippet);
      toast('Inserted into message');
      await logInjection({
        snippet,
        snippetType: kindSrc,
        source,                               // ← include source ids
        event: { event_type: 'pasted', details: { itemId } } // ← include itemId
      });
    }
  }

  function insertText(el, text) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const val = el.value;
      el.value = val.slice(0, start) + text + val.slice(end);
      el.selectionStart = el.selectionEnd = start + text.length;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    el.focus();
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  async function logInjection({ snippet, snippetType, event }) {
    try {
      const projectId = localStorage.getItem(PROJECT_ID_KEY) || DEFAULT_PROJECT_ID;
      await fetch(`${API_BASE}/api/context/inject/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          targetProvider: 'claude',
          targetChatId: location.pathname,
          targetChatUrl: location.href,
          snippet,
          snippetType,
          sourceMethod: 'hybrid',
          sourceScore: null,
          events: [event]
        })
      });
    } catch {}
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  function toast(msg) {
    const n = document.createElement('div');
    n.textContent = msg;
    Object.assign(n.style, {
      position: 'fixed', right: '20px', bottom: '20px', padding: '8px 12px',
      background: '#1a2a56', color: '#e7ecff', border: '1px solid #324066',
      borderRadius: '8px', zIndex: 2147483647
    });
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 1400);
  }

  // === Prepare & Insert All (uses existing helpers & IIFE constants) ===
  function fetchPreparedInjection(projectId, q) {
    // Read controls
    const bEl = document.getElementById('cbBudgetOverride');
    const instrEl = document.getElementById('cbSnippetOverride');

    const overridePrefs = {};
    const budgetStr = bEl && bEl.value !== '' ? bEl.value : null;
    if (budgetStr !== null) {
      const v = parseInt(budgetStr, 10);
      if (!Number.isNaN(v) && v >= 0) overridePrefs.budgetTokens = v;
    }

    // Natural-language instruction candidate:
    // Prefer dedicated instructions field; fall back to the search box.
    const instructionCandidate = (instrEl?.value || '').trim() || q;

    const body = {
      projectId,
      q,                         // traditional search terms (if any)
      instructionCandidate,      // free-form natural language to interpret
      allowAgent: true,          // hint to backend to run the agent
      ...(Object.keys(overridePrefs).length ? { overridePrefs } : {})
    };

    return fetch(`${API_BASE}/api/context/inject/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
  }

  function renderTokenBar(estimate, budget) {
    const bar = document.getElementById('cbtokenbar');
    const fill = document.getElementById('cbtokenfill');
    const fig = document.getElementById('cbtokenfig');
    const label = document.getElementById('cbtokenlabel');
    if (!bar || !fill || !fig || !label) return;

    const hasBudget = typeof budget === 'number' && budget > 0;
    const pct = hasBudget ? Math.min(100, Math.round((estimate / budget) * 100)) : 0;

    bar.style.display = estimate ? 'flex' : 'none';
    fill.style.width = hasBudget ? `${pct}%` : '0%';

    // Simple color shift when near/exceeding budget
    let color = '#22c55e'; // green
    if (hasBudget && pct >= 90) color = '#ef4444';       // red
    else if (hasBudget && pct >= 70) color = '#f59e0b';  // amber
    fill.style.background = color;

    label.textContent = 'Token estimate';
    fig.textContent = hasBudget
      ? `${estimate.toLocaleString()} / ${budget.toLocaleString()} (${pct}%)`
      : `${estimate?.toLocaleString?.() || estimate || '—'} est.`;
  }

  function approxTokenCount(text) {
    // Very rough token approximation: ~4 chars per token baseline
    // This is only for UI feedback when backend doesn’t supply tokenEstimate.
    if (!text) return 0;
    const len = text.length;
    const words = text.split(/\s+/).length;
    // Blend char and word heuristics to avoid huge skew for code
    const estFromChars = Math.ceil(len / 4);
    const estFromWords = Math.ceil(words * 1.3);
    return Math.max(1, Math.round((estFromChars * 0.7) + (estFromWords * 0.3)));
  }

  async function doPrepareAndInsertAll() {
    try {
      const qEl = /** @type {HTMLInputElement} */(document.getElementById('cbq'));
      const budgetEl = /** @type {HTMLInputElement} */(document.getElementById('cbBudgetOverride'));
      const snippetEl = /** @type {HTMLInputElement} */(document.getElementById('cbSnippetOverride'));

      const q = (qEl?.value || '').trim();
      const projectId = localStorage.getItem(PROJECT_ID_KEY) || DEFAULT_PROJECT_ID;
      if (!q) { toast('Type a query first'); return; }

      // Read overrides
      const budgetOverride = budgetEl && budgetEl.value !== '' ? parseInt(budgetEl.value, 10) : null;
      const snippetOverride = (snippetEl?.value || '').trim() || null;

      // Call /prepare (includes overrides in request body)
      const prep = await fetchPreparedInjection(projectId, q);

      // Decide which text to insert
      const preparedText = String(prep?.pasteBlock || '').trim();
      const finalText = snippetOverride ? snippetOverride : preparedText;

      if (!finalText) {
        toast('Nothing to insert');
        console.warn('[CB] No finalText: snippetOverride empty and prep.pasteBlock empty');
        return;
      }

      // Token bar numbers
      // Prefer backend tokenEstimate when using its pasteBlock; if we override, estimate locally
      const estimate = snippetOverride
        ? approxTokenCount(finalText)
        : Number(prep?.tokenEstimate || approxTokenCount(preparedText));

      // Budget to show on the bar: prefer user override; else backend's tokenBudget if provided
      const budget = (Number.isFinite(budgetOverride) && budgetOverride >= 0)
        ? budgetOverride
        : (Number.isFinite(prep?.tokenBudget) ? Number(prep.tokenBudget) : null);

      renderTokenBar(estimate, budget);

      // Insert into Claude composer
      let composer = findClaudeComposer();
      if (!composer) { await new Promise(r => setTimeout(r,150)); composer = findClaudeComposer(); }
      if (!composer) { await new Promise(r => setTimeout(r,400)); composer = findClaudeComposer(); }
      if (!composer) { toast('Composer not found'); return; }

      insertText(composer, finalText);
      toast(snippetOverride ? 'Inserted snippet override' : 'Inserted prepared context');

      // Log what happened
      await logInjection({
        snippet: finalText,
        snippetType: snippetOverride ? 'override' : 'multi',
        event: {
          event_type: 'pasted',
          details: {
            chosenIds: (prep.items || []).map(x => x.id),
            usedOverride: !!snippetOverride,
            clientEstimate: estimate,
            shownBudget: budget
          }
        }
      });

      // Console diagnostics to verify wiring fast
      console.debug('[CB] /prepare response:', {
        tokenEstimate: prep?.tokenEstimate,
        tokenBudget: prep?.tokenBudget,
        items: (prep?.items || []).length
      });
      console.debug('[CB] Overrides used:', { budgetOverride, snippetOverride: !!snippetOverride });

    } catch (e) {
      console.error('[CB] prepare & insert failed:', e);
      toast('Prepare failed');
    }
  }

  /*
  const obs = new MutationObserver(() => ensureButton());
  obs.observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();
  */
})();

// ============================================================
// ACTIVITY-BASED SYNC - Detect when user sends a message
// ============================================================

(function setupActivityDetection() {
  // Only run on Claude or ChatGPT
  const isClaudeChat = window.location.hostname === 'claude.ai';
  const isChatGPT = window.location.hostname === 'chatgpt.com';
  
  if (!isClaudeChat && !isChatGPT) {
    return;
  }
  
  const provider = isClaudeChat ? 'claude' : 'openai';
  console.log(`[CB Activity] Setting up activity detection for ${provider}`);
  
  // Get project ID from URL or page
  function getProjectId() {
    if (isClaudeChat) {
      // Check URL for project context
      const projectMatch = document.referrer?.match(/\/project\/([a-f0-9-]+)/);
      if (projectMatch) return projectMatch[1];
      
      // Check breadcrumb/header for project name/link
      const projectLink = document.querySelector('a[href*="/project/"]');
      if (projectLink) {
        const href = projectLink.getAttribute('href');
        const match = href?.match(/\/project\/([a-f0-9-]+)/);
        if (match) return match[1];
      }
      
      // Check for project indicator in the UI
      const projectBreadcrumb = document.querySelector('[data-testid*="project"]');
      if (projectBreadcrumb) {
        const link = projectBreadcrumb.querySelector('a[href*="/project/"]');
        if (link) {
          const match = link.href.match(/\/project\/([a-f0-9-]+)/);
          if (match) return match[1];
        }
      }
    }
    
    if (isChatGPT) {
      // Extract gizmo_id from URL: /g/g-p-xxxxx-name/c/...
      const gizmoMatch = window.location.pathname.match(/\/g\/(g-p-[a-z0-9]+)/i);
      if (gizmoMatch) {
        console.log('[CB Activity] OpenAI gizmo_id detected:', gizmoMatch[1]);
        return gizmoMatch[1]; // Return the gizmo_id as project ID
      }
      
      // Also check for regular GPT URLs: /g/g-xxxxx/c/...
      const regularGptMatch = window.location.pathname.match(/\/g\/(g-[a-zA-Z0-9]+)/);
      if (regularGptMatch) {
        console.log('[CB Activity] OpenAI GPT ID detected:', regularGptMatch[1]);
        return regularGptMatch[1];
      }
    }
    
    return null;
  }
  
  // Get conversation ID from URL
  function getConversationId() {
    if (isClaudeChat) {
      const match = window.location.pathname.match(/\/chat\/([a-f0-9-]+)/);
      return match ? match[1] : null;
    }
    if (isChatGPT) {
      // URL format: /g/g-p-xxx/c/conversation-id or /c/conversation-id
      const match = window.location.pathname.match(/\/c\/([a-f0-9-]+)/i);
      return match ? match[1] : null;
    }
    return null;
  }
  
  // Notify background script of activity
  function notifyActivity(projectId, conversationId) {
    const now = Date.now();
    
    // Use sessionStorage for cooldown tracking (avoids scoping issues)
    const cooldownKey = `cb_lastNotified_${projectId}`;
    const storedTime = parseInt(sessionStorage.getItem(cooldownKey) || '0', 10);
    const NOTIFY_COOLDOWN = 5 * 60 * 1000; // 5 minutes
    
    // Cooldown check - don't spam notifications
    if ((now - storedTime) < NOTIFY_COOLDOWN) {
      console.log(`[CB Activity] Cooldown active for project ${projectId}, skipping notification`);
      return;
    }
    
    console.log(`[CB Activity] User sent message in project ${projectId}, conversation ${conversationId}`);

    // Determine provider from page context
    const provider = window.location.hostname.includes('claude.ai') ? 'claude' : 'openai';
    
    chrome.runtime.sendMessage({
      action: 'userActivity',
      provider,
      projectId,
      conversationId,
      timestamp: now
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[CB Activity] Failed to notify background:', chrome.runtime.lastError);
      } else {
        console.log('[CB Activity] Background notified:', response);
        // Store cooldown in sessionStorage
        sessionStorage.setItem(cooldownKey, now.toString());
      }
    });
  }
  
  // Listen for send button clicks
  function setupSendButtonListener() {
    document.addEventListener('click', (event) => {
      // Claude: aria-label="Send message"
      // OpenAI: data-testid="send-button", id="composer-submit-button", aria-label="Send prompt"
      const target = event.target.closest(
        'button[aria-label="Send message"], ' +          // Claude
        'button[data-testid="send-button"], ' +          // OpenAI (testid)
        'button#composer-submit-button, ' +               // OpenAI (id)
        'button[aria-label="Send prompt"]'                // OpenAI (aria-label)
      );
      
      if (target) {
        console.log('[CB Activity] Send button clicked!');
        
        const projectId = getProjectId();
        const conversationId = getConversationId();
        
        if (projectId) {
          notifyActivity(projectId, conversationId);
        } else {
          console.log('[CB Activity] No project context detected (might be outside a project)');
        }
      }
    }, true);
    
    // Also listen for Enter key in the input (Ctrl+Enter or just Enter depending on settings)
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        // Check if we're in a contenteditable or textarea
        const activeEl = document.activeElement;
        const isInComposer = activeEl?.closest('[contenteditable="true"]') || 
                            activeEl?.tagName === 'TEXTAREA' ||
                            activeEl?.closest('fieldset'); // Claude's input is in a fieldset
        
        if (isInComposer) {
          // Small delay to let the message actually send
          setTimeout(() => {
            const projectId = getProjectId();
            const conversationId = getConversationId();
            
            if (projectId) {
              console.log('[CB Activity] Enter pressed in composer');
              notifyActivity(projectId, conversationId);
            }
          }, 100);
        }
      }
    }, true);
  }
  
  // Initialize
  setupSendButtonListener();
  console.log('[CB Activity] Activity detection initialized');
  
})();


// ---- end of content.js ----