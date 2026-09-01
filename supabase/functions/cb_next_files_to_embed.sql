-- Update your existing retry-aware function to support conversation filtering
DROP FUNCTION IF EXISTS cb_next_files_to_embed(uuid, integer);

CREATE OR REPLACE FUNCTION cb_next_files_to_embed(
  p_project uuid, 
  p_limit integer,
  p_conversation text DEFAULT NULL
)
RETURNS TABLE(
  file_id uuid, 
  conversation_id uuid, 
  content text, 
  created_at timestamptz, 
  retry_count integer
)
LANGUAGE sql
STABLE
SET statement_timeout = '10000'
AS $function$
  WITH never_attempted AS (
    SELECT 
      f.id, 
      f.conversation_id, 
      f.content, 
      f.created_at, 
      0 as retry_count
    FROM cb_files f
    LEFT JOIN cb_file_embeddings fe ON fe.cb_file_id = f.id
    WHERE f.project_id = p_project
      AND (p_conversation IS NULL OR f.conversation_id::text = p_conversation)  -- ADD THIS LINE
      AND fe.cb_file_id IS NULL
      AND COALESCE(LENGTH(f.content), 0) > 0
    ORDER BY f.created_at DESC NULLS LAST
    LIMIT GREATEST(1, p_limit)
  ),
  failed_ready_for_retry AS (
    SELECT 
      f.id, 
      f.conversation_id, 
      f.content, 
      f.created_at, 
      fe.retry_count
    FROM cb_files f
    INNER JOIN cb_file_embeddings fe ON fe.cb_file_id = f.id
    WHERE f.project_id = p_project
      AND (p_conversation IS NULL OR f.conversation_id::text = p_conversation)  -- ADD THIS LINE
      AND fe.status = 'failed'
      AND fe.retry_count < 5
      AND COALESCE(LENGTH(f.content), 0) > 0
      AND (
        fe.last_attempted_at IS NULL 
        OR fe.last_attempted_at < NOW() - (POWER(2, fe.retry_count) || ' minutes')::INTERVAL
      )
    ORDER BY fe.last_attempted_at ASC NULLS FIRST
    LIMIT GREATEST(1, p_limit)
  )
  SELECT * FROM never_attempted
  UNION ALL
  SELECT * FROM failed_ready_for_retry
  LIMIT GREATEST(1, p_limit);
$function$;