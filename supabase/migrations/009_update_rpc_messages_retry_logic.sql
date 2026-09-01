-- Migration: Update cb_next_messages_to_embed with retry logic
-- Date: 2025-11-14
-- Purpose: Support exponential backoff retry for failed embeddings

-- Drop the old function first (return type changed)
DROP FUNCTION IF EXISTS cb_next_messages_to_embed(uuid, integer);

-- Create the updated function with retry logic
CREATE OR REPLACE FUNCTION cb_next_messages_to_embed(p_project uuid, p_limit integer)
RETURNS TABLE(message_id uuid, conversation_id uuid, content text, created_at timestamptz, retry_count integer)
LANGUAGE sql STABLE
SET statement_timeout = '10000'
AS $function$
  WITH never_attempted AS (
    -- Priority 1: Messages with no embedding record yet (never attempted)
    SELECT m.id, m.conversation_id, m.content, m.created_at, 0 as retry_count
    FROM cb_messages m
    LEFT JOIN cb_message_embeddings me ON me.message_id = m.id
    WHERE m.project_id = p_project
      AND me.message_id IS NULL
      AND COALESCE(LENGTH(m.content), 0) > 0
    ORDER BY m.created_at DESC NULLS LAST
    LIMIT GREATEST(1, p_limit)
  ),
  failed_ready_for_retry AS (
    -- Priority 2: Failed embeddings ready for retry (exponential backoff passed)
    SELECT m.id, m.conversation_id, m.content, m.created_at, me.retry_count
    FROM cb_messages m
    INNER JOIN cb_message_embeddings me ON me.message_id = m.id
    WHERE m.project_id = p_project
      AND me.status = 'failed'
      AND me.retry_count < 5
      AND COALESCE(LENGTH(m.content), 0) > 0
      AND (
        me.last_attempted_at IS NULL 
        OR me.last_attempted_at < NOW() - (POWER(2, me.retry_count) || ' minutes')::INTERVAL
      )
    ORDER BY me.last_attempted_at ASC NULLS FIRST
    LIMIT GREATEST(1, p_limit)
  )
  SELECT * FROM never_attempted
  UNION ALL
  SELECT * FROM failed_ready_for_retry
  LIMIT GREATEST(1, p_limit);
$function$;