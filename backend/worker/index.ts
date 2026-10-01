import { drainPaymentAlerts, enqueuePaymentAlert } from "../lib/payment-alerts.js";

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

const HORIZON_URL = "https://api.mainnet.minepi.com";
const SUPABASE_URL = required("SUPABASE_URL");
const SERVICE_KEY = required("SUPABASE_SERVICE_ROLE_KEY");
const streams = new Map<string, AbortController>();
const reconnectAttempts = new Map<string, number>();
let nextStreamStartAt = 0;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function supabaseFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
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

async function loadCursor(walletId: string): Promise<string> {
  const response = await supabaseFetch(
    `wallet_payment_alerts?wallet_id=eq.${encodeURIComponent(walletId)}&select=external_id&order=created_at.desc&limit=1`,
  );
  if (!response.ok) {
    throw new Error(`Supabase payment cursor query failed with HTTP ${response.status}.`);
  }
  const rows = (await response.json()) as Array<{ external_id?: string }>;
  if (rows[0]?.external_id) return rows[0].external_id;

  const existingTransactions = await supabaseFetch(
    `wallet_transactions?wallet_id=eq.${encodeURIComponent(walletId)}&select=external_id&order=recorded_at.desc&limit=1`,
  );
  if (!existingTransactions.ok) {
    throw new Error(
      `Supabase wallet history lookup failed with HTTP ${existingTransactions.status}.`,
    );
  }
  const transactionRows = (await existingTransactions.json()) as Array<{
    external_id?: string;
  }>;
  return transactionRows[0]?.external_id ?? "now";
}

async function recordPayment(wallet: Wallet, payment: PaymentRecord): Promise<boolean> {
  const from = payment.from ?? payment.funder ?? "";
  const to = payment.to ?? payment.account ?? "";
  const direction = to === wallet.address ? "in" : from === wallet.address ? "out" : "other";
  const amount = Number(payment.amount ?? payment.starting_balance ?? 0);
  const externalId = payment.id || payment.transaction_hash;
  const transactionHash = payment.transaction_hash || externalId;
  if (!externalId || !transactionHash || !payment.created_at || !payment.type) {
    console.warn(`Ignoring incomplete Pi payment event for ${wallet.address}.`);
    return false;
  }
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
      external_id: externalId,
      transaction_type: payment.type,
      direction,
      counterparty: direction === "in" ? from : to,
      amount,
      asset,
      created_at: payment.created_at,
      transaction_hash: transactionHash,
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Supabase transaction insert failed with HTTP ${response.status}: ${detail}`);
  }
  const inserted = (await response.json()) as unknown[];
  const isPi = payment.asset_type === "native" || payment.type === "create_account";
  return inserted.length > 0 && direction === "in" && amount > 0 && isPi;
}

function parseSseBlock(block: string): PaymentRecord | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  if (!data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === "object" ? (parsed as PaymentRecord) : null;
  } catch {
    return null;
  }
}

async function streamWallet(wallet: Wallet): Promise<void> {
  const controller = new AbortController();
  streams.set(wallet.address, controller);
  try {
    const startAt = Math.max(Date.now(), nextStreamStartAt);
    nextStreamStartAt = startAt + 250;
    await new Promise<void>((resolve) => setTimeout(resolve, startAt - Date.now()));
    if (controller.signal.aborted) return;

    const cursor = await loadCursor(wallet.id);
    const response = await fetch(
      `${HORIZON_URL}/accounts/${encodeURIComponent(wallet.address)}/payments?cursor=${encodeURIComponent(cursor)}`,
      {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(`Pi stream failed with HTTP ${response.status}.`);
    }
    reconnectAttempts.delete(wallet.address);
    console.log(`Pi payment stream connected for ${wallet.address.slice(0, 8)}.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const payment = parseSseBlock(block);
        if (!payment) continue;
        try {
          const to = payment.to ?? payment.account ?? "";
          const amount = Number(payment.amount ?? payment.starting_balance ?? 0);
          const isPi = payment.asset_type === "native" || payment.type === "create_account";
          if (to === wallet.address && amount > 0 && isPi) {
            await enqueuePaymentAlert({
              walletId: wallet.id,
              userId: wallet.user_id,
              address: wallet.address,
              externalId: payment.id || payment.transaction_hash,
              amount,
              receivedAt: payment.created_at,
            });
            await drainPaymentAlerts();
          }
          await recordPayment(wallet, payment);
        } catch (error) {
          console.error(`Payment handling failed for ${wallet.address}`, error);
        }
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(`Pi stream disconnected for ${wallet.address.slice(0, 8)}.`, error);
    }
  } finally {
    streams.delete(wallet.address);
    if (!controller.signal.aborted) {
      const attempts = reconnectAttempts.get(wallet.address) ?? 0;
      const backoff = Math.min(1000 * 2 ** attempts, 60_000);
      reconnectAttempts.set(wallet.address, Math.min(attempts + 1, 6));
      const delay = Math.round(backoff * (0.75 + Math.random() * 0.5));
      setTimeout(() => void streamWallet(wallet), delay);
    }
  }
}

async function reconcileStreams() {
  const wallets = await loadWallets();
  const active = new Set(wallets.map((wallet) => wallet.address));
  for (const wallet of wallets) {
    if (!streams.has(wallet.address)) void streamWallet(wallet);
  }
  for (const [address, controller] of streams) {
    if (!active.has(address)) {
      reconnectAttempts.delete(address);
      controller.abort();
    }
  }
}

console.log("Starting real-time Pi wallet monitor with durable SMS delivery.");
await drainPaymentAlerts();
await reconcileStreams();
setInterval(() => {
  reconcileStreams().catch((error) => console.error("Wallet discovery failed", error));
}, 30_000);

let drainingAlerts = false;
setInterval(() => {
  if (drainingAlerts) return;
  drainingAlerts = true;
  drainPaymentAlerts()
    .catch((error) => console.error("Payment alert queue processing failed", error))
    .finally(() => {
      drainingAlerts = false;
    });
}, 10_000);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`Received ${signal}; closing Pi payment streams.`);
    for (const controller of streams.values()) controller.abort();
  });
}
