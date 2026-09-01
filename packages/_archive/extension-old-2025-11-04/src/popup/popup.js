// Function to capture cookies
async function captureCookiesForProject() {
  try {
    const cookies = await chrome.cookies.getAll({ url: 'https://claude.ai/' });
    
    if (cookies.length === 0) {
      alert('Please login to Claude first');
      return null;
    }
    
    const relevantCookies = cookies.filter(cookie => 
      ['sessionKey', 'auth', 'token'].some(key => 
        cookie.name.toLowerCase().includes(key)
      ) || cookie.httpOnly
    );
    
    return relevantCookies;
  } catch (error) {
    console.error('Failed to capture cookies:', error);
    return null;
  }
}

// Batch capturing all conversations in a project
async function captureAllProjectMessages() {
  const projectId = document.getElementById('projectSelect').value;
  const projectName = document.getElementById('projectSelect').options[
    document.getElementById('projectSelect').selectedIndex
  ]?.text;
  
  if (!projectId) {
    alert('Please select a project first');
    return;
  }
  
  const captureBtn = document.getElementById('captureProject');
  captureBtn.disabled = true;
  captureBtn.textContent = 'Starting batch capture...';
  
  try {
    // Step 1: Get all conversation URLs from the backend
    const response = await fetch(`http://localhost:3001/api/projects/${projectId}/conversations`);
    const data = await response.json();
    const conversations = data.conversations || [];
    
    if (conversations.length === 0) {
      alert('No conversations found in this project');
      captureBtn.disabled = false;
      captureBtn.textContent = '📋 Capture All Project Conversations';
      return;
    }
    
    console.log(`Found ${conversations.length} conversations to process`);
    captureBtn.textContent = `Processing ${conversations.length} conversations...`;
    
    // Step 2: Create a batch job on the backend
    const batchResponse = await fetch('http://localhost:3001/api/capture/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: projectId,
        projectName: projectName,
        conversations: conversations.map(c => ({
          id: c.id,
          url: c.url,
          hasMessages: c.message_count > 0
        }))
      })
    });
    
    const batch = await batchResponse.json();
    const batchId = batch.batchId;
    
    // Step 3: Process conversations in chunks to avoid overwhelming
    const CHUNK_SIZE = 5; // Process 5 at a time
    const DELAY_BETWEEN_CHUNKS = 3000; // 3 seconds between chunks
    
    let processed = 0;
    const needsCapture = conversations.filter(c => c.message_count === 0);
    
    for (let i = 0; i < needsCapture.length; i += CHUNK_SIZE) {
      const chunk = needsCapture.slice(i, i + CHUNK_SIZE);
      
      // Process chunk in parallel
      await Promise.all(chunk.map(async (conv) => {
        try {
          // Open conversation in a new tab
          const tab = await chrome.tabs.create({
            url: conv.url,
            active: false
          });
          
          // Wait for page to load
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // Inject content script if needed
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['src/content/claude.js']
          });
          
          // Wait a bit more for script to initialize
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Send message to capture messages
          const response = await chrome.tabs.sendMessage(tab.id, {
            action: 'captureMessagesForConversation',
            conversationId: conv.id,
            projectId: projectId
          });
          
          // Close the tab
          await chrome.tabs.remove(tab.id);
          
          processed++;
          captureBtn.textContent = `Captured ${processed}/${needsCapture.length} conversations...`;
          
          // Update backend with progress
          await fetch(`http://localhost:3001/api/capture/batch/${batchId}/progress`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              conversationId: conv.id,
              status: 'completed',
              processed: processed,
              total: needsCapture.length
            })
          });
          
        } catch (error) {
          console.error(`Failed to capture conversation ${conv.id}:`, error);
          
          // Log failure but continue
          await fetch(`http://localhost:3001/api/capture/batch/${batchId}/progress`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              conversationId: conv.id,
              status: 'failed',
              error: error.message
            })
          });
        }
      }));
      
      // Delay between chunks
      if (i + CHUNK_SIZE < needsCapture.length) {
        captureBtn.textContent = `Waiting before next batch... (${processed}/${needsCapture.length})`;
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_CHUNKS));
      }
    }
    
    // Step 4: Complete the batch
    await fetch(`http://localhost:3001/api/capture/batch/${batchId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        totalProcessed: processed,
        totalConversations: conversations.length,
        capturedNew: needsCapture.length
      })
    });
    
    // Success!
    captureBtn.textContent = `✓ Captured ${processed} conversations!`;
    captureBtn.style.background = '#10b981';
    
    // Open dashboard after 2 seconds
    setTimeout(() => {
      chrome.tabs.create({ 
        url: `http://localhost:3001/project-dashboard?projectId=${projectId}` 
      });
      
      // Reset button
      captureBtn.textContent = '📋 Capture All Project Conversations';
      captureBtn.style.background = '';
      captureBtn.disabled = false;
    }, 2000);
    
  } catch (error) {
    console.error('Batch capture error:', error);
    alert(`Failed to capture conversations: ${error.message}`);
    captureBtn.textContent = '📋 Capture All Project Conversations';
    captureBtn.disabled = false;
  }
}

