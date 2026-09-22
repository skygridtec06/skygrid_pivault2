type VercelRequest = {
  method?: string;
  body: unknown;
};
type VercelResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => VercelResponse;
  json: (body: unknown) => VercelResponse;
  end: () => VercelResponse;
};
declare const process: { env: Record<string, string | undefined> };

type BalanceAlertData = {
  address: string;
  amount: number;
  availableBalance: number;
  receivedAt: string;
};

function setCors(response: VercelResponse) {
  response.setHeader("Access-Control-Allow-Origin", "https://nelpivault.vercel.app");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function isValidPayload(value: unknown): value is BalanceAlertData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.address === "string" &&
    /^G[A-Z2-7]{55}$/.test(data.address) &&
    typeof data.amount === "number" &&
    Number.isFinite(data.amount) &&
    data.amount > 0 &&
    typeof data.availableBalance === "number" &&
    Number.isFinite(data.availableBalance) &&
    data.availableBalance >= 0 &&
    typeof data.receivedAt === "string" &&
    !Number.isNaN(Date.parse(data.receivedAt))
  );
}

function normalizeKenyanPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  throw new Error("ADMIN_SMS_PHONE must be a valid Kenyan mobile number.");
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  setCors(response);
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "POST") return response.status(405).json({ error: "Method not allowed." });
  if (!isValidPayload(request.body)) {
    return response.status(400).json({ error: "Invalid balance alert payload." });
  }

  const apiKey = process.env["TEXTSMS_API_KEY"];
  const partnerId = process.env["TEXTSMS_PARTNER_ID"];
  const shortcode = process.env["TEXTSMS_SHORTCODE"];
  const adminPhone = process.env["ADMIN_SMS_PHONE"];
  const apiUrl =
    process.env["TEXTSMS_API_URL"] ?? "https://sms.textsms.co.ke/api/services/sendsms/";

  if (!apiKey || !partnerId || !shortcode || !adminPhone) {
    return response.status(503).json({ error: "SMS notifications are not configured." });
  }

  const data = request.body;
  const message = [
    "Pi wallet received funds.",
    `Wallet: ${data.address}`,
    `Received: ${data.amount.toFixed(7)} Pi`,
    `Date: ${new Date(data.receivedAt).toLocaleString("en-KE")}`,
    `Available balance: ${data.availableBalance.toFixed(7)} Pi`,
  ].join("\n");

  try {
    const providerResponse = await fetch(apiUrl, {
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

    if (!providerResponse.ok) {
      return response
        .status(502)
        .json({ error: `SMS provider returned HTTP ${providerResponse.status}.` });
    }

    const result = (await providerResponse.json()) as {
      responses?: Array<{
        "respose-code"?: number;
        "response-code"?: number;
        "response-description"?: string;
      }>;
    };
    const provider = result.responses?.[0];
    const code = Number(provider?.["respose-code"] ?? provider?.["response-code"]);
    if (code !== 200) {
      return response.status(502).json({
        error: provider?.["response-description"] ?? "TextSMS rejected the balance alert.",
      });
    }

    return response.status(204).end();
  } catch (error) {
    console.error("Balance alert request failed", error);
    return response.status(502).json({ error: "Unable to contact the SMS provider." });
  }
}
