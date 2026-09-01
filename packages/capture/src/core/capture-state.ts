// src/core/capture-state.ts - SIMPLIFIED VERSION
import { supabase } from './supabase.js';

export async function getLastCaptureTime(projectUrl: string): Promise<Date | null> {
  const { data, error } = await supabase
    .from('cb_captures')
    .select('finished_at')
    .eq('status', 'success')
    .order('finished_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data?.finished_at) return null;
  return new Date(data.finished_at);
}

export async function getConversationUpdateTimes(): Promise<Map<string, Date>> {
  const { data, error } = await supabase
    .from('cb_conversations')
    .select('provider_conversation_id, last_activity_at')
    .eq('provider', 'claude');

  if (error) throw error;

  const updateTimes = new Map<string, Date>();
  for (const conv of data || []) {
    if (conv.last_activity_at) {
      updateTimes.set(conv.provider_conversation_id, new Date(conv.last_activity_at));
    }
  }
  
  return updateTimes;
}