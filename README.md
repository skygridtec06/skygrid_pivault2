# Pi Vault

Pi Vault is a TanStack Start application for viewing Pi Network balances,
tracking wallet activity, and sending Pi on mainnet. Wallet signing keys are
encrypted in the browser before their ciphertext is saved in Supabase.

### Wallet signing-key storage

Signing keys are protected with AES-256-GCM. The encryption key is derived in
the browser from a vault password using PBKDF2-SHA-256 and a per-record random
salt. The vault password is held only in browser memory while the vault is
unlocked; it is not saved to local storage or sent to Supabase. You must enter
it again after a page reload. If you forget it, the encrypted signing keys
cannot be recovered, so keep a separate encrypted vault backup in a safe place.

Older installations that used an automatically generated browser key are
re-encrypted with the new vault password on the original browser the first time
the vault is unlocked. Never enter a vault password on a device you do not
trust. A compromised or unlocked browser can still access keys while they are
in use.

## Development

Requirements: Node.js 20+ and npm.

```sh
npm install
npm run dev
```

## Production

Build and preview the production bundle locally:

```sh
npm run build
npm run preview
```

The application is configured for the Cloudflare deployment target used by
TanStack Start. Deploy the generated `.output` directory using the deployment
workflow for your hosting provider.

### SMS notifications

SMS alerts are optional. Configure these server-side environment variables in
the production backend; never commit their values:

```text
TEXTSMS_API_KEY=
TEXTSMS_PARTNER_ID=
TEXTSMS_SHORTCODE=
ADMIN_SMS_PHONE=
TEXTSMS_API_URL=https://sms.textsms.co.ke/api/services/sendsms/
```

When an admin adds a wallet with a balance strictly greater than 2 Pi, the
backend immediately sends the wallet address, saved time, and Pi balance to the
configured admin phone. The wallet must be saved successfully first. An SMS
failure is shown separately and does not undo the wallet addition. The endpoint
requires an authenticated admin session (the user's profile must have
`is_admin` enabled) and does not receive wallet secrets. Configure the SMS and
server-only Supabase variables in the backend's production environment.

## Architecture

- `server/` contains backend-only SSR, error handling, and SMS integration.
- `backend/` contains the standalone Vercel API deployment (`/api/health` and
  `/api/balance-alert`, `/api/wallet-added-alert`, and `/api/pi-horizon`) used
  by the separate backend project. Pi Horizon reads and signed transaction
  submissions are proxied server-side to avoid browser CORS failures. Its
  `/api/monitor-wallets` cron runs every minute as a recovery path for payment
  alerts.
- `backend/worker/` contains the Railway always-on Pi Horizon stream monitor.
  Deploy it from the `backend/` directory using its Dockerfile and configure
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the SMS provider variables
  above. The worker streams wallet payments continuously and queues SMS alerts
  for retry if the provider is unavailable. Apply the Supabase migrations before
  deploying the worker or enabling the cron. The cron is a fallback, not a
  two-second delivery guarantee; delivery also depends on Horizon and the SMS
  provider.
  - Payment SMS is eligible only when its Horizon `created_at` timestamp is at
    or after the wallet's Supabase `added_at` timestamp. Older pending alerts are
    marked discarded and never sent.
- `src/` contains the browser application and TanStack route/client code.
- `src/Server/` is a legacy-named client-only module containing Pi SDK and
  local-wallet helpers. It uses browser storage and client-side signing; it is
  not a backend runtime module.
