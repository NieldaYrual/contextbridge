// import { captureClaude } from './claude.js';
import { captureClaudeInteractive } from './claude-interactive.js';

export interface RunnerOptions {
  targetId?: string;
  captureId?: string;
}

export type Runner = (
  projectUrl: string,
  ownerLabel?: string | null,
  opts?: RunnerOptions
) => Promise<void>;

export const ADAPTERS: Record<string, any> = {
  claude: captureClaudeInteractive,  // Use interactive version
  // Add other adapters here when ready:
  // openai: captureOpenAI,
  // anthropic: captureAnthropic,
};