-- Quaderno: accesso su approvazione.
-- Chiunque può registrarsi, ma la registrazione crea solo una richiesta "pending".
-- Le note sono accessibili solo agli utenti approvati dall'amministratore.
-- Idempotente: può essere rieseguita.

-- ---------------------------------------------------------------------------
-- Amministratori (per email). Non esposta al client.
-- ---------------------------------------------------------------------------
create table if not exists public.app_admins (
  email text primary key check (email = lower(email))
);
alter table public.app_admins enable row level security;
revoke all on table public.app_admins from anon, authenticated;

insert into public.app_admins (email) values ('nazzareno.lamanna@gmail.com')
on conflict (email) do nothing;

-- ---------------------------------------------------------------------------
-- Richieste di accesso: una riga per utente, creata alla registrazione.
-- ---------------------------------------------------------------------------
create table if not exists public.access_requests (
  user_id     uuid        primary key references auth.users (id) on delete cascade,
  email       text        not null default '',
  status      text        not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  uuid        references auth.users (id) on delete set null
);
create index if not exists access_requests_status_idx on public.access_requests (status, created_at desc);

-- ---------------------------------------------------------------------------
-- Funzioni di controllo (security definer: leggono auth.users / app_admins
-- senza esporle). Un admin deve avere l'email confermata.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    join public.app_admins a on a.email = lower(u.email)
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
  );
$$;

create or replace function public.is_approved()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin() or exists (
    select 1 from public.access_requests r
    where r.user_id = auth.uid() and r.status = 'approved'
  );
$$;

revoke all on function public.is_admin() from public, anon;
revoke all on function public.is_approved() from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_approved() to authenticated;

-- ---------------------------------------------------------------------------
-- Alla registrazione: crea la richiesta (gli admin sono approvati subito).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  admin boolean := exists (select 1 from public.app_admins a where a.email = lower(new.email));
begin
  insert into public.access_requests (user_id, email, status, decided_at)
  values (new.id, coalesce(lower(new.email), ''), case when admin then 'approved' else 'pending' end, case when admin then now() end)
  on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function public.handle_new_user_access() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_access on auth.users;
create trigger on_auth_user_created_access
  after insert on auth.users
  for each row execute function public.handle_new_user_access();

-- Utenti già registrati prima di questa migration: admin approvati, gli altri in attesa.
insert into public.access_requests (user_id, email, status, decided_at)
select u.id,
       coalesce(lower(u.email), ''),
       case when a.email is not null then 'approved' else 'pending' end,
       case when a.email is not null then now() end
from auth.users u
left join public.app_admins a on a.email = lower(u.email)
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- RLS su access_requests: ognuno vede la propria richiesta, l'admin tutte.
-- Nessuna scrittura diretta: le decisioni passano da set_access_status().
-- ---------------------------------------------------------------------------
alter table public.access_requests enable row level security;

drop policy if exists "access_select_own_or_admin" on public.access_requests;
create policy "access_select_own_or_admin" on public.access_requests
  for select to authenticated
  using ((select auth.uid()) = user_id or (select public.is_admin()));

revoke all on table public.access_requests from anon, authenticated;
grant select on table public.access_requests to authenticated;

create or replace function public.set_access_status(target uuid, new_status text)
returns public.access_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.access_requests;
begin
  if not public.is_admin() then
    raise exception 'Solo l''amministratore può gestire le richieste di accesso.' using errcode = '42501';
  end if;
  if new_status not in ('pending', 'approved', 'rejected') then
    raise exception 'Stato non valido: %', new_status using errcode = '22023';
  end if;
  if target = auth.uid() then
    raise exception 'Non puoi modificare il tuo stato di accesso.' using errcode = '22023';
  end if;
  update public.access_requests
     set status = new_status, decided_at = now(), decided_by = auth.uid()
   where user_id = target
  returning * into r;
  if not found then
    raise exception 'Richiesta non trovata.' using errcode = 'P0002';
  end if;
  return r;
end;
$$;
revoke all on function public.set_access_status(uuid, text) from public, anon;
grant execute on function public.set_access_status(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Note: accessibili solo a utenti approvati (oltre che proprietari).
-- ---------------------------------------------------------------------------
drop policy if exists "notes_select_own" on public.notes;
create policy "notes_select_own" on public.notes
  for select to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()));

drop policy if exists "notes_insert_own" on public.notes;
create policy "notes_insert_own" on public.notes
  for insert to authenticated
  with check ((select auth.uid()) = user_id and (select public.is_approved()));

drop policy if exists "notes_update_own" on public.notes;
create policy "notes_update_own" on public.notes
  for update to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()))
  with check ((select auth.uid()) = user_id and (select public.is_approved()));

drop policy if exists "notes_delete_own" on public.notes;
create policy "notes_delete_own" on public.notes
  for delete to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()));

-- ---------------------------------------------------------------------------
-- Realtime: l'admin vede arrivare le richieste, l'utente vede l'approvazione.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'access_requests'
     ) then
    alter publication supabase_realtime add table public.access_requests;
  end if;
end;
$$;
