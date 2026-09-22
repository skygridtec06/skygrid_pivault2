create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_-]{3,32}$'),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  address text not null check (address ~ '^G[A-Z2-7]{55}$'),
  label text not null default 'Wallet',
  added_at timestamptz not null default now(),
  unique (user_id, address)
);

create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid references public.wallets(id) on delete set null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  external_id text not null,
  transaction_type text not null,
  direction text not null check (direction in ('in', 'out', 'other')),
  counterparty text not null default '',
  amount numeric not null default 0,
  asset text not null default 'Pi',
  created_at timestamptz not null,
  transaction_hash text not null,
  recorded_at timestamptz not null default now(),
  unique (user_id, external_id)
);

create table if not exists public.admin_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists wallets_user_id_idx on public.wallets(user_id);
create index if not exists wallet_transactions_user_id_created_idx
  on public.wallet_transactions(user_id, created_at desc);
create index if not exists admin_logs_created_idx on public.admin_logs(created_at desc);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and is_admin = true
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    lower(coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1)))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.wallets enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.admin_logs enable row level security;

drop policy if exists profiles_select_self_or_admin on public.profiles;
create policy profiles_select_self_or_admin on public.profiles
  for select using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update_self_or_admin on public.profiles;
create policy profiles_update_self_or_admin on public.profiles
  for update using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

drop policy if exists wallets_owner_or_admin on public.wallets;
create policy wallets_owner_or_admin on public.wallets
  for all using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists transactions_owner_or_admin on public.wallet_transactions;
create policy transactions_owner_or_admin on public.wallet_transactions
  for all using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

drop policy if exists admin_logs_admin_only on public.admin_logs;
create policy admin_logs_admin_only on public.admin_logs
  for select using (public.is_admin());

drop policy if exists admin_logs_insert_authenticated on public.admin_logs;
create policy admin_logs_insert_authenticated on public.admin_logs
  for insert with check (actor_id = auth.uid());
