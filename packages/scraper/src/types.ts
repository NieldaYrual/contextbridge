export interface ScraperJob {
  userId: string;
  projectId: string;
  llmProvider: 'claude' | 'openai' | 'grok' | 'gemini';
  projectUrl?: string;
  cookies: any[];
  jobId?: string;
  currentConversation?: string;
  processedCount?: number;
  totalCount?: number;
  options?: {
    maxConversations?: number;
    captureAttachments?: boolean;
  };
}

export interface ConversationLink {
  id: string;
  url: string;
  title?: string;
  timestamp?: string;
}

export interface ConversationData {
  id: string;
  url: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp?: string;
    attachments?: any[];
  }>;
  metadata?: {
    createdAt?: string;
    lastModified?: string;
    messageCount?: number;
  };
}

export interface ScraperProgress {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  currentConversation?: string;
  totalConversations?: number;
  processedConversations?: number;
  errors?: string[];
}