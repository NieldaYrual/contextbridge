// src/env.ts
import path from 'path';
import dotenv from 'dotenv';

// Try package-level .env first; if not found, fall back to repo root .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

const required: string[] = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  // OPENAI_API_KEY is optional if you want to allow keyword-only fallback
];

export const env = {
  SUPABASE_URL: process.env.SUPABASE_URL!,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY!,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
  OPENAI_EMBED_MODEL: process.env.OPENAI_EMBED_MODEL ?? 'text-embedding-3-small',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
};

console.log('OPENAI loaded?', !!process.env.OPENAI_API_KEY);
console.log('ANTHROPIC loaded?', !!process.env.ANTHROPIC_API_KEY);