// Alternative: Manual batch capture with user interaction
async function manualBatchCapture() {
  const projectId = document.getElementById('projectSelect').value;
  
  if (!projectId) {
    alert('Please select a project first');
    return;
  }
  
  // Get conversations needing capture
  const response = await fetch(`http://localhost:3001/api/projects/${projectId}/conversations`);
  const data = await response.json();
  const needsCapture = data.conversations.filter(c => c.message_count === 0);
  
  if (needsCapture.length === 0) {
    alert('All conversations already have messages captured!');
    return;
  }
  
  // Create a simple UI to track progress
  const progressWindow = window.open('', 'CaptureProgress', 'width=600,height=400');
  progressWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Capture Progress</title>
      <style>
        body { font-family: system-ui; padding: 20px; }
        .conversation-item { 
          padding: 10px; 
          margin: 5px 0; 
          border: 1px solid #ccc; 
          border-radius: 5px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .pending { background: #f0f0f0; }
        .capturing { background: #fff3cd; }
        .completed { background: #d4edda; }
        .failed { background: #f8d7da; }
        .status { font-weight: bold; }
      </style>
    </head>
    <body>
      <h2>Manual Batch Capture</h2>
      <p>Click each link to open the conversation, wait for it to load, then the extension will auto-capture.</p>
      <div id="conversations"></div>
      <script>
        let conversations = ${JSON.stringify(needsCapture.map(c => ({
          id: c.id,
          url: c.url,
          title: c.summary,
          status: 'pending'
        })))};
        
        function updateUI() {
          const container = document.getElementById('conversations');
          container.innerHTML = conversations.map(c => \`
            <div class="conversation-item \${c.status}">
              <div>
                <a href="\${c.url}?capture=true&conversationId=\${c.id}&projectId=${projectId}" 
                  target="_blank"
                  onclick="markAsCapturing('\${c.id}')">
                  \${c.title}
                </a>
              </div>
              <div class="status">\${c.status}</div>
            </div>
          \`).join('');
        }
        
        function markAsCapturing(id) {
          const conv = conversations.find(c => c.id === id);
          if (conv) {
            conv.status = 'capturing';
            updateUI();
            
            // Auto-mark as completed after 5 seconds (estimate)
            setTimeout(() => {
              conv.status = 'completed';
              updateUI();
            }, 5000);
          }
        }
        
        window.markAsCapturing = markAsCapturing;
        updateUI();
      </script>
    </body>
    </html>
  `);
}

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const projectSelect = document.getElementById('projectSelect');
  const captureBtn = document.getElementById('captureProject');
  const currentSite = document.getElementById('currentSite');
  // const dashboardLink = document.getElementById('dashboardLink');
  
  // Helper function
  async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }
  
  // Ensure content script is loaded
  async function ensureContentScript(tabId) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: 'getStatus' }, async (response) => {
        if (chrome.runtime.lastError || !response) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ['src/content/claude.js']
            });
            // Wait for script to initialize
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, { action: 'getStatus' }, (r2) => resolve(!!r2));
            }, 150);
          } catch {
            resolve(false);
          }
        } else {
          resolve(true);
        }
      });
    });
  }
  
  // Load project information
  async function loadProject() {
    const tab = await getCurrentTab();
    
    if (!tab || !tab.url) {
      currentSite.textContent = 'No active tab';
      captureBtn.disabled = true;
      return;
    }
    
    if (!tab.url.includes('claude.ai')) {
      projectSelect.innerHTML = '<option value="">Navigate to Claude.ai first</option>';
      currentSite.textContent = 'Not on Claude.ai';
      captureBtn.disabled = true;
      // dashboardLink.style.display = 'none';
      return;
    }
    
    currentSite.textContent = 'Connected to Claude.ai';
    
    // Ensure content script is loaded
    const scriptReady = await ensureContentScript(tab.id);
    if (!scriptReady) {
      projectSelect.innerHTML = '<option value="">Error loading extension</option>';
      captureBtn.disabled = true;
      return;
    }
    
    // Get project info
    chrome.tabs.sendMessage(tab.id, { action: 'getStatus' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Error getting project:', chrome.runtime.lastError);
        projectSelect.innerHTML = '<option value="">Error detecting project</option>';
        captureBtn.disabled = true;
        return;
      }
      
      if (response && response.currentProject) {
        const projectName = response.projectName || 'Unknown Project';
        const projectId = response.currentProject;
        
        projectSelect.innerHTML = `<option value="${projectId}">${projectName}</option>`;
        captureBtn.disabled = false;
        
        // Show dashboard link
        // dashboardLink.href = `http://localhost:3001/project-dashboard?projectId=${projectId}`;
        // dashboardLink.style.display = 'block';
      } else {
        projectSelect.innerHTML = '<option value="">No project detected</option>';
        captureBtn.disabled = true;
        // dashboardLink.style.display = 'none';
      }
    });
  }
  
  // Main capture button handler
  if (captureBtn) {
    captureBtn.addEventListener('click', async () => {
      const projectId = projectSelect.value;
      const projectName = projectSelect.options[projectSelect.selectedIndex]?.text;
      
      if (!projectId) {
        alert('Please select a project first');
        return;
      }
      
      captureBtn.disabled = true;
      const originalText = captureBtn.textContent;
      captureBtn.textContent = 'Expanding conversations...';
      
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        // Execute script to expand all conversations and extract URLs
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async () => {
            console.log('Starting conversation capture...');
            
            // Function to click "Show More" until all conversations are loaded
            async function expandAllConversations() {
              let showMoreBtn;
              let clickCount = 0;
              const maxClicks = 50; // Safety limit for very large projects
              
              do {
                // Find the "Show More" button - Claude uses various text
                showMoreBtn = Array.from(document.querySelectorAll('button')).find(btn => {
                  const text = btn.textContent.toLowerCase();
                  return text.includes('show more') || 
                         text.includes('load more') || 
                         text.includes('show all');
                });
                
                if (showMoreBtn && !showMoreBtn.disabled) {
                  showMoreBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  showMoreBtn.click();
                  clickCount++;
                  console.log(`Clicked Show More button ${clickCount} times`);
                  
                  // Wait for content to load
                  await new Promise(resolve => setTimeout(resolve, 1500));
                }
              } while (showMoreBtn && !showMoreBtn.disabled && clickCount < maxClicks);
              
              return clickCount;
            }
            
            // Expand all conversations
            const expansions = await expandAllConversations();
            console.log(`Expanded ${expansions} times to load all conversations`);
            
            // Now extract all URLs
            const allChatLinks = document.querySelectorAll('a[href*="/chat/"]');
            console.log(`Found ${allChatLinks.length} total chat links`);
            
            // Filter to only main content (exclude sidebar)
            const mainContent = document.querySelector('main');
            const sidebar = document.querySelector('nav');
            
            const urls = [];
            const seenIds = new Set();
            
            allChatLinks.forEach(link => {
              // Only include if in main content and not in sidebar
              const inMain = mainContent ? mainContent.contains(link) : true;
              const inSidebar = sidebar ? sidebar.contains(link) : false;
              
              if (inMain && !inSidebar) {
                const href = link.href;
                const match = href.match(/\/chat\/([a-f0-9-]+)/);
                
                if (match && !seenIds.has(match[1])) {
                  seenIds.add(match[1]);
                  
                  // Clean up the title
                  let title = link.textContent.trim();
                  title = title.replace(/Last message.*$/, '').trim();
                  title = title.replace(/\n.*$/, '').trim(); // Remove any secondary lines
                  
                  urls.push({
                    id: match[1],
                    url: href,
                    title: title || 'Untitled Conversation'
                  });
                }
              }
            });
            
            console.log(`Extracted ${urls.length} unique conversation URLs`);
            return urls;
          }
        });
        
        const urls = results[0]?.result;
        
        if (!urls || urls.length === 0) {
          alert('No conversations found in this project');
          captureBtn.textContent = originalText;
          captureBtn.disabled = false;
          return;
        }
        
        console.log(`Captured ${urls.length} conversation URLs`);
        captureBtn.textContent = `Saving ${urls.length} conversations...`;
        
        // Send to backend
        const response = await fetch('http://localhost:3001/api/capture/urls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: projectId,
            projectName: projectName,
            conversations: urls,
            llmProvider: 'claude'
          })
        });
        
        if (!response.ok) {
          throw new Error(`Server error: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Success!
        captureBtn.textContent = `✓ ${urls.length} Conversations Captured!`;
        captureBtn.style.background = '#10b981';
        
        // Open dashboard after 2 seconds
        setTimeout(() => {
          chrome.tabs.create({ 
            url: `http://localhost:3001/project-dashboard?projectId=${projectId}` 
          });
          
          // Reset button
          captureBtn.textContent = originalText;
          captureBtn.style.background = '';
          captureBtn.disabled = false;
        }, 2000);
        
      } catch (error) {
        console.error('Capture error:', error);
        alert(`Failed to capture conversations: ${error.message}`);
        captureBtn.textContent = originalText;
        captureBtn.disabled = false;
      }
    });
  }
  
  // Initialize on load
  await loadProject();
  
  // Refresh project detection every 5 seconds
  setInterval(loadProject, 5000);
});

  