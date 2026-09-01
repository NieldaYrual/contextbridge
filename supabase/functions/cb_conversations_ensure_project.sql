CREATE OR REPLACE FUNCTION public.cb_conversations_ensure_project()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if not exists (select 1 from public.cb_projects pr where pr.id = new.project_id) then
    insert into public.cb_projects (id, name, provider, provider_project_id, created_at)
    values (new.project_id, coalesce(nullif(new.title,''), 'Captured Project'), 'claude', 'claude/auto', now())
    on conflict (id) do nothing;
  end if;
  return new;
end;
$function$
