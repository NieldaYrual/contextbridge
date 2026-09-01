// Bulk URL extractor for Claude
function extractClaudeConversations() {
  const conversations = [];
  
  // Multiple possible selectors for Claude's UI
  const linkSelectors = [
    'a[href*="/chat/"]',
    'nav a[href*="/chat/"]',
    '[role="navigation"] a[href*="/chat/"]'
  ];
  
  linkSelectors.forEach(selector => {
    document.querySelectorAll(selector).forEach(link => {
      const href = link.href || link.getAttribute('href');
      const text = link.textContent?.trim();
      
      if (href && href.includes('/chat/')) {
        const match = href.match(/\/chat\/([a-f0-9-]+)/);
        if (match) {
          conversations.push({
            id: match[1],
            url: href.startsWith('http') ? href : `https://claude.ai${href}`,
            title: text || 'Untitled'
          });
        }
      }
    });
  });
  
  // Remove duplicates by ID
  const uniqueConvs = Array.from(
    new Map(conversations.map(c => [c.id, c])).values()
  );
  
  return uniqueConvs;
}

// Listen for extraction request
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extractAllConversations') {
    const conversations = extractClaudeConversations();
    sendResponse({ conversations });
  }
});