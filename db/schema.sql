-- =====================================================================
-- Mesa Poker — schema completo (Supabase / Postgres)
-- Fonte da verdade do banco. Aplicado no projeto Supabase "barril-app"
-- (tabelas isoladas com prefixo poker_; fácil migrar p/ projeto próprio).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ------------------------------ tabelas ------------------------------

create table public.poker_settings (
  id int primary key default 1 check (id = 1),
  admin_pin_hash text not null,
  created_at timestamptz not null default now()
);

create table public.poker_players (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  pin_hash text not null,
  created_at timestamptz not null default now()
);
create unique index poker_players_name_key on public.poker_players (lower(name));

create table public.poker_sessions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'open' check (status in ('open','closed')),
  rake_percent numeric not null default 5,
  rake_cap numeric,
  chip_values jsonb not null default '[{"color":"Branca","hex":"#ECECEC","value":1},{"color":"Vermelha","hex":"#D64545","value":5},{"color":"Azul","hex":"#3B6FD4","value":10},{"color":"Verde","hex":"#2E9E5B","value":25},{"color":"Preta","hex":"#2B2B2B","value":100}]'::jsonb,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table public.poker_transactions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.poker_sessions(id) on delete cascade,
  player_id uuid not null references public.poker_players(id) on delete cascade,
  type text not null check (type in ('buy_in','rebuy','cash_out','adjust')),
  amount numeric not null check (amount >= 0),
  note text,
  voided boolean not null default false,   -- estorno (ledger imutável: nada é apagado)
  created_at timestamptz not null default now()
);

create table public.poker_rake_entries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.poker_sessions(id) on delete cascade,
  chips jsonb not null default '{}'::jsonb,          -- {"Vermelha": 2, "Azul": 1}
  rake_amount numeric not null check (rake_amount >= 0),
  pot_amount numeric,                                 -- pote estimado (opcional)
  voided boolean not null default false,              -- estorno
  created_at timestamptz not null default now()
);

-- ------------------------- RLS e privilégios -------------------------
-- Leitura pública (mesa ao vivo); escrita só via RPC com PIN.

alter table public.poker_settings enable row level security;
alter table public.poker_players enable row level security;
alter table public.poker_sessions enable row level security;
alter table public.poker_transactions enable row level security;
alter table public.poker_rake_entries enable row level security;

create policy "poker read sessions" on public.poker_sessions for select to anon, authenticated using (true);
create policy "poker read transactions" on public.poker_transactions for select to anon, authenticated using (true);
create policy "poker read rake" on public.poker_rake_entries for select to anon, authenticated using (true);
create policy "poker read players" on public.poker_players for select to anon, authenticated using (true);

-- esconder hash de PIN dos clientes (privilégio por coluna)
revoke select on table public.poker_players from anon, authenticated;
grant select (id, name, created_at) on table public.poker_players to anon, authenticated;
revoke all on table public.poker_settings from anon, authenticated;

-- tempo real (players fica de fora para nunca vazar pin_hash em payload)
alter publication supabase_realtime add table public.poker_sessions, public.poker_transactions, public.poker_rake_entries;

-- ------------------------------ funções ------------------------------
-- Todas security definer: validam o PIN no servidor e escrevem com role
-- elevada. O cliente (anon) nunca escreve direto nas tabelas.

create or replace function public.poker_admin_check(p_pin text)
returns boolean language sql security definer set search_path = public, extensions as $$
  select exists(select 1 from poker_settings where admin_pin_hash = crypt(p_pin, admin_pin_hash));
$$;

-- helpers: validam e disparam exceção (deixam as funções de escrita curtas)
create or replace function public.poker_req(p text)
returns void language plpgsql as $$
begin
  if not poker_admin_check(p) then raise exception 'PIN de admin inválido'; end if;
end $$;

create or replace function public.poker_pinok(p text)
returns void language plpgsql as $$
begin
  if p !~ '^[0-9]{4,8}$' then raise exception 'PIN deve ter de 4 a 8 dígitos'; end if;
end $$;

create or replace function public.poker_change_admin_pin(p_old text, p_new text)
returns void language sql security definer set search_path = public, extensions as $$
  select poker_req(p_old);
  select poker_pinok(p_new);
  update poker_settings set admin_pin_hash = crypt(p_new, gen_salt('bf')) where id = 1;
$$;

