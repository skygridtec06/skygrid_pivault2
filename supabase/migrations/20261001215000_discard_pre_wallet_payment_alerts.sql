alter table public.wallet_payment_alerts
  drop constraint if exists wallet_payment_alerts_status_check;

alter table public.wallet_payment_alerts
  add constraint wallet_payment_alerts_status_check
  check (status in ('pending', 'processing', 'sent', 'discarded'));
