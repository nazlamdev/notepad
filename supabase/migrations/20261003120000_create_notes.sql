-- Quaderno: tabella delle note personali.
-- Idempotente: può essere rieseguita senza errori (SQL Editor o `supabase db push`).

-- ---------------------------------------------------------------------------
-- Tabella
-- ---------------------------------------------------------------------------
create table if not exists public.notes (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  title       text        not null default 'Nuova nota',
  content     text        not null default '',
  -- Numero di revisione, incrementato dal trigger a ogni UPDATE.
  -- Il client lo usa per il controllo di concorrenza ottimistico
  -- (UPDATE ... WHERE version = <versione letta>), così una modifica fatta
  -- su un altro dispositivo non viene mai sovrascritta silenziosamente.
  version     integer     not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint notes_title_length check (char_length(title) <= 500)
);

comment on table public.notes is 'Note private: ogni riga è visibile solo al proprietario (RLS).';

create index if not exists notes_user_id_updated_at_idx
  on public.notes (user_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- Trigger: user_id impostato dal server, campi di sistema non modificabili
-- ---------------------------------------------------------------------------
create or replace function public.notes_before_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Le richieste dal browser hanno sempre auth.uid(): il client non può
  -- scegliere il proprietario. (Da SQL Editor auth.uid() è null e serve
  -- passare user_id esplicitamente.)
  if auth.uid() is not null then
    new.user_id := auth.uid();
  end if;
  new.version    := 1;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.notes_before_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.id         := old.id;
  new.user_id    := old.user_id;
  new.created_at := old.created_at;
  new.version    := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists notes_before_insert on public.notes;
create trigger notes_before_insert
  before insert on public.notes
  for each row execute function public.notes_before_insert();

drop trigger if exists notes_before_update on public.notes;
create trigger notes_before_update
  before update on public.notes
  for each row execute function public.notes_before_update();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.notes enable row level security;

drop policy if exists "notes_select_own" on public.notes;
create policy "notes_select_own" on public.notes
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "notes_insert_own" on public.notes;
create policy "notes_insert_own" on public.notes
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "notes_update_own" on public.notes;
create policy "notes_update_own" on public.notes
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "notes_delete_own" on public.notes;
create policy "notes_delete_own" on public.notes
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Privilegi a livello di colonna (difesa in profondità oltre a RLS):
-- gli utenti anonimi non hanno accesso; gli utenti autenticati possono
-- scrivere solo id/title/content, mai user_id, version o timestamp.
-- ---------------------------------------------------------------------------
revoke all on table public.notes from anon, authenticated;
grant select, delete on table public.notes to authenticated;
grant insert (id, title, content) on table public.notes to authenticated;
grant update (title, content) on table public.notes to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: pubblica le modifiche della tabella (rispettando RLS)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notes'
     ) then
    alter publication supabase_realtime add table public.notes;
  end if;
end;
$$;
