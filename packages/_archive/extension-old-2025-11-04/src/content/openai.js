// OpenAI ChatGPT content script
console.log('ContextBridge: ChatGPT detector active');

class OpenAIConversationCapture {
  constructor() {
    this.currentProject = null;
    this.messages = [];
    this.conversationId = null;
    this.isCapturing = false;
    
    this.init();
  }
  
  async init() {
    console.log('OpenAI capture initialized');
    // Similar to Claude capture but with ChatGPT-specific selectors
    // This is a placeholder for now
  }
}

const openaiCapture = new OpenAIConversationCapture();