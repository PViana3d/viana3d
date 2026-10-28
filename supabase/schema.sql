-- Gestão Impressão 3D — base de dados Supabase
-- Cada empresa é um "workspace"; os membros da equipa partilham os mesmos dados.
-- Os registos da aplicação (orçamentos, peças, clientes, bobines, …) ficam na tabela docs como JSON.
-- Pode correr este ficheiro mais do que uma vez sem estragar nada.

create extension if not exists pgcrypto;

-- ---------- tabelas ----------
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Oficina 3D',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'membro' check (role in ('dono', 'membro')),
  email text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists workspace_members_user_idx on public.workspace_members(user_id);

create table if not exists public.workspace_invites (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null default 'membro' check (role in ('dono', 'membro')),
  invited_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, email)
);

create table if not exists public.docs (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  collection text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (workspace_id, collection, id)
);

create or replace function public.touch_docs() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs for each row execute function public.touch_docs();

-- ---------- funções de acesso (fora da API pública) ----------
create schema if not exists private;
grant usage on schema private to authenticated;

create or replace function private.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members where workspace_id = ws and user_id = auth.uid());
$$;

create or replace function private.is_owner(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members where workspace_id = ws and user_id = auth.uid() and role = 'dono');
$$;
revoke all on function private.is_member(uuid) from public, anon;
revoke all on function private.is_owner(uuid) from public, anon;
grant execute on function private.is_member(uuid) to authenticated;
grant execute on function private.is_owner(uuid) to authenticated;

-- Chamada pela aplicação depois do login: aceita convites pendentes e, se for a primeira vez, cria a empresa.
create or replace function public.bootstrap() returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  mail text := lower(coalesce(auth.jwt() ->> 'email', ''));
  ws uuid;
  r text;
begin
  if uid is null then raise exception 'Sessão inválida'; end if;

  insert into workspace_members (workspace_id, user_id, role, email)
    select i.workspace_id, uid, i.role, mail from workspace_invites i where lower(i.email) = mail
    on conflict do nothing;
  delete from workspace_invites where lower(email) = mail;
  update workspace_members set email = mail where user_id = uid and email is distinct from mail;

  -- quem foi convidado para uma equipa entra nessa equipa
  select m.workspace_id, m.role into ws, r
    from workspace_members m where m.user_id = uid
    order by (m.role = 'membro') desc, m.created_at desc limit 1;

  if ws is null then
    insert into workspaces (name, created_by) values ('Oficina 3D', uid) returning id into ws;
    insert into workspace_members (workspace_id, user_id, role, email) values (ws, uid, 'dono', mail);
    r := 'dono';
  end if;
  return json_build_object('workspace_id', ws, 'role', r);
end $$;

-- Convidar um colega (só o dono). Se já tiver conta entra logo; se não, fica o convite à espera.
create or replace function public.invite_member(ws uuid, mail text) returns text
language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  if not private.is_owner(ws) then raise exception 'Só o dono da conta pode convidar pessoas.'; end if;
  mail := lower(trim(mail));
  if mail !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Email inválido.'; end if;
  select id into u from auth.users where lower(email) = mail limit 1;
  if u is not null then
    insert into workspace_members (workspace_id, user_id, role, email) values (ws, u, 'membro', mail) on conflict do nothing;
    return 'added';
  end if;
  insert into workspace_invites (workspace_id, email) values (ws, mail) on conflict do nothing;
  return 'invited';
end $$;

revoke all on function public.bootstrap() from public, anon;
revoke all on function public.invite_member(uuid, text) from public, anon;
grant execute on function public.bootstrap() to authenticated;
grant execute on function public.invite_member(uuid, text) to authenticated;
-- ---------- regras de segurança (RLS) ----------
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.docs enable row level security;

drop policy if exists "ver empresa" on public.workspaces;
create policy "ver empresa" on public.workspaces for select to authenticated using (private.is_member(id));
drop policy if exists "dono altera empresa" on public.workspaces;
create policy "dono altera empresa" on public.workspaces for update to authenticated using (private.is_owner(id)) with check (private.is_owner(id));

drop policy if exists "ver equipa" on public.workspace_members;
create policy "ver equipa" on public.workspace_members for select to authenticated using (private.is_member(workspace_id));
drop policy if exists "dono remove membros" on public.workspace_members;
create policy "dono remove membros" on public.workspace_members for delete to authenticated using (private.is_owner(workspace_id) and user_id <> auth.uid());

drop policy if exists "ver convites" on public.workspace_invites;
create policy "ver convites" on public.workspace_invites for select to authenticated using (private.is_member(workspace_id));
drop policy if exists "dono cancela convites" on public.workspace_invites;
create policy "dono cancela convites" on public.workspace_invites for delete to authenticated using (private.is_owner(workspace_id));

drop policy if exists "equipa le docs" on public.docs;
create policy "equipa le docs" on public.docs for select to authenticated using (private.is_member(workspace_id));
drop policy if exists "equipa cria docs" on public.docs;
create policy "equipa cria docs" on public.docs for insert to authenticated with check (private.is_member(workspace_id));
drop policy if exists "equipa altera docs" on public.docs;
create policy "equipa altera docs" on public.docs for update to authenticated using (private.is_member(workspace_id)) with check (private.is_member(workspace_id));
drop policy if exists "equipa apaga docs" on public.docs;
create policy "equipa apaga docs" on public.docs for delete to authenticated using (private.is_member(workspace_id));

revoke all on public.workspaces, public.workspace_members, public.workspace_invites, public.docs from anon;

-- ---------- tempo real (alterações aparecem nos outros aparelhos) ----------
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'docs') then
    alter publication supabase_realtime add table public.docs;
  end if;
end $$;
