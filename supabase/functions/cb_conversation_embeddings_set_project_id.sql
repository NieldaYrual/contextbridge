CREATE OR REPLACE FUNCTION public.cb_conversation_embeddings_set_project_id()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.project_id is null then
    select c.project_id into new.project_id
    from public.cb_conversations c
    where c.id = new.conversation_id;

    if new.project_id is null then
      raise exception 'Could not derive project_id for conversation_id=%', new.conversation_id;
    end if;
  end if;
  return new;
end;
$function$
