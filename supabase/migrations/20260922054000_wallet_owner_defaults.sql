alter table public.wallets
  alter column user_id set default auth.uid();

alter table public.wallet_transactions
  alter column user_id set default auth.uid();
