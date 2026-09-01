CREATE OR REPLACE FUNCTION public.cb_embedding_progress(p_project_id uuid)
 RETURNS TABLE(project_id uuid, msg_total bigint, msg_pending bigint, file_total bigint, file_pending bigint, block_total bigint, block_pending bigint)
 LANGUAGE sql
AS $function$
  with
  m_tot as (
    select count(*)::bigint cnt from public.cb_messages where project_id = p_project_id
  ),
  m_pen as (
    select count(*)::bigint cnt from public.v_cb_messages_needing_embeddings where project_id = p_project_id
  ),
  f_tot as (
    select count(*)::bigint cnt from public.cb_files where project_id = p_project_id
  ),
  f_pen as (
    select count(*)::bigint cnt from public.v_cb_files_needing_embeddings where project_id = p_project_id
  ),
  b_tot as (
    select count(*)::bigint cnt
    from public.cb_blocks b
    join public.cb_messages m on m.id = b.message_id
    where m.project_id = p_project_id
  ),
  b_pen as (
    select count(*)::bigint cnt from public.v_cb_blocks_needing_embeddings where project_id = p_project_id
  )
  select
    p_project_id,
    (select cnt from m_tot)   as msg_total,
    (select cnt from m_pen)   as msg_pending,
    (select cnt from f_tot)   as file_total,
    (select cnt from f_pen)   as file_pending,
    (select cnt from b_tot)   as block_total,
    (select cnt from b_pen)   as block_pending;
$function$
