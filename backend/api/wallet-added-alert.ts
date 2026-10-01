type VercelRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body: unknown;
};
type VercelResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => VercelResponse;
  json: (body: unknown) => VercelResponse;
  end: () => VercelResponse;
};
declare const process: { env: Record<string, string | undefined> };

type WalletAddedAlert = {
  address: string;
  balance: number;
  addedAt: string;
};

function setCors(response: VercelResponse) {
  response.setHeader("Access-Control-Allow-Origin", "https://nelpivault.vercel.app");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function isValidPayload(value: unknown): value is WalletAddedAlert {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.address === "string" &&
    /^G[A-Z2-7]{55}$/.test(data.address) &&
    typeof data.balance === "number" &&
    Number.isFinite(data.balance) &&
    data.balance > 2 &&
    typeof data.addedAt === "string" &&
    !Number.isNaN(Date.parse(data.addedAt))
  );
}

function requestHeader(headers: VercelRequest["headers"], name: string): string | undefined {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function normalizeKenyanPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  throw new Error("ADMIN_SMS_PHONE must be a valid Kenyan mobile number.");
}

async function isAuthenticatedAdmin(accessToken: string): Promise<boolean> {
  const supabaseUrl = process.env["SUPABASE_URL"];
  const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Server database environment is not configured.");
  }

  const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  if (!authResponse.ok) return false;
  const user = (await authResponse.json()) as { id?: string };
  if (!user.id || !/^[0-9a-f-]{36}$/i.test(user.id)) return false;

  const profileResponse = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=is_admin`,
    {
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        accept: "application/json",
      },
    },
  );
  if (!profileResponse.ok) {
    throw new Error(`Admin profile lookup failed with HTTP ${profileResponse.status}.`);
  }
  const profiles = (await profileResponse.json()) as Array<{ is_admin?: boolean }>;
  return profiles[0]?.is_admin === true;
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  setCors(response);
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "POST") return response.status(405).json({ error: "Method not allowed." });
  if (!isValidPayload(request.body)) {
    return response.status(400).json({ error: "Invalid wallet-added alert payload." });
  }

  const authorization = requestHeader(request.headers, "authorization");
  const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) return response.status(401).json({ error: "Authentication required." });

  try {
    if (!(await isAuthenticatedAdmin(accessToken))) {
      return response.status(200).json({
        sent: false,
        reason: "SMS not sent: this account is not enabled as a server-side admin.",
      });
    }

    const apiKey = process.env["TEXTSMS_API_KEY"];
    const partnerId = process.env["TEXTSMS_PARTNER_ID"];
    const shortcode = process.env["TEXTSMS_SHORTCODE"];
    const adminPhone = process.env["ADMIN_SMS_PHONE"];
    const apiUrl =
      process.env["TEXTSMS_API_URL"] ?? "https://sms.textsms.co.ke/api/services/sendsms/";

    if (!apiKey || !partnerId || !shortcode || !adminPhone) {
      return response
        .status(200)
        .json({ sent: false, reason: "SMS notifications are not configured on the backend." });
    }

    const data = request.body;
    const providerResponse = await fetch(apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        apikey: apiKey,
        partnerID: partnerId,
        shortcode,
        mobile: normalizeKenyanPhone(adminPhone),
        message: [
          "Pi wallet added with more than 2 Pi.",
          `Wallet: ${data.address}`,
          `Added: ${new Date(data.addedAt).toLocaleString("en-KE")}`,
          `Pi balance: ${data.balance.toFixed(7)} Pi`,
        ].join("\n"),
      }),
    });

    if (!providerResponse.ok) {
      return response.status(200).json({
        sent: false,
        reason: `SMS provider returned HTTP ${providerResponse.status}.`,
      });
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
      return response.status(200).json({
        sent: false,
        reason: provider?.["response-description"] ?? "TextSMS rejected the wallet-added alert.",
      });
    }

    return response.status(200).json({ sent: true });
  } catch (error) {
    console.error("Wallet-added SMS alert failed", error);
    return response
      .status(200)
      .json({ sent: false, reason: "Unable to send the wallet-added SMS alert." });
  }
}
