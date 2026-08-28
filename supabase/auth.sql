-- ─────────────────────────────────────────────────────────────────────────────
-- Fra "personlig app" til "app andre kan hente"
--
-- Kør DENNE fil, når appen skal deles med andre end dig selv – altså før den
-- lægges i Play Store. Kør den EFTER supabase/schema.sql, og kør ikke
-- schema.sql igen bagefter: dens policyer er de åbne, og de ville træde i
-- stedet for de stramme herunder.
--
-- ── Hvorfor ────────────────────────────────────────────────────────────────
--
-- Overvågninger og notifikationer adskilles i dag kun af device_id, et
-- tilfældigt id fra browserens localStorage, og policyen på watches er
-- `for all to anon using (true)`. Det er helt i orden for én husstand, som
-- kommentaren i schema.sql også skriver.
--
-- Men anon-nøglen ligger i enhver APK. I det øjeblik appen kan hentes af
-- fremmede, betyder `using (true)`, at enhver med nøglen kan læse, ændre og
-- slette ALLE brugeres overvågninger – inklusive deres hjemmekoordinater.
--
-- ── Hvad ───────────────────────────────────────────────────────────────────
--
-- Supabase' anonyme login giver hver installation et rigtigt auth.uid() uden
-- at brugeren skal se en loginskærm. Rækkerne knyttes til det i stedet.
--
-- FØR filen køres:
--   Supabase → Authentication → Sign In / Providers → slå "Anonymous sign-ins" til
--
-- Katalogdata (tilbud, varer, opskrifter, priser) er offentlige
-- tilbudsaviser og bliver ved med at være frit læsbare. Det er kun
-- brugerdata, der lukkes.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Kolonner ─────────────────────────────────────────────────────────────

alter table watches       add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table notifications add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table device_tokens add column if not exists user_id uuid references auth.users(id) on delete cascade;

create index if not exists idx_watches_user on watches(user_id);
create index if not exists idx_notif_user   on notifications(user_id);
create index if not exists idx_tokens_user  on device_tokens(user_id);

-- ── 2. Overtagelse af det, der allerede står i basen ────────────────────────
--
-- Dine egne overvågninger er oprettet før login fandtes og har user_id = NULL.
-- Appen overtager dem selv ved første kørsel efter opdateringen: den kender
-- sit gamle device_id fra localStorage og sætter user_id på de rækker, der
-- bærer det. Funktionen herunder er den eneste vej til det – uden den ville
-- policyerne i trin 3 gøre rækkerne usynlige for deres egen ejer.
--
-- Den kan kun sætte user_id på rækker, hvor det ER NULL. Er en række først
-- overtaget, kan et gæt på et andet device_id ikke stjæle den.

create or replace function claim_device(p_device_id text)
returns table (watches_claimed int, notifications_claimed int, tokens_claimed int)
language plpgsql
security definer
set search_path = public
as $$
declare
  w int; n int; t int;
begin
  if auth.uid() is null then
    raise exception 'claim_device kræver et login';
  end if;
  if p_device_id is null or length(p_device_id) < 8 then
    raise exception 'ugyldigt device_id';
  end if;

  update watches set user_id = auth.uid()
   where device_id = p_device_id and user_id is null;
  get diagnostics w = row_count;

  update notifications set user_id = auth.uid()
   where device_id = p_device_id and user_id is null;
  get diagnostics n = row_count;

  update device_tokens set user_id = auth.uid()
   where device_id = p_device_id and user_id is null;
  get diagnostics t = row_count;

  return query select w, n, t;
end;
$$;

revoke all on function claim_device(text) from public;
grant execute on function claim_device(text) to authenticated;

-- ── 3. Policyer ─────────────────────────────────────────────────────────────
--
-- De åbne policyer fra schema.sql fjernes og erstattes. Bemærk at anon-rollen
-- mister adgangen helt: en anonym Supabase-bruger er "authenticated", ikke
-- "anon", så appen rammer stadig de nye policyer.

drop policy if exists watches_all    on watches;
drop policy if exists notif_read     on notifications;
drop policy if exists notif_update   on notifications;
drop policy if exists tokens_write   on device_tokens;
drop policy if exists tokens_update  on device_tokens;

create policy watches_own on watches
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy notif_read_own on notifications
  for select to authenticated
  using (user_id = auth.uid());

-- Kun læst-markeringen må røres fra appen. Selve notifikationerne skrives af
-- den natlige kørsel med service_role-nøglen, som går uden om RLS.
create policy notif_update_own on notifications
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Push-tokens skrives, men læses aldrig af appen: ét token er nok til at
-- sende beskeder til telefonen. Ingen select-policy = ingen læseadgang.
create policy tokens_insert_own on device_tokens
  for insert to authenticated
  with check (user_id = auth.uid());

create policy tokens_update_own on device_tokens
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── 4. Tjek ─────────────────────────────────────────────────────────────────
--
-- Efter kørslen bør denne give præcis de fem policyer ovenfor:
--
--   select tablename, policyname, roles
--     from pg_policies
--    where tablename in ('watches','notifications','device_tokens')
--    order by tablename, policyname;
--
-- Og denne skal give 0, når alle enheder har været forbi appen én gang:
--
--   select count(*) from watches where user_id is null;
