export interface NormalizedMessage {
  providerMessageId?: string;
  role: 'user' | 'assistant' | 'system';
  content?: string;
  blocks?: Array<{
    kind: string;
    language?: string;
    fileName?: string;
    content?: string;
  }>;
  timestamp?: string;
}

export interface NormalizedThread {
  provider: string;
  providerConversationId: string;
  title?: string;
  startedAt?: string;
  lastActivityAt?: string;
  messages: NormalizedMessage[];
}

export interface CaptureTarget {
  id: string;
  provider: string;
  project_url: string;
  owner_label?: string | null;
}
