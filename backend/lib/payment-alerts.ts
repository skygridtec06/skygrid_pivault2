declare const process: { env: Record<string, string | undefined> };

export type PaymentAlertInput = {
  walletId: string;
  userId: string;
  address: string;
  externalId: string;
  amount: number;
  receivedAt: string;
};

type PendingAlert = {
  id: string;
  address: string;
  amount: number;
  received_at: string;
  attempts: number;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function supabaseFetch(path: string, init?: RequestInit): Promise<Response> {
  const supabaseUrl = process.env["SUPABASE_URL"] ?? process.env["VITE_SUPABASE_URL"];
  const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl) throw new Error("SUPABASE_URL is required.");
  return fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

export async function enqueuePaymentAlert(alert: PaymentAlertInput): Promise<boolean> {
  const response = await supabaseFetch(
    "wallet_payment_alerts?on_conflict=wallet_id%2Cexternal_id",
    {
      method: "POST",
      headers: { prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify({
        wallet_id: alert.walletId,
        user_id: alert.userId,
        address: alert.address,
        external_id: alert.externalId,
        amount: alert.amount,
        received_at: alert.receivedAt,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Payment alert queue insert failed with HTTP ${response.status}.`);
  }
  const inserted = (await response.json()) as unknown[];
  return inserted.length > 0;
}

function normalizeKenyanPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  throw new Error("ADMIN_SMS_PHONE must be a valid Kenyan mobile number.");
}

async function sendAlert(alert: PendingAlert): Promise<void> {
  const apiKey = required("TEXTSMS_API_KEY");
  const partnerId = required("TEXTSMS_PARTNER_ID");
  const shortcode = required("TEXTSMS_SHORTCODE");
  const mobile = normalizeKenyanPhone(required("ADMIN_SMS_PHONE"));
  const apiUrl =
    process.env["TEXTSMS_API_URL"] ?? "https://sms.textsms.co.ke/api/services/sendsms/";
  const response = await fetch(apiUrl, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      apikey: apiKey,
      partnerID: partnerId,
      shortcode,
      mobile,
      message: [
        "Pi payment received.",
        `Wallet: ${alert.address}`,
        `Received: ${alert.amount.toFixed(7)} Pi`,
        `Date: ${new Date(alert.received_at).toLocaleString("en-KE")}`,
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
  if (code !== 200) {
    throw new Error(provider?.["response-description"] ?? "TextSMS rejected the payment alert.");
  }
}

export async function drainPaymentAlerts(): Promise<number> {
  const now = new Date().toISOString();
  const queueQuery = new URLSearchParams({
    or: `(status.eq.pending,and(status.eq.processing,lease_expires_at.lt.${now}))`,
    select: "id,address,amount,received_at,attempts",
    order: "created_at.asc",
    limit: "25",
  });
  const response = await supabaseFetch(`wallet_payment_alerts?${queueQuery.toString()}`);
  if (!response.ok) {
    throw new Error(`Payment alert queue lookup failed with HTTP ${response.status}.`);
  }
  const alerts = (await response.json()) as PendingAlert[];
  let sent = 0;

  for (const alert of alerts) {
    const leaseExpiresAt = new Date(Date.now() + 30_000).toISOString();
    const claimQuery = new URLSearchParams({
      id: `eq.${alert.id}`,
      or: `(status.eq.pending,and(status.eq.processing,lease_expires_at.lt.${now}))`,
    });
    const claim = await supabaseFetch(`wallet_payment_alerts?${claimQuery.toString()}`, {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ status: "processing", lease_expires_at: leaseExpiresAt }),
    });
    if (!claim.ok) {
      throw new Error(`Payment alert claim failed with HTTP ${claim.status}.`);
    }
    const claimed = (await claim.json()) as unknown[];
    if (claimed.length === 0) continue;

    try {
      await sendAlert(alert);
      const update = await supabaseFetch(
        `wallet_payment_alerts?id=eq.${encodeURIComponent(alert.id)}&status=eq.processing`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "sent",
            sent_at: new Date().toISOString(),
            attempts: alert.attempts + 1,
            last_error: null,
            lease_expires_at: null,
          }),
        },
      );
      if (!update.ok) {
        throw new Error(`Payment alert status update failed with HTTP ${update.status}.`);
      }
      sent += 1;
      console.log(`Payment SMS accepted for ${alert.address.slice(0, 8)}.`);
    } catch (error) {
      const update = await supabaseFetch(
        `wallet_payment_alerts?id=eq.${encodeURIComponent(alert.id)}&status=eq.processing`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "pending",
            attempts: alert.attempts + 1,
            last_error: error instanceof Error ? error.message.slice(0, 500) : "SMS send failed.",
            lease_expires_at: null,
          }),
        },
      );
      if (!update.ok) {
        throw new Error(`Payment alert retry status update failed with HTTP ${update.status}.`);
      }
      console.error(`Payment SMS failed for ${alert.address.slice(0, 8)}.`, error);
    }
  }
  return sent;
}
