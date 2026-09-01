// injected_interceptor.js - Runs at document_start in MAIN world
(function() {
  // Guard: prevent double-patching
  if (window.__cbInterceptorActive) {
    console.log('⏭️ [CB] Interceptor already active, skipping');
    return;
  }
  window.__cbInterceptorActive = true;
  
  console.log('✅ [CB] Fetch interceptor active (document_start)');
  
  const originalFetch = window.fetch;
  
  // Helper: extract URL string from various input types
  function toUrl(resource) {
    try {
      if (typeof resource === 'string') return resource;
      if (resource instanceof URL) return resource.href;
      if (resource && typeof resource.url === 'string') return resource.url; // Request object
      return String(resource);
    } catch {
      return '';
    }
  }
  
  window.fetch = async function(...args) {
    const [resource, config] = args;
    const response = await originalFetch.apply(this, args);
    const url = toUrl(resource);
    if (!url) return response;
    
    // Only clone responses for URLs we actually care about (avoids memory overhead on every fetch)
    
    // =========== OPENAI INTERCEPTION ===========
    if (url.includes('/backend-api/')) {
      // LIST: /conversations but NOT /conversation/ (singular with ID)
      const isList = url.includes('/conversations') && !url.includes('/conversation/');
      // DETAIL: /conversation/{uuid}
      const isDetail = /\/conversation\/[a-f0-9-]{8,}/i.test(url);
      
      if (isList) {
        const clone = response.clone();
        clone.json().then(data => {
          console.log('📡 [CB] OpenAI LIST intercepted');
          window.postMessage({ type: 'CTX_INTERCEPT_LIST', platform: 'openai', payload: data }, '*');
        }).catch(() => {});
      } else if (isDetail) {
        const clone = response.clone();
        clone.json().then(data => {
          const match = url.match(/\/conversation\/([a-f0-9-]+)/i);
          if (match && data) {
            console.log('📡 [CB] OpenAI DETAIL intercepted:', match[1]);
            data._interceptedId = match[1];
            window.postMessage({ type: 'CTX_INTERCEPT_DETAIL', platform: 'openai', payload: data }, '*');
          }
        }).catch(() => {});
      }
    }
    
    // =========== CLAUDE INTERCEPTION ===========
    if (url.includes('claude.ai/api/') || url.includes('/api/organizations/')) {
      // Only match /chat_conversations endpoints, skip count_all, search, etc.
      // LIST: /chat_conversations?project_uuid=... (query param pattern, no sub-path)
      const claudeListMatch = url.match(/\/chat_conversations(\?|$)/) || url.match(/\/conversations_v2(\?|$)/);
      // DETAIL: /chat_conversations/{uuid} (UUID sub-path, not count_all or other sub-paths)
      const claudeDetailMatch = url.match(/\/chat_conversations\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
      
      if (claudeListMatch && !claudeDetailMatch) {
        const clone = response.clone();
        clone.json().then(data => {
          console.log('📡 [CB] Claude LIST intercepted');
          window.postMessage({ type: 'CTX_INTERCEPT_LIST', platform: 'claude', payload: data }, '*');
        }).catch(() => {});
      }
  
      else if (claudeDetailMatch) {
        const clone = response.clone();
        clone.json().then(data => {
          if (data) {
            console.log('📡 [CB] Claude DETAIL intercepted:', claudeDetailMatch[1]);
            data._interceptedId = claudeDetailMatch[1];
            data._interceptedUrl = url;
            // Buffer in window in case content.js listener isn't ready yet
            window.__cbPendingDetails = window.__cbPendingDetails || [];
            window.__cbPendingDetails.push({ type: 'CTX_INTERCEPT_DETAIL', platform: 'claude', payload: data });
            window.postMessage({ type: 'CTX_INTERCEPT_DETAIL', platform: 'claude', payload: data }, '*');
          }
        }).catch(() => {});
      }
    }

    // =========== GROK INTERCEPTION ===========
    if (url.includes('grok.com/rest/app-chat/')) {
      // LIST: /conversations with workspaceId (project-specific)
      if (url.includes('/conversations') && url.includes('workspaceId=')) {
        const clone = response.clone();
        clone.json().then(data => {
          const wsMatch = url.match(/workspaceId=([a-f0-9-]+)/);
          data._workspaceId = wsMatch ? wsMatch[1] : null;
          console.log('📡 [CB] Grok PROJECT LIST intercepted, workspace:', data._workspaceId, 'conversations:', data.conversations?.length);
          window.postMessage({ type: 'CTX_INTERCEPT_LIST', platform: 'grok', payload: data }, '*');
        }).catch(() => {});
      }
      // DETAIL: /conversations/{uuid}/load-responses (message content)
      else if (url.match(/\/conversations\/[a-f0-9-]+\/load-responses/)) {
        const clone = response.clone();
        clone.json().then(data => {
          const match = url.match(/\/conversations\/([a-f0-9-]+)\/load-responses/);
          if (match && data) {
            console.log('📡 [CB] Grok DETAIL intercepted:', match[1]);
            data._interceptedId = match[1];
            window.postMessage({ type: 'CTX_INTERCEPT_DETAIL', platform: 'grok', payload: data }, '*');
          }
        }).catch(() => {});
      }
      // RESPONSE NODES: /response-node (to get message IDs and sender info)
      else if (url.includes('/response-node')) {
        const clone = response.clone();
        clone.json().then(data => {
          console.log('📡 [CB] Grok RESPONSE-NODE intercepted');
          window.postMessage({ type: 'CTX_INTERCEPT_RESPONSE_NODE', platform: 'grok', payload: data }, '*');
        }).catch(() => {});
      }
    }

    // Temporary: log all BardChatUi URLs
    if (url.includes('BardChatUi')) {
      console.log('🔍 [CB] BardChatUi URL seen:', url);
    }

    // =========== GEMINI INTERCEPTION ===========
    if (url.includes('/_/BardChatUi/data/') || url.includes('gemini.google.com/_/BardChatUi/data/')) {
      console.log('🔍 [CB] Gemini URL matched:', url);

      // REAL-TIME: StreamGenerate (new messages)
      if (url.includes('StreamGenerate')) {
        const clone = response.clone();
        clone.text().then(rawText => {

          // Extract user message from POST body f.req (double-encoded JSON)
          let userText = null;
          try {
            const bodyStr = config?.body && typeof config.body === 'string' ? config.body : null;
            if (bodyStr) {
              const params = new URLSearchParams(bodyStr);
              const fReq = params.get('f.req');
              if (fReq) {
                const outer = JSON.parse(fReq);
                userText = outer?.[0]?.[0] || null;
              }
            }
          } catch {}

          // Parse wrb streaming chunks — take LAST valid occurrence of each field
          let conversationId = null;
          let responseId = null;
          let assistantText = null;
          let title = null;

          const stripped = rawText.replace(/^\)]\}'\s*/, '');
          const chunks = stripped.split(/\n\d+\n/).filter(Boolean);

          for (const chunk of chunks) {
            try {
              const parsed = JSON.parse(chunk);
              const wrbEntry = parsed?.[0];
              if (!Array.isArray(wrbEntry) || wrbEntry[0] !== 'wrb.fr') continue;
              const innerStr = wrbEntry[2];
              if (!innerStr) continue;
              const inner = JSON.parse(innerStr);

              if (inner?.[1]?.[0]) conversationId = inner[1][0];
              if (inner?.[1]?.[1]) responseId = inner[1][1];
              if (inner?.[4]?.[0]?.[1]?.[0]) assistantText = inner[4][0][1][0];
              if (inner?.[10]?.[0]) title = inner[10][0];
            } catch {}
          }

          if (conversationId) {
            console.log('📡 [CB] Gemini STREAM intercepted:', conversationId);
            window.postMessage({
              type: 'CTX_INTERCEPT_DETAIL',
              platform: 'gemini',
              payload: {
                _interceptedId: conversationId,
                _responseId: responseId,
                _userText: userText,
                _assistantText: assistantText,
                _title: title,
                _source: 'StreamGenerate'
              }
            }, '*');
          }
        }).catch(() => {});
      }

      // HISTORY: hNvQHb (fires on every conversation load — real-time + batch capture)
      else if (url.includes('batchexecute') && url.includes('hNvQHb')) {
        const clone = response.clone();
        clone.text().then(rawText => {

          let conversationId = null;
          let turns = null;

          const stripped = rawText.replace(/^\)]\}'\s*/, '');
          const chunks = stripped.split(/\n\d+\n/).filter(Boolean);

          for (const chunk of chunks) {
            try {
              const parsed = JSON.parse(chunk);
              const wrbEntry = parsed?.[0];
              if (!Array.isArray(wrbEntry) || wrbEntry[0] !== 'wrb.fr' || wrbEntry[1] !== 'hNvQHb') continue;
              const innerStr = wrbEntry[2];
              if (!innerStr) continue;
              const inner = JSON.parse(innerStr);
              turns = inner;
              // Per primer: each turn[0] = [conversationId, responseId]
              conversationId = inner?.[0]?.[0]?.[0] || null;
            } catch {}
          }

          if (turns) {
            console.log('📡 [CB] Gemini HISTORY (hNvQHb) intercepted, convId:', conversationId);
            window.postMessage({
              type: 'CTX_INTERCEPT_DETAIL',
              platform: 'gemini',
              payload: {
                _interceptedId: conversationId,
                _turns: turns,
                _source: 'hNvQHb'
              }
            }, '*');
          }
        }).catch(() => {});
      }
    }
    
    return response;
  };

  /**
   * Centralized Gemini Parser
   * Handles the "wrb.fr" envelope and double-encoded JSON
   */
  function parseGeminiResponse(rawText, source, userTextBody = null) {
    if (!rawText) return;
    try {
      const stripped = rawText.replace(/^\)]\}'\s*/, '');
      // Fix: Account for the first chunk not having a preceding newline
      const chunks = stripped.split(/(?:^|\n)\d+\n/).filter(Boolean);

      let conversationId = null;
      let responseId = null;
      let assistantText = null;
      let title = null;
      let turns = null;

      console.log(`🔍 [CB] Parsing Gemini payload (${source}), chunks to process: ${chunks.length}`);

      for (const chunk of chunks) {
        try {
          const parsed = JSON.parse(chunk);
          const wrbEntry = parsed?.[0];
          
          if (!Array.isArray(wrbEntry) || wrbEntry[0] !== 'wrb.fr') continue;

          console.log(`🔍 [CB] Found wrb.fr envelope, RPC ID: ${wrbEntry[1]}`);

          const innerStr = wrbEntry[2];
          if (!innerStr) continue;
          
          const inner = JSON.parse(innerStr);

          // hNvQHb is the History/Load RPC
          if (wrbEntry[1] === 'hNvQHb') {
            turns = inner;
            // Attempt to extract conversationId, but do not fail if structure changed
            conversationId = inner?.[0]?.[0]?.[0] || 'UNKNOWN_ID';
            console.log(`✅ [CB] Extracted hNvQHb turns! ID: ${conversationId}`);
          } else {
            // Standard StreamGenerate or other UI updates
            if (inner?.[1]?.[0]) conversationId = inner[1][0];
            if (inner?.[1]?.[1]) responseId = inner[1][1];
            if (inner?.[4]?.[0]?.[1]?.[0]) assistantText = inner[4][0][1][0];
            if (inner?.[10]?.[0]) title = inner[10][0];
          }
        } catch (e) {
          console.error(`⚠️ [CB] Chunk parse error:`, e.message, `Chunk snippet:`, chunk.substring(0, 100));
        }
      }

      if (conversationId || turns) {
        console.log(`📡 [CB] Gemini parsed successfully! ID: ${conversationId}, Turns extracted: ${turns ? 'Yes' : 'No'}, Source: ${source}`);
        window.postMessage({
          type: 'CTX_INTERCEPT_DETAIL',
          platform: 'gemini',
          payload: {
            _interceptedId: conversationId,
            _responseId: responseId,
            _userText: userTextBody,
            _assistantText: assistantText,
            _title: title,
            _turns: turns,
            _source: source
          }
        }, '*');
      } else {
        console.log(`⚠️ [CB] Gemini parse ran for ${source}, but found no ID or turns. Raw text length: ${rawText.length}`);
      }
    } catch (e) {
      console.error('[CB] Gemini parse error:', e, 'Raw text length:', rawText?.length);
    }
  }

  function extractGeminiUserText(body) {
    try {
      if (typeof body === 'string') {
        const params = new URLSearchParams(body);
        const fReq = params.get('f.req');
        if (fReq) {
          const outer = JSON.parse(fReq);
          return outer?.[0]?.[0] || null;
        }
      }
    } catch (e) {}
    return null;
  }

  // --- XHR INTERCEPTION ---

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._cbUrl = toUrl(url);
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    const url = this._cbUrl || '';

    // TEMPORARY DIAGNOSTIC FOR XHR
    if (url.includes('BardChatUi') || url.includes('batchexecute')) {
      console.log('🔍 [CB] XHR send URL:', url);
      if (typeof body === 'string' && body.includes('hNvQHb')) {
        console.log('🔍 [CB] XHR body contains hNvQHb');
      }
    }

    // GEMINI INTERCEPTION LOGIC
    if (url.includes('/_/BardChatUi/data/') || url.includes('gemini.google.com/_/BardChatUi/data/')) {
      const userText = extractGeminiUserText(body);
      const isHistory = url.includes('hNvQHb') || (typeof body === 'string' && body.includes('hNvQHb'));
      const isStream = url.includes('StreamGenerate');
      let lastProcessedLength = 0;

      if (isHistory || isStream) {
        this.addEventListener('readystatechange', () => {
          console.log('🔍 [CB] readystatechange fired, readyState:', this.readyState, 'isHistory:', isHistory, 'isStream:', isStream, 'len:', this.responseText?.length);

          if (!this.responseText) return;

          if (isHistory && this.readyState === 4) {
            parseGeminiResponse(this.responseText, 'XHR_hNvQHb', userText);
          } else if (isStream && this.readyState >= 3) {
            const currentLength = this.responseText.length;
            if (currentLength > lastProcessedLength) {
              lastProcessedLength = currentLength;
              parseGeminiResponse(this.responseText, 'XHR_StreamGenerate', userText);
            }
          }
        });
      }
    }

      return originalSend.apply(this, arguments);
    };
})();