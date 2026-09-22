-- Organizer-defined access-point types ("pills"): a name, a colour and an optional logo/image,
-- per event, next to the built-in ISO ones. The logo is stored inline as a small PNG data URL
-- (resized to 64×64 by the console, a few KB): no storage bucket or policy to manage, and the
-- map can draw it immediately.

-- Custom symbol keys look like "c3f9a1b2c4d5e": allow digits.
alter table public.event_areas drop constraint if exists event_areas_symbol_check;
alter table public.event_areas add constraint event_areas_symbol_check check (symbol is null or symbol ~ '^[a-z0-9_]{1,40}$');

create table if not exists public.event_symbols (
  id text not null check (id ~ '^c[a-z0-9]{6,39}$'),
  event_id uuid not null references public.events (id) on delete cascade,
  label text not null check (char_length(trim(label)) between 1 and 40),
  color text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  icon text check (icon is null or (icon like 'data:image/png;base64,%' and char_length(icon) <= 60000)),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (event_id, id)
);

alter table public.event_symbols enable row level security;
create policy event_symbols_select on public.event_symbols for select to authenticated
  using (public.hp_can_view_event(event_id));
create policy event_symbols_insert on public.event_symbols for insert to authenticated
  with check (public.hp_can_manage_event(event_id));
create policy event_symbols_update on public.event_symbols for update to authenticated
  using (public.hp_can_manage_event(event_id)) with check (public.hp_can_manage_event(event_id));
create policy event_symbols_delete on public.event_symbols for delete to authenticated
  using (public.hp_can_manage_event(event_id));

revoke all on public.event_symbols from anon, authenticated;
grant select, delete on public.event_symbols to authenticated;
grant insert (id, event_id, label, color, icon) on public.event_symbols to authenticated;
grant update (label, color, icon) on public.event_symbols to authenticated;

-- Deleting a type turns its points back into plain points (they keep their names).
create or replace function public.hp_symbol_deleted() returns trigger
language plpgsql set search_path = public as $$
begin
  update public.event_areas set symbol = null where event_id = old.event_id and symbol = old.id;
  return old;
end;
$$;
revoke all on function public.hp_symbol_deleted() from public, anon, authenticated;
drop trigger if exists event_symbols_deleted on public.event_symbols;
create trigger event_symbols_deleted after delete on public.event_symbols
  for each row execute function public.hp_symbol_deleted();
