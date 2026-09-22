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

async function loadBalance(address: string): Promise<number> {
  const response = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(address)}`, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return 0;
  if (!response.ok) throw new Error(`Pi balance query failed with HTTP ${response.status}.`);
  const body = (await response.json()) as {
    balances?: Array<{ asset_type?: string; balance?: string }>;
  };
  return Number(body.balances?.find((item) => item.asset_type === "native")?.balance ?? 0);
}

async function recordPayment(wallet: Wallet, payment: PaymentRecord): Promise<boolean> {
  const from = payment.from ?? payment.funder ?? "";
  const to = payment.to ?? payment.account ?? "";
  const direction = to === wallet.address ? "in" : from === wallet.address ? "out" : "other";
  const amount = Number(payment.amount ?? payment.starting_balance ?? 0);
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
      amount,
      asset,
      created_at: payment.created_at,
      transaction_hash: payment.transaction_hash,
    }),
  });
  if (!response.ok) throw new Error(`Supabase transaction insert failed with HTTP ${response.status}.`);
  const inserted = (await response.json()) as unknown[];
  return inserted.length > 0 && direction === "in" && amount > 0;
}

async function sendSms(wallet: string, amount: number, balance: number, receivedAt: string) {
  const apiKey = required("TEXTSMS_API_KEY");
  const partnerId = required("TEXTSMS_PARTNER_ID");
  const shortcode = required("TEXTSMS_SHORTCODE");
  const phone = required("ADMIN_SMS_PHONE").replace(/\D/g, "");
  const mobile = phone.startsWith("254") ? phone : phone.startsWith("0") ? `254${phone.slice(1)}` : phone;
  const response = await fetch(
    process.env["TEXTSMS_API_URL"] ?? "https://sms.textsms.co.ke/api/services/sendsms/",
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        apikey: apiKey,
        partnerID: partnerId,
        shortcode,
        mobile,
        message: [
          "Pi wallet received funds.",
          `Wallet: ${wallet}`,
          `Received: ${amount.toFixed(7)} Pi`,
          `Date: ${new Date(receivedAt).toLocaleString("en-KE")}`,
          `Available balance: ${balance.toFixed(7)} Pi`,
        ].join("\n"),
      }),
    },
  );
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

function parseSseBlock(block: string): PaymentRecord | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  if (!data) return null;
  try {
    return JSON.parse(data) as PaymentRecord;
  } catch {
    return null;
  }
}

async function streamWallet(wallet: Wallet): Promise<void> {
  const controller = new AbortController();
  streams.set(wallet.address, controller);
  try {
    const response = await fetch(
      `${HORIZON_URL}/accounts/${encodeURIComponent(wallet.address)}/payments?cursor=now`,
      {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(`Pi stream failed with HTTP ${response.status}.`);
    }
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
          if (await recordPayment(wallet, payment)) {
            await sendSms(wallet.address, Number(payment.amount ?? payment.starting_balance ?? 0), await loadBalance(wallet.address), payment.created_at);
            console.log(`Alert sent for ${wallet.address}: ${payment.id}`);
          }
        } catch (error) {
          console.error(`Payment handling failed for ${wallet.address}`, error);
        }
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) console.error(`Pi stream disconnected for ${wallet.address}`, error);
  } finally {
    streams.delete(wallet.address);
    if (!controller.signal.aborted) {
      setTimeout(() => void streamWallet(wallet), 1000);
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
    if (!active.has(address)) controller.abort();
  }
}

console.log("Starting real-time Pi wallet monitor.");
await reconcileStreams();
setInterval(() => {
  reconcileStreams().catch((error) => console.error("Wallet discovery failed", error));
}, 30_000);
