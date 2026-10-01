/**
 * @typedef {Object} PaymentAlertInput
 * @property {string} walletId
 * @property {string} userId
 * @property {string} address
 * @property {string} externalId
 * @property {number} amount
 * @property {string} receivedAt
 *
 * @typedef {Object} PendingAlert
 * @property {string} id
 * @property {string} address
 * @property {number} amount
 * @property {string} received_at
 * @property {number} attempts
 * @property {string} wallet_id
 * @property {{added_at?: string} | null} wallets
 */

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function supabaseFetch(path, init) {
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

/** @param {PaymentAlertInput} alert */
export async function enqueuePaymentAlert(alert) {
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
  const inserted = await response.json();
  if (!Array.isArray(inserted))
    throw new Error("Payment alert queue returned an invalid response.");
  return inserted.length > 0;
}

/** @param {string} phone */
function normalizeKenyanPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  throw new Error("ADMIN_SMS_PHONE must be a valid Kenyan mobile number.");
}

/** @param {PendingAlert} alert */
async function sendAlert(alert) {
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

  const result = await response.json();
  const provider = result.responses?.[0];
  const code = Number(provider?.["respose-code"] ?? provider?.["response-code"]);
  if (code !== 200) {
    throw new Error(provider?.["response-description"] ?? "TextSMS rejected the payment alert.");
  }
}

export async function drainPaymentAlerts() {
  const now = new Date().toISOString();
  const queueQuery = new URLSearchParams({
    or: `(status.eq.pending,and(status.eq.processing,lease_expires_at.lt.${now}))`,
    select: "id,address,amount,received_at,attempts,wallet_id,wallets(added_at)",
    order: "created_at.asc",
    limit: "25",
  });
  const response = await supabaseFetch(`wallet_payment_alerts?${queueQuery.toString()}`);
  if (!response.ok) {
    throw new Error(`Payment alert queue lookup failed with HTTP ${response.status}.`);
  }
  const alerts = await response.json();
  if (!Array.isArray(alerts)) throw new Error("Payment alert queue returned an invalid response.");
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
    const claimed = await claim.json();
    if (!Array.isArray(claimed))
      throw new Error("Payment alert claim returned an invalid response.");
    if (claimed.length === 0) continue;

    const receivedAt = Date.parse(alert.received_at);
    const addedAt = Date.parse(alert.wallets?.added_at ?? "");
    if (!Number.isFinite(receivedAt) || !Number.isFinite(addedAt)) {
      const discard = await supabaseFetch(
        `wallet_payment_alerts?id=eq.${encodeURIComponent(alert.id)}&status=eq.processing`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "discarded",
            last_error: "Missing or invalid wallet/payment timestamp; SMS discarded.",
            lease_expires_at: null,
          }),
        },
      );
      if (!discard.ok) {
        throw new Error(`Invalid payment alert discard failed with HTTP ${discard.status}.`);
      }
      continue;
    }
    if (receivedAt < addedAt) {
      const discard = await supabaseFetch(
        `wallet_payment_alerts?id=eq.${encodeURIComponent(alert.id)}&status=eq.processing`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "discarded",
            last_error: "Payment predates wallet registration; SMS discarded.",
            lease_expires_at: null,
          }),
        },
      );
      if (!discard.ok) {
        throw new Error(
          `Pre-registration payment alert discard failed with HTTP ${discard.status}.`,
        );
      }
      console.log(`Discarded pre-registration payment alert for ${alert.address.slice(0, 8)}.`);
      continue;
    }

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
