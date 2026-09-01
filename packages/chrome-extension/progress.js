// progress.js - Updated to support capture and embedding progress
let totalConversations = 0;
let currentConversation = 0;

// Listen for both old and new message types
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CAPTURE_PROGRESS' || message.type === 'PROGRESS_UPDATE') {
    updateProgress(message.data);
    sendResponse({received: true});
  }
  return true;
});

function updateProgress(data) {
  const statusLog = document.getElementById('statusLog');
  const progressFill = document.getElementById('progressFill');
  const etaContainer = document.getElementById('etaContainer');
  
  // --- ETA State Machine ---
  if (data.status === 'embedding' || data.breakdown) {
    if (data.embeddingEtaMins !== undefined && data.embeddingEtaMins !== null) {
      etaContainer.textContent = `Embedding ETA: ~${data.embeddingEtaMins} min`;
    } else {
      etaContainer.textContent = `Embedding Generation in Progress...`;
    }
  } else if (data.status === 'complete' || data.status === 'error') {
    etaContainer.textContent = '';
  } else if (data.captureEtaMins !== undefined) {
    etaContainer.textContent = `Capture ETA: ~${data.captureEtaMins} min`;
  }

  // Clear initial message if this is the first real update
  if (statusLog.children.length === 1 && statusLog.children[0].textContent.includes('Capture starting')) {
    statusLog.innerHTML = '';
  }
  
  // Add status line
  if (data.message) {
    const statusLine = document.createElement('div');
    statusLine.className = 'status-line';
    
    if (data.status === 'complete') {
      statusLine.className += ' complete';
      statusLine.innerHTML = '✅ ' + data.message;
    } else if (data.status === 'error') {
      statusLine.className += ' error';
      statusLine.innerHTML = '❌ ' + data.message;
    } else {
      statusLine.innerHTML = data.message;
    }
    
    statusLog.appendChild(statusLine);
    statusLog.scrollTop = statusLog.scrollHeight;
  }
  
  // Show embedding breakdown if provided
  if (data.breakdown) {
    const b = data.breakdown;
    
    const oldEmbedding = statusLog.querySelector('[data-embedding]');
    if (oldEmbedding) oldEmbedding.remove();
    
    const embedLine = document.createElement('div');
    embedLine.className = 'status-line';
    embedLine.setAttribute('data-embedding', 'true');
    embedLine.innerHTML = `
      <div style="font-family: monospace; font-size: 12px; line-height: 1.8; margin-top: 5px;">
        📝 Messages: ${b.messages.embedded}/${b.messages.total} (${Math.round(b.messages.embedded/b.messages.total*100)}%)<br>
        📁 Files: ${b.files.embedded}/${b.files.total} (${Math.round(b.files.embedded/b.files.total*100)}%)<br>
        📦 Blocks: ${b.blocks.embedded}/${b.blocks.total} (${Math.round(b.blocks.embedded/b.blocks.total*100)}%)<br>
        💬 Conversations: ${b.conversations.embedded}/${b.conversations.total} (${Math.round(b.conversations.embedded/b.conversations.total*100)}%)
        ${b.entities ? `<br>🏷️ Entities: ${b.entities.total}` : ''}
      </div>
    `;
    
    statusLog.appendChild(embedLine);
    statusLog.scrollTop = statusLog.scrollHeight;
    
    const totalItems = b.messages.total + b.files.total + b.blocks.total + b.conversations.total;
    const embeddedItems = b.messages.embedded + b.files.embedded + b.blocks.embedded + b.conversations.embedded;
    const percentage = totalItems > 0 ? Math.round((embeddedItems / totalItems) * 100) : 0;
    progressFill.style.width = percentage + '%';
    progressFill.textContent = percentage + '%';
  }
  
  if (data.total) totalConversations = data.total;
  
  if (data.current !== undefined && !data.breakdown) {
    currentConversation = data.current;
    const percentage = totalConversations > 0 
      ? Math.round((currentConversation / totalConversations) * 100) 
      : 0;
    progressFill.style.width = percentage + '%';
    progressFill.textContent = percentage + '%';
  }
  
  // Close window after delay if complete
  if (data.status === 'complete' && data.autoClose) {
    setTimeout(() => window.close(), 3000);
  }
}
