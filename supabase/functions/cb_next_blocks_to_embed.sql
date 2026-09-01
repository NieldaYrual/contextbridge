DROP FUNCTION IF EXISTS cb_next_blocks_to_embed(uuid, integer);

CREATE OR REPLACE FUNCTION cb_next_blocks_to_embed(
  p_project uuid, 
  p_limit integer,
  p_conversation text DEFAULT NULL  -- ADD
)
RETURNS TABLE(
  block_id uuid, 
  message_id uuid, 
  content text, 
  created_at timestamptz, 
  retry_count integer
)
LANGUAGE sql STABLE
SET statement_timeout = '10000'
AS $function$
  WITH never_attempted AS (
    SELECT b.id, b.message_id, b.content, m.created_at, 0 as retry_count
    FROM cb_blocks b
    INNER JOIN cb_messages m ON m.id = b.message_id
    LEFT JOIN cb_block_embeddings be ON be.block_id = b.id
    WHERE m.project_id = p_project
      AND (p_conversation IS NULL OR m.conversation_id::text = p_conversation)  -- ADD
      AND be.block_id IS NULL
      AND COALESCE(LENGTH(b.content), 0) > 0
    ORDER BY m.created_at DESC NULLS LAST
    LIMIT GREATEST(1, p_limit)
  ),
  failed_ready_for_retry AS (
    SELECT b.id, b.message_id, b.content, m.created_at, be.retry_count
    FROM cb_blocks b
    INNER JOIN cb_messages m ON m.id = b.message_id
    INNER JOIN cb_block_embeddings be ON be.block_id = b.id
    WHERE m.project_id = p_project
      AND (p_conversation IS NULL OR m.conversation_id::text = p_conversation)  -- ADD
      AND be.status = 'failed'
      AND be.retry_count < 5
      AND COALESCE(LENGTH(b.content), 0) > 0
      AND (
        be.last_attempted_at IS NULL 
        OR be.last_attempted_at < NOW() - (POWER(2, be.retry_count) || ' minutes')::INTERVAL
      )
    ORDER BY be.last_attempted_at ASC NULLS FIRST
    LIMIT GREATEST(1, p_limit)
  )
  SELECT * FROM never_attempted
  UNION ALL
  SELECT * FROM failed_ready_for_retry
  LIMIT GREATEST(1, p_limit);
$function$;