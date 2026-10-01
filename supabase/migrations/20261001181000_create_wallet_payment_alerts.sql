create table if not exists public.wallet_payment_alerts (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  address text not null check (address ~ '^G[A-Z2-7]{55}$'),
  external_id text not null,
  amount numeric not null check (amount > 0),
  received_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (wallet_id, external_id)
);

create index if not exists wallet_payment_alerts_pending_idx
  on public.wallet_payment_alerts(status, lease_expires_at, created_at)
  where status in ('pending', 'processing');

alter table public.wallet_payment_alerts enable row level security;
