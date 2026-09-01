-- Migration: Update cb_next_conversations_to_embed with retry logic
-- Date: 2025-11-14
-- Purpose: Support exponential backoff retry for failed embeddings

-- ============================================
-- UPDATE cb_next_conversations_to_embed
-- ============================================
DROP FUNCTION IF EXISTS cb_next_conversations_to_embed(uuid, integer);

CREATE OR REPLACE FUNCTION cb_next_conversations_to_embed(p_project uuid, p_limit integer)
RETURNS TABLE(conversation_id uuid, title text, summary text, created_at timestamptz, retry_count integer)
LANGUAGE sql STABLE
SET statement_timeout = '10000'
AS $function$
  WITH never_attempted AS (
    SELECT c.id, c.title, c.summary, c.created_at, 0 as retry_count
    FROM cb_conversations c
    LEFT JOIN cb_conversation_embeddings ce ON ce.conversation_id = c.id
    WHERE c.project_id = p_project
      AND ce.conversation_id IS NULL
      AND (COALESCE(LENGTH(c.title), 0) > 0 OR COALESCE(LENGTH(c.summary), 0) > 0)
    ORDER BY c.created_at DESC NULLS LAST
    LIMIT GREATEST(1, p_limit)
  ),
  failed_ready_for_retry AS (
    SELECT c.id, c.title, c.summary, c.created_at, ce.retry_count
    FROM cb_conversations c
    INNER JOIN cb_conversation_embeddings ce ON ce.conversation_id = c.id
    WHERE c.project_id = p_project
      AND ce.status = 'failed'
      AND ce.retry_count < 5
      AND (COALESCE(LENGTH(c.title), 0) > 0 OR COALESCE(LENGTH(c.summary), 0) > 0)
      AND (
        ce.last_attempted_at IS NULL 
        OR ce.last_attempted_at < NOW() - (POWER(2, ce.retry_count) || ' minutes')::INTERVAL
      )
    ORDER BY ce.last_attempted_at ASC NULLS FIRST
    LIMIT GREATEST(1, p_limit)
  )
  SELECT * FROM never_attempted
  UNION ALL
  SELECT * FROM failed_ready_for_retry
  LIMIT GREATEST(1, p_limit);
$function$;