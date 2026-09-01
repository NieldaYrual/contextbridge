CREATE OR REPLACE FUNCTION public.cb_extract_entities_from_conversation(p_project_id uuid, p_conversation_id uuid, p_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_entity_count INT := 0;
  v_mention_count INT := 0;
  v_entity_id uuid;
  v_entity_record RECORD;
BEGIN
  -- Extract file paths (e.g., src/components/Button.tsx)
  FOR v_entity_record IN
    SELECT DISTINCT
      regexp_matches[1] as entity_name,
      'file' as entity_type
    FROM regexp_matches(p_text, '(?:^|\s|[`''"])((?:[a-zA-Z0-9_-]+/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)', 'g') AS regexp_matches
    WHERE length(regexp_matches[1]) BETWEEN 5 AND 200
  LOOP
    -- Use cb_upsert_entity_mention to create entity AND mention
    -- Note: We don't have message_id here since we're processing full conversation
    -- So we'll create entity but link mention to conversation via message lookup later
    -- For now, just create the entity
    v_entity_id := cb_upsert_entity_mention(
      p_project_id,
      v_entity_record.entity_name,
      v_entity_record.entity_type,
      NULL, -- message_id (will be NULL for conversation-level extraction)
      NULL, -- cb_file_id
      NULL, -- block_id
      substring(p_text, 1, 200) -- snippet
    );
    
    v_entity_count := v_entity_count + 1;
    v_mention_count := v_mention_count + 1;
  END LOOP;

  -- Extract technologies (e.g., React, TypeScript, PostgreSQL)
  FOR v_entity_record IN
    SELECT DISTINCT
      word as entity_name,
      'technology' as entity_type
    FROM (
      SELECT unnest(regexp_matches(p_text, '\b(React|TypeScript|JavaScript|Node\.js|Express|Supabase|PostgreSQL|Python|Django|FastAPI|Vue|Angular|Next\.js|Tailwind|Docker|Kubernetes|AWS|Azure|GCP|MongoDB|Redis|GraphQL|REST|API|SQL|NoSQL|Git|GitHub|GitLab|Vercel|Netlify|Claude|OpenAI|Anthropic|Chrome|Extension)\b', 'gi')) as word
    ) AS words
  LOOP
    v_entity_id := cb_upsert_entity_mention(
      p_project_id,
      v_entity_record.entity_name,
      v_entity_record.entity_type,
      NULL,
      NULL,
      NULL,
      substring(p_text, 1, 200)
    );
    
    v_entity_count := v_entity_count + 1;
    v_mention_count := v_mention_count + 1;
  END LOOP;

  -- Return summary
  RETURN jsonb_build_object(
    'success', true,
    'entities_extracted', v_entity_count,
    'mentions_created', v_mention_count,
    'project_id', p_project_id,
    'conversation_id', p_conversation_id,
    'text_length', length(p_text)
  );
  
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM,
    'project_id', p_project_id,
    'conversation_id', p_conversation_id
  );
END;
$function$
