// === ContextBridge: Status Widget (Claude & ChatGPT) ===
(() => {
  // ============================================================
  // CONSTANTS
  // ============================================================
  const WIDGET_ID = 'cb-status-widget';
  const PANEL_ID = 'cb-status-panel';
  const PRIVACY_POLICY_URL = 'https://ctxbridge.io/privacy';
  
  // States: 'active' | 'syncing' | 'synced'
  const STATES = {
    ACTIVE: 'active',
    SYNCING: 'syncing',
    SYNCED: 'synced'
  };

  const STALE_TIMEOUT = 5 * 60 * 1000; // 5 minutes in milliseconds
  
  const STATE_CONFIG = {
    [STATES.ACTIVE]: {
      color: '#22c55e',      // green
      icon: '🟢',
      label: 'Active'
    },
    [STATES.SYNCING]: {
      color: '#3b82f6',      // blue
      icon: '🔵',
      label: 'Syncing...'
    },
    [STATES.SYNCED]: {
      color: '#22c55e',      // green (same as active)
      icon: '✅',
      label: 'Synced'
    }
  };
  
  // ============================================================
  // STATE
  // ============================================================
  let currentState = STATES.ACTIVE;
  let lastSyncTime = null;
  let isExpanded = false;
  let syncedTimeoutId = null;  // For auto-reverting from 'synced' to 'active'
  let isStaleSyncDetected = false;
  
  // ============================================================
  // PLATFORM DETECTION
  // ============================================================
  function isAIPlatformPage() {
    const hostname = window.location.hostname;
    return (
      hostname === 'claude.ai' ||
      hostname === 'chatgpt.com' ||
      hostname === 'chat.openai.com' ||
      hostname === 'grok.com' ||
      hostname === 'gemini.google.com'
    );
  }
  
  function getCurrentPlatform() {
    const hostname = window.location.hostname;
    if (hostname === 'claude.ai') return 'Claude';
    if (hostname === 'chatgpt.com' || hostname === 'chat.openai.com') return 'ChatGPT';
    if (hostname === 'grok.com') return 'Grok';
    if (hostname === 'gemini.google.com') return 'Gemini';
    return 'AI Platform';
  }
  
  // ============================================================
  // WIDGET CREATION
  // ============================================================
  function createWidget() {
    // Don't create if already exists or not on AI platform
    if (document.getElementById(WIDGET_ID)) return;
    if (!isAIPlatformPage()) return;
    
    const widget = document.createElement('div');
    widget.id = WIDGET_ID;
    
    // Inline styles (CSP-compliant, matches existing panel pattern)
    Object.assign(widget.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      zIndex: '2147483646',  // One less than inject panel
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '13px',
      userSelect: 'none'
    });
    
    widget.innerHTML = isExpanded ? createExpandedHTML() : createCollapsedHTML();
    document.body.appendChild(widget);
    
    // Attach event listeners
    attachWidgetListeners(widget);
    
    console.log('[CB Widget] Status widget injected on', getCurrentPlatform());
  }
  
  function createCollapsedHTML() {
    const config = STATE_CONFIG[currentState];
    return `
      <div id="cb-status-collapsed" style="
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        background: #1e293b;
        border: 1px solid #334155;
        border-radius: 20px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        cursor: pointer;
        transition: all 0.2s ease;
      ">
        <span id="cb-search-trigger" title="Search ContextBridge" style="
          font-size: 13px;
          cursor: pointer;
          opacity: 0.8;
          transition: opacity 0.2s;
        ">🔍</span>
        <span style="color: #e2e8f0; font-weight: 500;">ContextBridge</span>
        <span style="color: ${config.color}; font-size: 12px;">${config.label}</span>
      </div>
    `;
  }
  
  function createExpandedHTML() {
    const config = STATE_CONFIG[currentState];
    const platform = getCurrentPlatform();
    const syncTimeStr = lastSyncTime 
      ? new Date(lastSyncTime).toLocaleTimeString() 
      : 'Never';
    
    return `
      <div id="cb-status-expanded" style="
        width: 260px;
        background: #1e293b;
        border: 1px solid #334155;
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.25);
        overflow: hidden;
      ">
        <!-- Header -->
        <div style="
          padding: 12px;
          background: #0f172a;
          border-bottom: 1px solid #334155;
          display: flex;
          justify-content: space-between;
          align-items: center;
        ">
          <span style="color: #e2e8f0; font-weight: 600;">ContextBridge</span>
          <button id="cb-status-close" style="
            background: none;
            border: none;
            color: #94a3b8;
            cursor: pointer;
            font-size: 16px;
            padding: 0 4px;
          ">×</button>
        </div>
        
        <!-- Status -->
        <div style="padding: 12px;">
          <div style="
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
          ">
            <span style="font-size: 14px;">${config.icon}</span>
            <span style="color: ${config.color}; font-weight: 500;">${config.label}</span>
            <span style="color: #64748b; font-size: 12px;">on ${platform}</span>
          </div>
          
          <!-- Disclosure -->
          <div style="
            color: #94a3b8;
            font-size: 11px;
            margin-bottom: 10px;
            line-height: 1.4;
          ">
            Captures conversations to your secure, private database.
            <a id="cb-privacy-link" href="${PRIVACY_POLICY_URL}" target="_blank" style="
              color: #60a5fa;
              text-decoration: none;
            ">Privacy Policy</a>
          </div>
          
          <!-- Last Sync -->
          <div style="
            color: #94a3b8;
            font-size: 12px;
            margin-bottom: 12px;
          ">
            Last sync: ${syncTimeStr}
          </div>
          
          ${isStaleSyncDetected ? `
          <!-- Stale Sync Warning -->
          <div style="
            background: #451a03;
            border: 1px solid #f59e0b;
            border-radius: 8px;
            padding: 10px;
            margin-bottom: 12px;
          ">
            <div style="color: #fbbf24; font-size: 12px; font-weight: 500; margin-bottom: 6px;">
              ⚠️ No sync activity for 5+ minutes
            </div>
            <div style="color: #fcd34d; font-size: 11px; margin-bottom: 10px;">
              Stop syncing and try again?
            </div>
            <div style="display: flex; gap: 8px;">
              <button id="cb-stale-stop" style="
                flex: 1;
                padding: 6px 10px;
                background: #dc2626;
                border: none;
                border-radius: 6px;
                color: #fff;
                font-size: 12px;
                cursor: pointer;
              ">Stop Syncing</button>
              <button id="cb-stale-wait" style="
                flex: 1;
                padding: 6px 10px;
                background: #475569;
                border: none;
                border-radius: 6px;
                color: #e2e8f0;
                font-size: 12px;
                cursor: pointer;
              ">Keep Waiting</button>
            </div>
          </div>
          ` : ''}
          
          <!-- Buttons -->
          <button id="cb-open-dashboard" style="
            width: 100%;
            padding: 8px 12px;
            background: #334155;
            border: 1px solid #475569;
            border-radius: 8px;
            color: #e2e8f0;
            font-size: 13px;
            cursor: pointer;
            transition: background 0.2s;
          ">
            Open Dashboard
          </button>

          <!-- Auto-Context Toggle -->
          <button id="cb-autocontext-toggle" style="
            width: 100%;
            margin-top: 8px;
            padding: 8px 12px;
            background: #334155;
            border: 1px solid #475569;
            border-radius: 8px;
            color: #e2e8f0;
            font-size: 13px;
            cursor: pointer;
            transition: background 0.2s;
          ">
            Disable Auto-Context
          </button>
        </div>
      </div>
    `;
  }
  
  // ============================================================
  // EVENT HANDLERS
  // ============================================================
  function attachWidgetListeners(widget) {
    // Click on collapsed widget to expand
    widget.addEventListener('click', (e) => {
      const collapsed = e.target.closest('#cb-status-collapsed');
      if (collapsed && !isExpanded) {
        expandWidget();
      }
    });
    
    // Close button
    widget.addEventListener('click', (e) => {
      if (e.target.id === 'cb-status-close') {
        collapseWidget();
      }
    });
    
    // Dashboard button
    widget.addEventListener('click', (e) => {
      if (e.target.id === 'cb-open-dashboard') {
        openDashboard();
      }
    });

    // Auto-Context toggle
    widget.addEventListener('click', (e) => {
      if (e.target.id === 'cb-autocontext-toggle') {
        chrome.storage.local.get(['cb_autocontext_disabled'], (r) => {
          const nowDisabled = !r.cb_autocontext_disabled;
          chrome.storage.local.set({ cb_autocontext_disabled: nowDisabled }, () => {
            const btn = document.getElementById('cb-autocontext-toggle');
            if (btn) {
              btn.textContent = nowDisabled ? 'Enable Auto-Context' : 'Disable Auto-Context';
              btn.style.background = nowDisabled ? '#7f1d1d' : '#334155';
              btn.style.borderColor = nowDisabled ? '#991b1b' : '#475569';
            }
            console.log('[CB Widget] Auto-context disabled:', nowDisabled);
          });
        });
      }
    });

    // Stale sync - Stop button
    widget.addEventListener('click', (e) => {
      if (e.target.id === 'cb-stale-stop') {
        isStaleSyncDetected = false;
        chrome.storage.local.set({ 
          cb_widgetState: 'active',
          cb_widgetStateTimestamp: Date.now()
        });
        updateState(STATES.ACTIVE);
        console.log('[CB Widget] User stopped stale sync');
      }
    });
    
    // Stale sync - Keep Waiting button
    widget.addEventListener('click', (e) => {
      if (e.target.id === 'cb-stale-wait') {
        isStaleSyncDetected = false;
        chrome.storage.local.set({ 
          cb_widgetStateTimestamp: Date.now()  // Reset timestamp
        });
        updateState(STATES.SYNCING);  // Re-render without stale warning
        console.log('[CB Widget] User chose to keep waiting');
      }
    });
    
    // Hover effects (CSP-compliant)
    widget.addEventListener('mouseover', (e) => {
      const collapsed = e.target.closest('#cb-status-collapsed');
      if (collapsed) {
        collapsed.style.background = '#334155';
      }
      const dashBtn = e.target.closest('#cb-open-dashboard');
      if (dashBtn) {
        dashBtn.style.background = '#475569';
      }
    });
    
    widget.addEventListener('mouseout', (e) => {
      const collapsed = e.target.closest('#cb-status-collapsed');
      if (collapsed) {
        collapsed.style.background = '#1e293b';
      }
      const dashBtn = e.target.closest('#cb-open-dashboard');
      if (dashBtn) {
        dashBtn.style.background = '#334155';
      }
    });

    widget.addEventListener('click', (e) => {
      if (e.target.id === 'cb-search-trigger') {
        e.stopPropagation(); // Don't also expand the widget
        window.dispatchEvent(new CustomEvent('cb-open-search'));
      }
    });

    // Sync toggle button to current session state
    chrome.storage.local.set({ cb_autocontext_disabled: nowDisabled }, () => {
      const btn = document.getElementById('cb-autocontext-toggle');
      if (btn && r.cb_autocontext_disabled) {
        btn.textContent = 'Enable Auto-Context';
        btn.style.background = '#7f1d1d';
        btn.style.borderColor = '#991b1b';
      }
    });
  }
  
  function expandWidget() {
    const widget = document.getElementById(WIDGET_ID);
    if (!widget) return;
    
    isExpanded = true;
    widget.innerHTML = createExpandedHTML();
  }
  
  function collapseWidget() {
    const widget = document.getElementById(WIDGET_ID);
    if (!widget) return;
    
    isExpanded = false;
    widget.innerHTML = isExpanded ? createExpandedHTML() : createCollapsedHTML();
  }
  
  function openDashboard() {
    // Send message to background to open dashboard
    chrome.runtime.sendMessage({ action: 'openDashboard' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[CB Widget] Failed to open dashboard:', chrome.runtime.lastError);
      }
    });
  }
  
  // ============================================================
  // STATE UPDATES
  // ============================================================
  function updateState(newState, syncTime = null) {
    // Clear any pending timeout
    if (syncedTimeoutId) {
      clearTimeout(syncedTimeoutId);
      syncedTimeoutId = null;
    }
    
    currentState = newState;
    if (syncTime) {
      lastSyncTime = syncTime;
      // Persist sync time to storage
      chrome.storage.local.set({ cb_lastSyncTime: syncTime });
    }
    
    // Re-render widget
    const widget = document.getElementById(WIDGET_ID);
    if (widget) {
      widget.innerHTML = isExpanded ? createExpandedHTML() : createCollapsedHTML();
    }
    
    // If synced, auto-revert to active after 3 seconds
    if (newState === STATES.SYNCED) {
      syncedTimeoutId = setTimeout(() => {
        updateState(STATES.ACTIVE);
      }, 10000);
    }
    
    console.log('[CB Widget] State updated to:', newState);
  }
  
  // ============================================================
  // MESSAGE LISTENER (from background.js)
  // ============================================================
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'widgetStateUpdate') {
      const { state, syncTime } = request;
      if (STATES[state.toUpperCase()]) {
        updateState(state.toLowerCase(), syncTime);
      }
      sendResponse({ success: true });
    }
    
    // Allow checking widget status
    if (request.action === 'getWidgetStatus') {
      sendResponse({ 
        currentState: currentState,
        lastSyncTime: lastSyncTime
      });
    }
    
    return false;  // Synchronous response
  });
  
  // ============================================================
  // INITIALIZATION
  // ============================================================
  function init() {
    // Skip extension pages
    if (window.location.protocol === 'chrome-extension:') {
      return;
    }
    
    // Only run on AI platforms
    if (!isAIPlatformPage()) {
      return;
    }
    
    // Load state and last sync time from storage, then create widget
    chrome.storage.local.get(['cb_lastSyncTime', 'cb_widgetState', 'cb_widgetStateTimestamp'], (result) => {
      if (result.cb_lastSyncTime) {
        lastSyncTime = result.cb_lastSyncTime;
        console.log('[CB Widget] Loaded last sync time:', lastSyncTime);
      }
      
      // Restore state from storage
      if (result.cb_widgetState) {
        const storedState = result.cb_widgetState;
        const storedTimestamp = result.cb_widgetStateTimestamp || 0;
        const elapsed = Date.now() - storedTimestamp;
        
        if (storedState === 'syncing') {
            if (elapsed > STALE_TIMEOUT) {
                // Sync appears stale - flag it and auto-expand
                isStaleSyncDetected = true;
                currentState = STATES.SYNCING;  // Keep syncing state until user decides
                isExpanded = true;  // Auto-expand to show prompt
                console.log('[CB Widget] Stale sync detected, elapsed:', Math.round(elapsed / 1000), 'seconds');
            } else {
                // Recent sync, restore normally
                currentState = STATES.SYNCING;
                console.log('[CB Widget] Restored syncing state');
            }
          } else if (storedState === 'synced') {
          // Show synced only if within 10-second window
          if (elapsed < 10000) {
            currentState = STATES.SYNCED;
            console.log('[CB Widget] Restored synced state, will revert in', 10000 - elapsed, 'ms');
            // Set timeout for remaining time
            syncedTimeoutId = setTimeout(() => {
              updateState(STATES.ACTIVE);
              chrome.storage.local.set({ cb_widgetState: 'active' });
            }, 10000 - elapsed);
          } else {
            // Synced expired, show active
            currentState = STATES.ACTIVE;
            chrome.storage.local.set({ cb_widgetState: 'active' });
          }
        }
      }
      
      // Wait for DOM to be ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createWidget);
      } else {
        createWidget();
      }
    });
    
    console.log('[CB Widget] Initialized');
  }
  
  // Run initialization
  init();
  
})();