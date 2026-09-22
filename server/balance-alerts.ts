export type BalanceAlertData = {
  address: string;
  amount: number;
  availableBalance: number;
  receivedAt: string;
};

export async function sendBalanceAlert(data: BalanceAlertData): Promise<void> {
  const apiKey = process.env["TEXTSMS_API_KEY"];
  const partnerId = process.env["TEXTSMS_PARTNER_ID"];
  const shortcode = process.env["TEXTSMS_SHORTCODE"];
  const adminPhone = process.env["ADMIN_SMS_PHONE"];
  const apiUrl =
    process.env["TEXTSMS_API_URL"] ?? "https://sms.textsms.co.ke/api/services/sendsms/";

  if (!apiKey || !partnerId || !shortcode || !adminPhone) {
    throw new Error(
      "SMS notifications are not configured. Set TEXTSMS_API_KEY, TEXTSMS_PARTNER_ID, TEXTSMS_SHORTCODE, and ADMIN_SMS_PHONE.",
    );
  }

  const message = [
    "Pi wallet received funds.",
    `Wallet: ${data.address}`,
    `Received: ${data.amount.toFixed(7)} Pi`,
    `Date: ${new Date(data.receivedAt).toLocaleString("en-KE")}`,
    `Available balance: ${data.availableBalance.toFixed(7)} Pi`,
  ].join("\n");

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      apikey: apiKey,
      partnerID: partnerId,
      shortcode,
      mobile: normalizeKenyanPhone(adminPhone),
      message,
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
  const providerResponse = result.responses?.[0];
  const responseCode = Number(
    providerResponse?.["respose-code"] ?? providerResponse?.["response-code"],
  );
  if (responseCode !== 200) {
    throw new Error(
      providerResponse?.["response-description"] ?? "TextSMS rejected the balance alert.",
    );
  }
}

function normalizeKenyanPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  throw new Error("ADMIN_SMS_PHONE must be a valid Kenyan mobile number.");
}
