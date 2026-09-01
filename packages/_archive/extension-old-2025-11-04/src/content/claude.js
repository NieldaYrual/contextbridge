// src/content/claude.js

// Prevent multiple injections and properly expose to window
(function() {
  // Check if already initialized
  if (window.__contextbridge_initialized__) {
    console.log('ContextBridge: Already initialized, skipping');
    return;
  }
  
  // Mark as initialized IMMEDIATELY
  window.__contextbridge_initialized__ = true;
  
  console.log('ContextBridge: Initializing...');

  class ClaudeConversationCapture {
    constructor() {
      this.currentProject = null;
      this.messages = [];
      this.conversationId = null;
      this.isCapturing = false;
      this.observer = null;
      
      this.init();
    }

    async init() {
      const urlParams = new URLSearchParams(window.location.search);
      // Load settings from storage
      const settings = await this.loadSettings();
      this.currentProject = settings.currentProject;
      
      // Override with URL-based detection if on a project page
      const urlProject = this.detectCurrentProject();
      if (urlProject) {
        this.currentProject = urlProject.id;
        
        // Also send the project name to popup
        chrome.runtime.sendMessage({
          action: 'projectDetected',
          projectId: urlProject.id,
          projectName: urlProject.name
        }).catch(() => {}); // Ignore errors if popup not open
      }
      
      console.log('ContextBridge: Current project:', this.currentProject);
      
      // Start observing for messages
      this.observeConversation();
      
      // Inject context panel
      this.injectContextPanel();

      // Check if we should capture messages for this conversation
      const shouldCapture = urlParams.get('capture') === 'true';
      const conversationId = urlParams.get('conversationId');
      const projectId = urlParams.get('projectId');
      const jobId = urlParams.get('jobId');
      
      if (shouldCapture && conversationId && projectId) {
        console.log('Auto-capture triggered for:', conversationId);
        // Wait for page to fully load
        setTimeout(() => {
          console.log('Auto-capturing messages for conversation:', conversationId);
          this.captureConversationMessages(conversationId, projectId);
        }, 3000); // Give Claude time to load the conversation
      }
      
      // Listen for messages from popup/background
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        console.log('ContextBridge: Received message:', request.action);
        
        if (request.action === 'startCapture') {
          this.startCapture();
          sendResponse({ success: true });
        return;
        } else if (request.action === 'stopCapture') {
          this.stopCapture();
          sendResponse({ success: true });
        return;
        } else if (request.action === 'getStatus') {
          const projectInfo = this.detectCurrentProject();
          sendResponse({
            isCapturing: this.isCapturing,
            messageCount: this.messages.length,
            currentProject: this.currentProject,
            projectName: projectInfo ? projectInfo.name : null
          });
          return;
        } else if (request.action === 'getCaptureStatus') {
          // NEW: background probe during timeout
          sendResponse({
            status: this.isCapturing ? 'capturing' : 'idle',
            messageCount: this.messages?.length || 0
          });
          return;
        } else if (request.action === 'updateProject') {
          this.currentProject = request.projectId;
          console.log('Project updated:', this.currentProject);
          sendResponse({ success: true });
          return;
        } else if (request.action === 'extractUrls') {
          const urls = this.extractAllConversationUrls();
          sendResponse({ urls });
          return;
        }
        if (request.action === 'captureMessagesForConversation') {
        this.captureConversationMessages(
            request.conversationId, 
            request.projectId
          );
          sendResponse({ success: true });
          return;
        }
        // No pending async sendResponse — close channel
        return false;
      });
    }

    async loadSettings() {
      return new Promise((resolve) => {
        chrome.storage.sync.get(['currentProject', 'autoCapture'], (result) => {
          resolve({
            currentProject: result.currentProject || null,
            autoCapture: result.autoCapture !== false
          });
        });
      });
    }

    detectCurrentProject() {
      const url = window.location.href;
      const projectMatch = url.match(/\/project\/([a-f0-9-]+)/);
      
      if (projectMatch) {
          const detectedProjectId = projectMatch[1];
          let projectName = 'Unknown Project';
          
          // Look for the project name in the page - Claude displays it as a heading
          const heading = document.querySelector('h1');
          if (heading && heading.textContent && !heading.textContent.includes('How can I help')) {
              projectName = heading.textContent.trim();
          }
          
          // If still unknown, check meta tags or title
          if (projectName === 'Unknown Project') {
              const pageTitle = document.title.split(' - ')[0];
              if (pageTitle && pageTitle.length < 50) {
                  projectName = pageTitle;
              }
          }
          
          console.log('ContextBridge: Detected project:', detectedProjectId, projectName);
          
          this.currentProject = detectedProjectId;
          chrome.storage.sync.set({ 
              currentProject: detectedProjectId,
              currentProjectName: projectName 
          });
          
          return {
              id: detectedProjectId,
              name: projectName !== 'Unknown Project' ? projectName : `Project ${detectedProjectId.substring(0, 8)}...`
          };
      }
      
      return null;
  }

    observeConversation() {
      // Wait for Claude's conversation container to load
      const waitForContainer = setInterval(() => {
        // Claude.ai specific selectors - may need updating
        const container = document.querySelector('div[class*="conversation"]') || 
                         document.querySelector('main');
        
        if (container) {
          clearInterval(waitForContainer);
          this.startObserver(container);
        }
      }, 1000);
    }

    startObserver(container) {
      this.observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === 1) { // Element node
              // Try to capture messages when they appear
              this.tryExtractMessage(node);
            }
          });
        });
      });

      this.observer.observe(container, {
        childList: true,
        subtree: true
      });
    }

    // Replace the captureAllMessages() function in claude.js with this improved version

    captureAllMessages() {
      const messages = [];
      const processedElements = new Set();
      
      console.log('Starting message capture...');
      
      // Strategy 1: Look for conversation turns (most reliable)
      // Claude uses a turn-based structure where each message is in its own section
      const conversationContainer = document.querySelector('div[class*="flex-col"]');
      
      if (conversationContainer) {
        // Get all direct children that look like message containers
        const messageContainers = conversationContainer.querySelectorAll('div[class*="group"]');
        
        messageContainers.forEach((container, index) => {
          // Skip if already processed
          if (processedElements.has(container)) return;
          processedElements.add(container);
          
          // Check for human message (dark background)
          const isHumanMessage = 
            window.getComputedStyle(container).backgroundColor === 'rgb(32, 33, 35)' || // #202123
            window.getComputedStyle(container).backgroundColor === 'rgb(52, 53, 65)' || // #343541
            container.querySelector('div[class*="bg-gray-800"]') ||
            container.querySelector('div[class*="dark:bg-gray-800"]');
          
          // Check for assistant message (slightly lighter background)
          const isAssistantMessage = 
            window.getComputedStyle(container).backgroundColor === 'rgb(68, 70, 84)' || // #444654
            window.getComputedStyle(container).backgroundColor === 'rgb(52, 53, 65)' || // Different shade
            container.querySelector('div[class*="bg-gray-700"]') ||
            container.querySelector('div[class*="dark:bg-gray-700"]');
          
          // Extract text content
          let textContent = '';
          let codeBlocks = [];
          let artifacts = [];
          
          // Look for main text content
          const textElements = container.querySelectorAll('div[class*="markdown"], div[class*="prose"], div[class*="whitespace-pre-wrap"]');
          textElements.forEach(el => {
            // Skip code blocks for separate extraction
            if (!el.closest('pre')) {
              textContent += el.textContent.trim() + '\n';
            }
          });
          
          // Extract code blocks separately
          const codeElements = container.querySelectorAll('pre');
          codeElements.forEach(pre => {
            const codeContent = pre.textContent.trim();
            if (codeContent) {
              // Try to detect language from class or data attributes
              const langClass = pre.className.match(/language-(\w+)/);
              const language = langClass ? langClass[1] : 'unknown';
              
              codeBlocks.push({
                language: language,
                content: codeContent,
                type: 'code_block'
              });
            }
          });
          
          // Extract artifacts (files shown on the right side)
          const artifactElements = container.querySelectorAll('[data-artifact], div[class*="artifact"]');
          artifactElements.forEach(artifact => {
            const fileName = artifact.querySelector('[class*="filename"]')?.textContent || 
                            artifact.getAttribute('data-filename') || 
                            'untitled';
            const content = artifact.querySelector('pre')?.textContent || 
                          artifact.textContent.trim();
            
            if (content) {
              artifacts.push({
                fileName: fileName,
                content: content,
                type: 'artifact'
              });
            }
          });
          
          // Fallback: If no text found with specific selectors, get all text
          if (!textContent.trim() && !isHumanMessage && !isAssistantMessage) {
            textContent = container.textContent.trim();
            // Skip if it's UI elements
            if (textContent.includes('Copy') || 
                textContent.includes('Edit') || 
                textContent.includes('Regenerate') ||
                textContent.length < 10) {
              return;
            }
          }
          
          // Determine role
          let role = 'unknown';
          if (isHumanMessage) {
            role = 'user';
          } else if (isAssistantMessage) {
            role = 'assistant';
          } else {
            // Heuristic: Check position and content
            // User messages typically come first and are shorter
            // Assistant messages are typically longer and contain more formatting
            if (index % 2 === 0) {
              role = 'user';
            } else {
              role = 'assistant';
            }
          }
          
          // Only add if we have actual content
          if (textContent.trim() || codeBlocks.length > 0 || artifacts.length > 0) {
            messages.push({
              role: role,
              content: textContent.trim(),
              codeBlocks: codeBlocks,
              artifacts: artifacts,
              timestamp: new Date().toISOString(),
              index: index
            });
            
            console.log(`Captured ${role} message ${index}: ${textContent.substring(0, 50)}...`);
          }
        });
      }
      
      // Strategy 2: If Strategy 1 didn't work, try alternative selectors
      if (messages.length === 0) {
        console.log('Strategy 1 failed, trying alternative selectors...');
        
        // Look for any divs with substantial text content
        const allDivs = document.querySelectorAll('main div');
        let currentRole = 'user'; // Start with user
        
        allDivs.forEach((div, index) => {
          if (processedElements.has(div)) return;
          
          const text = div.textContent?.trim();
          
          // Skip if too short or too long (likely container)
          if (!text || text.length < 20 || text.length > 50000) return;
          
          // Skip if it contains many child elements (likely a container)
          if (div.children.length > 10) return;
          
          // Skip UI elements
          if (text.includes('Copy code') || 
              text.includes('New chat') || 
              text.includes('Clear chat')) return;
          
          processedElements.add(div);
          
          // Alternate between user and assistant
          messages.push({
            role: currentRole,
            content: text,
            codeBlocks: [],
            artifacts: [],
            timestamp: new Date().toISOString(),
            index: messages.length
          });
          
          // Toggle role
          currentRole = currentRole === 'user' ? 'assistant' : 'user';
        });
      }
      
      // Remove duplicates based on content
      const uniqueMessages = [];
      const seenContent = new Set();
      
      messages.forEach(msg => {
        const contentKey = msg.content.substring(0, 100); // Use first 100 chars as key
        if (!seenContent.has(contentKey)) {
          seenContent.add(contentKey);
          uniqueMessages.push(msg);
        }
      });
      
      console.log(`Captured ${uniqueMessages.length} unique messages`);
      return uniqueMessages;
    }

    // Add this helper function to extract files from messages
    extractFilesFromMessages(messages) {
      const files = [];
      
      messages.forEach((message, msgIndex) => {
        // Extract from code blocks
        message.codeBlocks?.forEach((block, blockIndex) => {
          // Determine file extension based on language
          const extensions = {
            'javascript': 'js',
            'typescript': 'ts', 
            'python': 'py',
            'html': 'html',
            'css': 'css',
            'json': 'json',
            'yaml': 'yml',
            'bash': 'sh',
            'sql': 'sql',
            'markdown': 'md'
          };
          
          const ext = extensions[block.language] || 'txt';
          const fileName = `message_${msgIndex}_block_${blockIndex}.${ext}`;
          
          files.push({
            fileName: fileName,
            content: block.content,
            language: block.language,
            type: 'code',
            messageIndex: msgIndex
          });
        });
        
        // Extract from artifacts
        message.artifacts?.forEach((artifact) => {
          files.push({
            fileName: artifact.fileName,
            content: artifact.content,
            type: 'artifact',
            messageIndex: msgIndex
          });
        });
      });
      
      return files;
    }

    tryExtractMessage(node) {
      if (!this.isCapturing) return;
      
      const message = this.extractMessage(node);
      if (message) {
        this.messages.push(message);
        console.log('Message captured in real-time:', message.role);
      }
    }

    startCapture() {
      this.isCapturing = true;
      this.messages = [];
      this.conversationId = `claude_${Date.now()}`;
      console.log('ContextBridge: Started capturing conversation');
      
      // Show indicator
      this.showCaptureIndicator();
    }

    stopCapture() {
      this.isCapturing = false;
      
      // Try to capture all messages on the page
      const capturedMessages = this.captureAllMessages();
      
      if (capturedMessages.length > 0) {
        this.messages = capturedMessages;
      }
      
      console.log('ContextBridge: Stopped capturing. Messages:', this.messages.length);
      console.log('ContextBridge: Messages captured:', this.messages);
      
      // Process and send all messages to backend
      if (this.messages.length > 0) {
        this.processConversation();
      } else {
        console.warn('ContextBridge: No messages captured!');
        this.showNotification('No messages captured', 'error');
      }
      
      // Hide indicator
      this.hideCaptureIndicator();
    }

    extractMessage(node) {
      // Look for message containers - Claude specific
      if (!node.textContent || node.textContent.trim().length < 2) return null;
      
      // Claude.ai uses specific class patterns
      const messageText = node.textContent.trim();
      
      // Check if this is a complete message div
      const isMessageContainer = 
        node.classList?.contains('font-claude-message') ||
        node.classList?.contains('prose') ||
        node.querySelector('.prose') ||
        node.closest('[data-testid*="conversation"]');
      
      if (!isMessageContainer) return null;
      
      // Try to determine if it's user or assistant
      const isUser = 
        node.closest('[data-testid*="user"]') || 
        node.querySelector('button[aria-label*="Edit"]') ||
        (node.previousElementSibling && node.previousElementSibling.textContent?.includes('You'));
      
      const isAssistant = 
        node.closest('[data-testid*="assistant"]') || 
        node.querySelector('[class*="prose"]') ||
        (!isUser && messageText.length > 50);
      
      if (isUser || isAssistant) {
        console.log(`ContextBridge: Captured ${isUser ? 'user' : 'assistant'} message:`, messageText.substring(0, 50) + '...');
        
        return {
          role: isUser ? 'user' : 'assistant',
          content: messageText,
          timestamp: new Date().toISOString(),
          html: node.innerHTML
        };
      }
      
      return null;
    }

    async processConversation() {
      if (!this.currentProject) {
        console.error('No project selected');
        this.showNotification('Please select a project first', 'error');
        return;
      }

      const payload = {
        projectId: this.currentProject,
        branchId: null, // TODO: Add branch selection
        messages: this.messages,
        conversationId: this.conversationId,
        llmProvider: 'claude'
      };

      try {
        // Ask background.js to do the cross-origin fetch for us
        const res = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            action: 'postToBackend',
            url: 'http://localhost:3001/api/conversations/process',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }, (r) => {
            if (chrome.runtime.lastError) {
              console.error('SW message error:', chrome.runtime.lastError.message);
              resolve(null);
            } else {
              resolve(r);
            }
          });
        });

        if (!res || !res.ok) {
          console.error('Backend error (proxy):', res);
          this.showNotification('Failed to save conversation', 'error');
          return;
        }

        // Try to parse JSON, fall back to text
        let result = {};
        try { result = JSON.parse(res.body); } catch {} // ok if text
        console.log('Conversation processed:', result);
        this.showNotification('Conversation saved successfully!');

      } catch (error) {
        console.error('Failed to process conversation:', error);
        this.showNotification('Failed to save conversation', 'error');
      }
    }

    sendToBackend(message) {
      // Real-time message sending (optional)
      // Could implement WebSocket connection for live updates
    }

    injectContextPanel() {
      // Check if we're starting a new conversation
      const isNewChat = !document.querySelector('[class*="message"]');
      
      if (isNewChat && this.currentProject) {
        this.fetchAndInjectContext();
      }
    }

    async fetchAndInjectContext() {
      // This will be implemented to fetch relevant context and inject it
      console.log('Fetching context for project:', this.currentProject);
    }

    showCaptureIndicator() {
      const indicator = document.createElement('div');
      indicator.id = 'contextbridge-indicator';
      indicator.innerHTML = `
        <div style="position: fixed; top: 10px; right: 10px; z-index: 10000; 
                    background: #ef4444; color: white; padding: 8px 16px; 
                    border-radius: 8px; display: flex; align-items: center; gap: 8px;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.2); cursor: pointer;">
          <div style="width: 8px; height: 8px; background: white; border-radius: 50%; 
                      animation: pulse 2s infinite;"></div>
          <span>Recording - Click to Save</span>
        </div>
        <style>
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
          }
        </style>
      `;
      document.body.appendChild(indicator);

      // Add click handler to the whole indicator
      indicator.addEventListener('click', () => {
        this.stopCapture();
      });
    }

    hideCaptureIndicator() {
      const indicator = document.getElementById('contextbridge-indicator');
      if (indicator) {
        indicator.remove();
      }
    }

    showNotification(message, type = 'success') {
      const notification = document.createElement('div');
      notification.style.cssText = `
        position: fixed; bottom: 20px; right: 20px; z-index: 10000;
        background: ${type === 'success' ? '#10b981' : '#ef4444'};
        color: white; padding: 12px 20px; border-radius: 8px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.2);
        animation: slideIn 0.3s ease;
      `;
      notification.textContent = message;
      document.body.appendChild(notification);

      setTimeout(() => notification.remove(), 3000);
    }

    extractAllConversationUrls() {
      const conversations = [];
      const seenIds = new Set(); // Track IDs we've already seen
      
      // Only look for conversation links in the main content area
      const mainContent = document.querySelector('main') || document.body;
      const links = mainContent.querySelectorAll('a[href*="/chat/"]');
      
      links.forEach(link => {
        const href = link.href || link.getAttribute('href');
        if (href && href.includes('/chat/')) {
          const match = href.match(/\/chat\/([a-f0-9-]+)/);
          if (match) {
            const id = match[1];
            
            // Skip if we've already seen this ID
            if (seenIds.has(id)) {
              return;
            }
            
            seenIds.add(id);
            
            // Get the actual conversation title (not the full text content)
            let title = 'Untitled';
            
            // Try to get just the first line or title element
            const titleElement = link.querySelector('div:first-child') || 
                              link.querySelector('span:first-child');
            if (titleElement) {
              title = titleElement.textContent?.trim() || 'Untitled';
            } else {
              // Fall back to link text but limit length
              const linkText = link.textContent?.trim();
              if (linkText && linkText.length < 100) {
                title = linkText;
              }
            }
            
            conversations.push({
              id: id,
              url: href.startsWith('http') ? href : `https://claude.ai${href}`,
              title: title
            });
          }
        }
      });
      
      console.log('Found unique conversation URLs:', conversations.length, conversations);
      return conversations;
    }

    async captureConversationMessages(conversationId, projectId) {
      console.log('Starting message capture for conversation:', conversationId);
      
      try {
        // Find all message elements on the page
        const messageElements = document.querySelectorAll(
          'div[class*="group/conversation-turn"]:has(.prose)'
        );
        console.log('Found', messageElements.length, 'message elements');
        
        const messages = [];
        
        messageElements.forEach((element, index) => {
          // Look for actual message content
          const contentElement = element.querySelector('.prose, [class*="prose"], [data-message-content]');
          if (!contentElement) return;
          
          const content = contentElement.textContent?.trim();
          if (!content || content.length < 2) return;
          
          // Determine role (user or assistant)
          const isUser = element.classList.toString().includes('user') || 
                        element.querySelector('[data-testid*="user"]') ||
                        index % 2 === 0;
          
          messages.push({
            role: isUser ? 'user' : 'assistant',
            content: content,
            timestamp: new Date().toISOString()
          });
        });
        
        console.log('Captured', messages.length, 'messages');
        
        // Send to backend
        const response = await fetch(`http://localhost:3001/api/conversations/${conversationId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: messages,
            projectId: projectId
          })
        });
        
        if (response.ok) {
          console.log('Messages saved successfully');

          // Update job progress in backend if jobId exists
          if (jobId) {
            console.log('Updating job progress for:', jobId);
            try {
              await fetch(`http://localhost:3001/api/capture/update-progress/${jobId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  conversationId: conversationId,
                  messageCount: messages.length
                })
              });
            } catch (error) {
              console.error('Failed to update job progress:', error);
            }
          }
          
          // Notify extension that capture is complete
          console.log('Sending captureComplete message');
          let result = {};
          try { result = await response.json(); } catch {}
          chrome.runtime.sendMessage({
            action: 'captureComplete',
            conversationId,
            messageCount: messages.length,
            tokenCount: (typeof result?.tokenCount === 'number' ? result.tokenCount : 0),
            projectId
          });

          // Auto-close tab after successful capture
          setTimeout(() => {
            // Send message to background script to close this tab
            chrome.runtime.sendMessage({
              action: 'closeTab'
            });
          }, 2000);
        }
        
      } catch (error) {
        console.error('Capture failed:', error);
      }
    }
  }

  // Initialize capture and FORCE exposure to global window
  const claudeCapture = new ClaudeConversationCapture();

  // Force multiple ways to ensure it's accessible
  window.claudeCapture = claudeCapture;
  window['claudeCapture'] = claudeCapture;
  globalThis.claudeCapture = claudeCapture;

  // Also expose the class itself
  window.ClaudeConversationCapture = ClaudeConversationCapture;

  console.log('ContextBridge: ClaudeConversationCapture instance created');
  console.log('ContextBridge: Testing global access:', window.claudeCapture);

  // Expose ContextBridge namespace with utility functions
  window.ContextBridge = {
    capture: claudeCapture,
    extractAllConversationUrls: () => claudeCapture.extractAllConversationUrls()
  };

  // Final verification
  if (window.claudeCapture) {
    console.log('ContextBridge: Successfully exposed to window');
    
    // Wait for document.head to be ready before injecting script
    if (document.head) {
      /*const script = document.createElement('script');
      script.textContent = `
        window.claudeCapture = {
          isInjected: true,
          status: 'Content script variables cannot be directly accessed from console',
          hint: 'Use chrome.runtime.sendMessage to communicate with the extension'
        };
        console.log('ContextBridge: Injected marker into page context');
      `;
      document.head.appendChild(script);
      script.remove();
      */
      // Just log directly from content script context
      console.log('ContextBridge: Content script initialized (no page injection due to CSP)');
    } else {
      console.log('ContextBridge: document.head not ready for script injection');
      // Don't log as error - this is expected during early initialization
    }
  } else {
    console.error('ContextBridge: FAILED to expose to window');
  }
  console.log('ContextBridge: Initialization complete');
})();
