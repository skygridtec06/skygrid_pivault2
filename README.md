# Pi Vault

Pi Vault is a TanStack Start application for viewing Pi Network balances,
tracking wallet activity, and sending Pi on mainnet. Secret keys are kept in
the browser and are never sent to the application backend.

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

SMS balance alerts are optional. Configure these server-side environment
variables in the production runtime; never commit their values:

```text
TEXTSMS_API_KEY=
TEXTSMS_PARTNER_ID=
TEXTSMS_SHORTCODE=
ADMIN_SMS_PHONE=
TEXTSMS_API_URL=https://sms.textsms.co.ke/api/services/sendsms/
```

When these variables are not configured, the SMS alert reports a clear
configuration error and the rest of the wallet UI remains available.

## Architecture

- `server/` contains backend-only SSR, error handling, and SMS integration.
- `backend/` contains the standalone Vercel API deployment (`/api/health` and
  `/api/balance-alert`) used by the separate backend project.
- `src/` contains the browser application and TanStack route/client code.
- `src/Server/` is a legacy-named client-only module containing Pi SDK and
  local-wallet helpers. It uses browser storage and client-side signing; it is
  not a backend runtime module.
