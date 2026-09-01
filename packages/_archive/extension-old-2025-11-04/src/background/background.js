// src/background/background.js - Complete file with external messaging
/*
console.log('ContextBridge background service initialized');

// Track injected tabs
const injectedTabs = new Set();
// Track active capture jobs
const activeCaptureJobs = new Map();

chrome.runtime.onInstalled.addListener(() => {
  console.log('ContextBridge installed');
  chrome.storage.sync.set({ currentProject: null, autoCapture: true });
});

// Clean up tracking when tab is removed
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
});

// Only inject once per tab
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && 
      tab.url && 
      /https:\/\/(.*\.)?claude\.ai\//.test(tab.url) &&
      !injectedTabs.has(tabId)) {
    
    try {
      const response = await chrome.tabs.sendMessage(tabId, { action: 'getStatus' }).catch(() => null);
      
      if (response) {
        injectedTabs.add(tabId);
        return;
      }
      
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/content/claude.js']
      });
      
      injectedTabs.add(tabId);
      console.log('Injected content script into tab:', tabId);
      
    } catch (error) {
      console.log('Script already injected or error:', error.message);
    }
  }
});

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Handle tab closing
  if (request.action === 'closeTab' && sender.tab) {
    chrome.tabs.remove(sender.tab.id);
  }
  
  // Handle CORS bypass for localhost backend
  if (request.action === 'postToBackend') {
    fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body
    })
    .then(response => response.text())
    .then(body => sendResponse({ ok: true, body }))
    .catch(error => sendResponse({ ok: false, error: error.message }));
    
    return true; // Keep channel open for async response
  }

  // Handle capture completion
  if (request.action === 'captureComplete' && sender.tab) {
    console.log(`Closing tab after successful capture: ${request.conversationId}`);
    
    // Extract job info from the URL
    const url = new URL(sender.tab.url);
    const conversationId = url.searchParams.get('conversationId');
    const projectId = url.searchParams.get('projectId');

    console.log('Looking for job with projectId:', projectId);
    console.log('Active jobs:', Array.from(activeCaptureJobs.entries()));
    
    // Find the active job for this project
    let jobToUpdate = null;
    for (const [jobId, job] of activeCaptureJobs.entries()) {
      console.log('Checking job:', jobId, 'with projectId:', job.projectId);
      if (job.projectId === projectId) {
        jobToUpdate = job;
        break;
      }
    }
    
    if (jobToUpdate) {
      console.log('Found job to update:', jobToUpdate.id);
      // Do not increment here — processBatchCapture() already advanced counts.
      // We still ping the dashboard so the modal stays responsive.
      sendProgressUpdate(jobToUpdate);

      // Update backend
      fetch(`http://localhost:3001/api/capture/update-progress/${jobToUpdate.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          processed: jobToUpdate.processed,
          status: jobToUpdate.processed >= jobToUpdate.total ? 'completed' : 'active'
        })
      });
      
      // Check if job is complete
      if (jobToUpdate.processed >= jobToUpdate.total) {
        jobToUpdate.status = 'completed';
        sendProgressUpdate(jobToUpdate);
      }
    } else {
      console.log('No job found for projectId:', projectId);
    }
    
    // Close the tab (moved outside the if/else)
    chrome.tabs.remove(sender.tab.id);
  }
});

// EXTERNAL MESSAGING - Listen for messages from dashboard at localhost:3001
chrome.runtime.onMessageExternal.addListener(
  function(request, sender, sendResponse) {
    console.log('External message received:', request.action, 'from:', sender.origin);
    
    // Verify the sender is our dashboard
    if (!sender.origin || !sender.origin.includes('localhost:3001')) {
      sendResponse({ error: 'Unauthorized origin' });
      return;
    }
    
    switch(request.action) {
      case 'startBatchCapture':
        // Don't call the function, handle it inline
        const { conversations, projectId } = request;
        const jobId = `job_${Date.now()}`;
        
        const job = {
          id: jobId,
          projectId: projectId,
          status: 'running',
          progress: 0,
          total: conversations.length,
          processed: 0,
          failed: 0,
          cancelled: false,
          details: [],
          senderId: sender.tab?.id
        };
        
        activeCaptureJobs.set(jobId, job);
        
        // Also create job in backend so dashboard can poll it
        fetch('http://localhost:3001/api/capture/create-job', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversations: conversations,
            projectId: projectId
          })
        });
        
        // Send response immediately
        sendResponse({
          success: true,
          jobId: jobId,
          total: conversations.length
        });
        
        // Start processing in background
        processBatchCapture(job, conversations, projectId);
        break;
        
      case 'cancelCapture':
        const jobToCancel = activeCaptureJobs.get(request.jobId);
        if (jobToCancel) {
          jobToCancel.cancelled = true;
          activeCaptureJobs.delete(request.jobId);
          sendResponse({ success: true });
        } else {
          sendResponse({ error: 'Job not found' });
        }
        break;
        
      default:
        sendResponse({ error: 'Unknown action' });
    }
  }
);

// Handle batch capture request from dashboard
async function handleExternalBatchCapture(request, sender, sendResponse) {
  console.log('handleExternalBatchCapture called with:', request);
  const { conversations, projectId } = request;
  const jobId = `job_${Date.now()}`;
  
  console.log('Creating job:', jobId, 'for', conversations.length, 'conversations');
  
  // Create job tracking
  const job = {
    id: jobId,
    status: 'running',
    progress: 0,
    total: conversations.length,
    processed: 0,
    failed: 0,
    cancelled: false,
    details: [],
    senderId: sender.tab?.id
  };
  
  activeCaptureJobs.set(jobId, job);
  
  // Send response IMMEDIATELY (before any async operations)
  sendResponse({
    success: true,
    jobId: jobId,
    total: conversations.length
  });
  
  // Start processing AFTER sending response
  // Don't await this - let it run in background
  processBatchCapture(job, conversations, projectId);
}

// Process batch capture
async function processBatchCapture(job, conversations, projectId) {
  job.projectId = projectId;
  const CHUNK_SIZE = 3;
  const DELAY_BETWEEN_CAPTURES = 2000;
  
  for (let i = 0; i < conversations.length && !job.cancelled; i += CHUNK_SIZE) {
    const chunk = conversations.slice(i, i + CHUNK_SIZE);
    
    // Process chunk
    const chunkResults = await Promise.all(
      chunk.map(conv => captureConversationInBackground(conv, projectId))
    );
    
    // Update job progress
    job.processed += chunk.length;
    job.progress = Math.round((job.processed / job.total) * 100);
    job.details.push(...chunkResults);
    
    // Count failures
    job.failed = job.details.filter(d => d.status === 'failed').length;
    
    // Send progress update to dashboard
    sendProgressUpdate(job);
    
    // Delay between chunks
    if (i + CHUNK_SIZE < conversations.length && !job.cancelled) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_CAPTURES));
    }
  }
  
  // Mark job as complete
  job.status = job.cancelled ? 'cancelled' : 'completed';
  sendProgressUpdate(job);
  
  // Clean up job after 5 minutes
  setTimeout(() => {
    activeCaptureJobs.delete(job.id);
  }, 5 * 60 * 1000);
}

// Capture a single conversation in background tab
async function captureConversationInBackground(conv, projectId) {
  return new Promise((resolve) => {
    // Create hidden tab
    chrome.tabs.create({
      url: `${conv.url}?capture=true&conversationId=${conv.id}&projectId=${projectId}`,
      active: false,
      pinned: true
    }, (tab) => {
      const timeoutId = setTimeout(async () => {
        try {
          // Try to get capture status
          const response = await chrome.tabs.sendMessage(tab.id, {
            action: 'getCaptureStatus'
          }).catch(() => null);
          
          // Close tab
          chrome.tabs.remove(tab.id).catch(() => {});
          
          resolve({
            conversationId: conv.id,
            status: response ? 'success' : 'timeout',
            messageCount: response?.messageCount || 0,
            timestamp: new Date().toISOString()
          });
        } catch (error) {
          chrome.tabs.remove(tab.id).catch(() => {});
          resolve({
            conversationId: conv.id,
            status: 'failed',
            error: error.message,
            timestamp: new Date().toISOString()
          });
        }
      }, 7000); // 7 seconds per conversation
      
      // Listen for explicit completion
      const messageListener = (request, sender) => {
        if (sender.tab?.id === tab.id && request.action === 'captureComplete') {
          clearTimeout(timeoutId);
          chrome.tabs.remove(tab.id).catch(() => {});
          chrome.runtime.onMessage.removeListener(messageListener);
          
          resolve({
            conversationId: conv.id,
            status: 'success',
            messageCount: request.messageCount,
            timestamp: new Date().toISOString()
          });
        }
      };
      
      chrome.runtime.onMessage.addListener(messageListener);
    });
  });
}

// After conversation capture succeeds, trigger embedding generation
async function triggerEmbeddings(projectId, conversationId) {
  console.log('🎨 Auto-generating embeddings for new conversation...');
  
  try {
    // Embed the messages from this conversation
    const msgResponse = await fetch(`${BACKEND_URL}/api/context/_backfill/embeddings/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        projectId, 
        conversationId, // NEW: only embed this specific conversation
        limit: 50 
      })
    });
    
    if (msgResponse.ok) {
      const result = await msgResponse.json();
      console.log(`✅ Auto-embedded ${result.inserted} messages`);
    }
  } catch (e) {
    console.warn('⚠️ Auto-embedding failed (non-critical):', e.message);
  }
}

// Send progress update to dashboard
function sendProgressUpdate(job) {
  console.log('Sending progress update:', job.id, job.progress + '%');
  
  // Send to all tabs that might be listening
  chrome.tabs.query({ url: 'http://localhost:3001/*' }, (tabs) => {
    console.log('Found dashboard tabs:', tabs.length);
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        type: 'CAPTURE_PROGRESS',
        jobId: job.id,
        progress: job.progress,
        processed: job.processed,
        total: job.total,
        failed: job.failed,
        status: job.status
      }).catch((error) => {
        console.error('Failed to send to tab:', tab.id, error);
      });
    });
  });
}

// Add new function to poll embedding status
async function pollEmbeddingStatus(projectId, conversationId, totalConversations) {
  console.log(`[Embedding] Starting to poll status for ${conversationId}`);
  
  let lastPercentage = 0;
  const maxAttempts = 60; // Poll for up to 60 attempts (3 minutes at 3s intervals)
  let attempts = 0;
  
  const pollInterval = setInterval(async () => {
    attempts++;
    
    try {
      const response = await fetch(
        `${BACKEND_URL}/api/context/_embed-status/${projectId}/${conversationId}`
      );
      
      if (!response.ok) {
        console.warn('[Embedding] Status check failed:', response.status);
        return;
      }
      
      const status = await response.json();
      console.log(`[Embedding] Status:`, status);
      
      // Update progress
      if (status.percentage !== lastPercentage) {
        lastPercentage = status.percentage;
        
        sendProgressUpdate(
          `🎨 Generating embeddings: ${status.embedded}/${status.total} (${status.percentage}%)`,
          status.percentage,
          totalConversations,
          totalConversations
        );
      }
      
      // Check if complete
      if (status.isComplete || attempts >= maxAttempts) {
        clearInterval(pollInterval);
        
        if (status.isComplete) {
          console.log('[Embedding] ✅ Complete!');
          sendProgressUpdate(
            `✅ Embeddings complete! Conversation is now searchable.`,
            100,
            totalConversations,
            totalConversations
          );
          
          // Close modal after 2 seconds
          setTimeout(() => {
            chrome.runtime.sendMessage({
              type: 'CLOSE_PROGRESS'
            });
          }, 2000);
        } else {
          console.warn('[Embedding] Timeout reached, stopping poll');
          sendProgressUpdate(
            `⚠️ Embedding taking longer than expected. Check dashboard.`,
            100,
            totalConversations,
            totalConversations
          );
          
          setTimeout(() => {
            chrome.runtime.sendMessage({
              type: 'CLOSE_PROGRESS'
            });
          }, 3000);
        }
      }
      
    } catch (error) {
      console.error('[Embedding] Poll error:', error);
    }
  }, 3000); // Poll every 3 seconds
}

// Clean up orphaned tabs on startup
chrome.runtime.onStartup.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: '*://claude.ai/*' });
  for (const tab of tabs) {
    if (tab.url?.includes('capture=true')) {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
});
*/