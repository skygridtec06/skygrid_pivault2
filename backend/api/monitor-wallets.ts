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
  if (!SUPABASE_URL || !serviceKey) throw new Error("Server database environment is not configured.");
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
  if (!response.ok) throw new Error(`Pi Horizon payment query failed with HTTP ${response.status}.`);
  const body = (await response.json()) as { _embedded?: { records?: PaymentRecord[] } };
  return body._embedded?.records ?? [];
}

async function loadBalance(address: string): Promise<number> {
  const response = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(address)}`, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return 0;
  if (!response.ok) throw new Error(`Pi Horizon balance query failed with HTTP ${response.status}.`);
  const body = (await response.json()) as {
    balances?: Array<{ asset_type?: string; balance?: string }>;
  };
  const native = body.balances?.find((balance) => balance.asset_type === "native");
  return Number(native?.balance ?? 0);
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
  if (!response.ok) throw new Error(`Supabase transaction insert failed with HTTP ${response.status}.`);
  const inserted = (await response.json()) as unknown[];
  return (
    inserted.length > 0 &&
    direction === "in" &&
    Number(payment.amount ?? payment.starting_balance ?? 0) > 0
  );
}

async function sendSms(address: string, amount: number, balance: number, receivedAt: string) {
  const apiKey = process.env["TEXTSMS_API_KEY"];
  const partnerId = process.env["TEXTSMS_PARTNER_ID"];
  const shortcode = process.env["TEXTSMS_SHORTCODE"];
  const adminPhone = process.env["ADMIN_SMS_PHONE"];
  const apiUrl =
    process.env["TEXTSMS_API_URL"] ?? "https://sms.textsms.co.ke/api/services/sendsms/";
  if (!apiKey || !partnerId || !shortcode || !adminPhone) {
    throw new Error("SMS notifications are not configured.");
  }
  const digits = adminPhone.replace(/\D/g, "");
  const mobile = digits.startsWith("254") ? digits : digits.startsWith("0") ? `254${digits.slice(1)}` : "";
  if (!mobile) throw new Error("ADMIN_SMS_PHONE must be a valid Kenyan mobile number.");
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      apikey: apiKey,
      partnerID: partnerId,
      shortcode,
      mobile,
      message: [
        "Pi wallet received funds.",
        `Wallet: ${address}`,
        `Received: ${amount.toFixed(7)} Pi`,
        `Date: ${new Date(receivedAt).toLocaleString("en-KE")}`,
        `Available balance: ${balance.toFixed(7)} Pi`,
      ].join("\n"),
    }),
  });
  if (!response.ok) throw new Error(`SMS provider returned HTTP ${response.status}.`);
  const result = (await response.json()) as {
    responses?: Array<{
      "respose-code"?: number;
      "response-code"?: number;
      "response-description"?: string;
    }>;
  };
  const provider = result.responses?.[0];
  const code = Number(provider?.["respose-code"] ?? provider?.["response-code"]);
  if (code !== 200) throw new Error(provider?.["response-description"] ?? "SMS provider rejected alert.");
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== "GET") return response.status(405).json({ error: "Method not allowed." });
  if (!authorized(request)) return response.status(401).json({ error: "Unauthorized." });
  try {
    const wallets = await loadWallets();
    let paymentsChecked = 0;
    let alertsSent = 0;
    for (const wallet of wallets) {
      const payments = await loadPayments(wallet.address);
      const balance = await loadBalance(wallet.address);
      for (const payment of payments) {
        paymentsChecked += 1;
        if (await recordPayment(wallet, payment)) {
          await sendSms(
            wallet.address,
            Number(payment.amount ?? payment.starting_balance ?? 0),
            balance,
            payment.created_at,
          );
          alertsSent += 1;
        }
      }
    }
    return response.status(200).json({ walletsChecked: wallets.length, paymentsChecked, alertsSent });
  } catch (error) {
    console.error("Scheduled wallet monitor failed", error);
    return response.status(500).json({ error: "Scheduled wallet monitor failed." });
  }
}
