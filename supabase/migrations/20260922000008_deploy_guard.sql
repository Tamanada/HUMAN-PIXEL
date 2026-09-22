-- HUMAN PIXEL: deployment guard. Production migrations are refused while any event is inside its
-- critical window (navigation → photo), see .github/workflows/deploy.yml. Exposes a count only.

create or replace function public.deploy_guard() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.events
  where state in ('PARTICIPANT_NAVIGATION', 'POSITIONING', 'READY', 'LIVE')
     or (state in ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'EVENT_PREPARATION')
         and starts_at between now() - interval '1 hour' and now() + interval '3 hours');
$$;

revoke all on function public.deploy_guard() from public;
grant execute on function public.deploy_guard() to anon, authenticated;