create or replace function public.poker_create_player(p_admin_pin text, p_name text, p_player_pin text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  if not poker_admin_check(p_admin_pin) then raise exception 'PIN de admin inválido'; end if;
  if length(trim(p_name)) < 2 then raise exception 'Nome muito curto'; end if;
  if p_player_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN do jogador deve ter de 4 a 8 dígitos'; end if;
  insert into poker_players (name, pin_hash) values (trim(p_name), crypt(p_player_pin, gen_salt('bf'))) returning id into v_id;
  return v_id;
end $$;

create or replace function public.poker_set_player_pin(p_admin_pin text, p_player_id uuid, p_new_pin text)
returns void language sql security definer set search_path = public, extensions as $$
  select poker_req(p_admin_pin);
  select poker_pinok(p_new_pin);
  update poker_players set pin_hash = crypt(p_new_pin, gen_salt('bf')) where id = p_player_id;
$$;

create or replace function public.poker_player_login(p_name text, p_pin text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  select id into v_id from poker_players
   where lower(name) = lower(trim(p_name)) and pin_hash = crypt(p_pin, pin_hash);
  if v_id is null then raise exception 'Nome ou PIN incorreto'; end if;
  return v_id;
end $$;

create or replace function public.poker_create_session(p_admin_pin text, p_name text, p_rake_percent numeric, p_rake_cap numeric, p_chip_values jsonb)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  if not poker_admin_check(p_admin_pin) then raise exception 'PIN de admin inválido'; end if;
  insert into poker_sessions (name, rake_percent, rake_cap, chip_values)
  values (coalesce(nullif(trim(p_name),''), 'Mesa ' || to_char(now(),'DD/MM')), coalesce(p_rake_percent,5), p_rake_cap,
          coalesce(p_chip_values,
                   (select chip_values from poker_sessions order by created_at desc limit 1),
                   '[{"color":"Branca","hex":"#ECECEC","value":1},{"color":"Vermelha","hex":"#D64545","value":5},{"color":"Azul","hex":"#3B6FD4","value":10},{"color":"Verde","hex":"#2E9E5B","value":25},{"color":"Preta","hex":"#2B2B2B","value":100}]'::jsonb))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.poker_update_session(p_admin_pin text, p_session_id uuid, p_rake_percent numeric, p_rake_cap numeric, p_chip_values jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not poker_admin_check(p_admin_pin) then raise exception 'PIN de admin inválido'; end if;
  update poker_sessions set
    rake_percent = coalesce(p_rake_percent, rake_percent),
    rake_cap = p_rake_cap,
    chip_values = coalesce(p_chip_values, chip_values)
  where id = p_session_id;
end $$;

create or replace function public.poker_close_session(p_admin_pin text, p_session_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not poker_admin_check(p_admin_pin) then raise exception 'PIN de admin inválido'; end if;
  update poker_sessions set status = 'closed', closed_at = now() where id = p_session_id and status = 'open';
end $$;

create or replace function public.poker_add_transaction(p_admin_pin text, p_session_id uuid, p_player_id uuid, p_type text, p_amount numeric, p_note text default null)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  if not poker_admin_check(p_admin_pin) then raise exception 'PIN de admin inválido'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Valor deve ser maior que zero'; end if;
  insert into poker_transactions (session_id, player_id, type, amount, note)
  values (p_session_id, p_player_id, p_type, p_amount, p_note) returning id into v_id;
  return v_id;
end $$;

-- estorno em vez de delete: mantém trilha de auditoria do caixa
create or replace function public.poker_void_tx(p_admin_pin text, p_id uuid, p_void boolean default true)
returns void language sql security definer set search_path = public, extensions as $$
  select poker_req(p_admin_pin);
  update poker_transactions set voided = p_void where id = p_id;
$$;

create or replace function public.poker_add_rake(p_admin_pin text, p_session_id uuid, p_chips jsonb, p_rake_amount numeric, p_pot_amount numeric default null)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  if not poker_admin_check(p_admin_pin) then raise exception 'PIN de admin inválido'; end if;
  if p_rake_amount is null or p_rake_amount < 0 then raise exception 'Valor de rake inválido'; end if;
  insert into poker_rake_entries (session_id, chips, rake_amount, pot_amount)
  values (p_session_id, coalesce(p_chips,'{}'::jsonb), p_rake_amount, p_pot_amount) returning id into v_id;
  return v_id;
end $$;

create or replace function public.poker_void_rake(p_admin_pin text, p_id uuid, p_void boolean default true)
returns void language sql security definer set search_path = public, extensions as $$
  select poker_req(p_admin_pin);
  update poker_rake_entries set voided = p_void where id = p_id;
$$;

-- PIN inicial do admin (trocar no app em Config → Trocar PIN)
insert into poker_settings (admin_pin_hash) values (extensions.crypt('864401', extensions.gen_salt('bf')));
