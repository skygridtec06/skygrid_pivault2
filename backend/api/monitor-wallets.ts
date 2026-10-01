import { drainPaymentAlerts, enqueuePaymentAlert } from "../lib/payment-alerts.ts";

type VercelRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
};
type VercelResponse = {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => VercelResponse;
};

type Wallet = { id: string; address: string; user_id: string };
type PaymentRecord = {
  id: string;
  type: string;
  from?: string;
  to?: string;
  funder?: string;
  account?: string;
  amount?: string;
  starting_balance?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  created_at: string;
  transaction_hash: string;
};
declare const process: { env: Record<string, string | undefined> };

const HORIZON_URL = "https://api.mainnet.minepi.com";
const SUPABASE_URL = process.env["SUPABASE_URL"] ?? process.env["VITE_SUPABASE_URL"];

function authorized(request: VercelRequest): boolean {
  const expected = process.env["CRON_SECRET"];
  const provided = request.headers?.authorization;
  return Boolean(expected && provided === `Bearer ${expected}`);
}

async function supabaseFetch(path: string, init?: RequestInit): Promise<Response> {
  const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!SUPABASE_URL || !serviceKey)
    throw new Error("Server database environment is not configured.");
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

async function loadWallets(): Promise<Wallet[]> {
  const response = await supabaseFetch("wallets?select=id,address,user_id");
  if (!response.ok) throw new Error(`Supabase wallet query failed with HTTP ${response.status}.`);
  return (await response.json()) as Wallet[];
}

async function loadPayments(address: string): Promise<PaymentRecord[]> {
  const response = await fetch(
    `${HORIZON_URL}/accounts/${encodeURIComponent(address)}/payments?order=desc&limit=200`,
    { headers: { accept: "application/json" } },
  );
  if (response.status === 404) return [];
  if (!response.ok)
    throw new Error(`Pi Horizon payment query failed with HTTP ${response.status}.`);
  const body = (await response.json()) as { _embedded?: { records?: PaymentRecord[] } };
  return body._embedded?.records ?? [];
}

async function recordPayment(wallet: Wallet, payment: PaymentRecord): Promise<boolean> {
  const from = payment.from ?? payment.funder ?? "";
  const to = payment.to ?? payment.account ?? "";
  const direction = to === wallet.address ? "in" : from === wallet.address ? "out" : "other";
  const asset =
    payment.asset_type === "native"
      ? "Pi"
      : payment.asset_code
        ? `${payment.asset_code}${payment.asset_issuer ? ` (${payment.asset_issuer})` : ""}`
        : "Unknown asset";
  const response = await supabaseFetch("wallet_transactions?on_conflict=user_id%2Cexternal_id", {
    method: "POST",
    headers: { prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({
      wallet_id: wallet.id,
      user_id: wallet.user_id,
      external_id: payment.id,
      transaction_type: payment.type,
      direction,
      counterparty: direction === "in" ? from : to,
      amount: Number(payment.amount ?? payment.starting_balance ?? 0),
      asset,
      created_at: payment.created_at,
      transaction_hash: payment.transaction_hash,
    }),
  });
  if (!response.ok)
    throw new Error(`Supabase transaction insert failed with HTTP ${response.status}.`);
  const inserted = (await response.json()) as unknown[];
  return (
    inserted.length > 0 &&
    direction === "in" &&
    Number(payment.amount ?? payment.starting_balance ?? 0) > 0
  );
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== "GET") return response.status(405).json({ error: "Method not allowed." });
  if (!authorized(request)) return response.status(401).json({ error: "Unauthorized." });
  try {
    const wallets = await loadWallets();
    const results = await Promise.all(
      wallets.map(async (wallet) => {
        const payments = await loadPayments(wallet.address);
        let alertsQueued = 0;
        for (const payment of payments) {
          const amount = Number(payment.amount ?? payment.starting_balance ?? 0);
          const to = payment.to ?? payment.account ?? "";
          const isPi = payment.asset_type === "native" || payment.type === "create_account";
          const age = Date.now() - Date.parse(payment.created_at);
          if (
            to === wallet.address &&
            isPi &&
            amount > 0 &&
            age >= -60_000 &&
            age <= 5 * 60_000 &&
            payment.id
          ) {
            if (
              await enqueuePaymentAlert({
                walletId: wallet.id,
                userId: wallet.user_id,
                address: wallet.address,
                externalId: payment.id,
                amount,
                receivedAt: payment.created_at,
              })
            ) {
              alertsQueued += 1;
            }
          }
        }
        return { wallet, payments, alertsQueued };
      }),
    );
    const alertsSent = await drainPaymentAlerts();
    await Promise.all(
      results.map(async ({ wallet, payments }) => {
        for (const payment of payments) await recordPayment(wallet, payment);
      }),
    );
    return response.status(200).json({
      walletsChecked: wallets.length,
      paymentsChecked: results.reduce((sum, result) => sum + result.payments.length, 0),
      alertsQueued: results.reduce((sum, result) => sum + result.alertsQueued, 0),
      alertsSent,
    });
  } catch (error) {
    console.error("Scheduled wallet monitor failed", error);
    return response.status(500).json({ error: "Scheduled wallet monitor failed." });
  }
}
