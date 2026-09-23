-- ---------------------------------------------------------------------------------------------
-- Imported fonts for the formation designer.
--
-- A font an organizer brings is stored exactly like a design image: same bucket, same folder per
-- event, same RLS. Only the accepted mime types change. Keeping it in storage (rather than only in
-- the browser) is what makes a saved design reproducible: `formations.source.fontFamily` names a
-- face the console can load again months later.
-- ---------------------------------------------------------------------------------------------

alter table public.formation_assets drop constraint if exists formation_assets_mime_type_check;
alter table public.formation_assets add constraint formation_assets_mime_type_check
  check (mime_type in (
    'image/png', 'image/svg+xml', 'image/jpeg', 'image/webp',
    'font/ttf', 'font/otf', 'font/woff', 'font/woff2'
  ));

update storage.buckets
set allowed_mime_types = array[
  'image/png', 'image/svg+xml', 'image/jpeg', 'image/webp',
  'font/ttf', 'font/otf', 'font/woff', 'font/woff2'
]
where id = 'formation-assets';

-- An organizer can drop a font imported by mistake. Fonts ONLY: a design image is referenced by
-- every formation version built from it, and a locked version must keep its evidence trail.
drop policy if exists formation_assets_delete on public.formation_assets;
create policy formation_assets_delete on public.formation_assets for delete to authenticated
  using (public.hp_can_manage_event(event_id) and mime_type like 'font/%');
grant delete on public.formation_assets to authenticated;

drop policy if exists formation_assets_remove on storage.objects;
create policy formation_assets_remove on storage.objects for delete to authenticated using (
  bucket_id = 'formation-assets' and public.hp_can_manage_event(public.hp_try_uuid((storage.foldername(name))[1]))
);
