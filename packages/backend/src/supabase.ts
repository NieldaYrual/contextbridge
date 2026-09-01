// packages/backend/src/supabase.ts
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  const mask = (s: string) => (s ? s.slice(0, 8) + '…' + s.slice(-6) : '(empty)');
  console.error('[supabase cfg] url=', SUPABASE_URL, ' key=', mask(SUPABASE_SERVICE_ROLE));
  throw new Error('Missing Supabase envs (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
  global: { headers: { Accept: 'application/json' } },
});
