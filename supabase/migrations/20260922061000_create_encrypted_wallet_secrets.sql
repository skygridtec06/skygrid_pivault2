create table if not exists public.wallet_secrets (
  wallet_id uuid primary key references public.wallets(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  ciphertext text not null,
  salt text not null,
  iv text not null,
  updated_at timestamptz not null default now()
);

alter table public.wallet_secrets enable row level security;

drop policy if exists wallet_secrets_owner_or_admin on public.wallet_secrets;
create policy wallet_secrets_owner_or_admin on public.wallet_secrets
  for all using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());
