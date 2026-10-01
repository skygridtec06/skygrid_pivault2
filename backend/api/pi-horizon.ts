type VercelRequest = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body: unknown;
};
type VercelResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => VercelResponse;
  json: (body: unknown) => VercelResponse;
  end: () => VercelResponse;
};

const HORIZON_URL = "https://api.mainnet.minepi.com";
const PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;

function setCors(response: VercelResponse) {
  response.setHeader("Access-Control-Allow-Origin", "https://nelpivault.vercel.app");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function queryValue(query: VercelRequest["query"], name: string): string | undefined {
  const value = query?.[name];
  return Array.isArray(value) ? value[0] : value;
}

async function proxyGet(
  path: string,
  response: VercelResponse,
  includeNextCursor = false,
): Promise<VercelResponse> {
  const upstream = await fetch(`${HORIZON_URL}${path}`, {
    headers: { accept: "application/json" },
  });
  const body: unknown = await upstream.json();
  if (!upstream.ok) return response.status(upstream.status).json(body);

  if (includeNextCursor && body && typeof body === "object") {
    const page = body as {
      _links?: { next?: { href?: string } };
    };
    const nextHref = page._links?.next?.href;
    if (nextHref) {
      const cursor = new URL(nextHref).searchParams.get("cursor");
      return response.status(200).json({ ...page, nextCursor: cursor });
    }
  }
  return response.status(200).json(body);
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  setCors(response);
  if (request.method === "OPTIONS") return response.status(204).end();

  const action = queryValue(request.query, "action");
  if (action === "submit_transaction") {
    if (request.method !== "POST") {
      return response.status(405).json({ error: "Method not allowed." });
    }
    if (!request.body || typeof request.body !== "object") {
      return response.status(400).json({ error: "A signed transaction is required." });
    }
    const tx = (request.body as Record<string, unknown>)["tx"];
    if (typeof tx !== "string" || tx.length === 0 || tx.length > 100_000) {
      return response.status(400).json({ error: "Invalid signed transaction." });
    }

    try {
      const upstream = await fetch(`${HORIZON_URL}/transactions`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ tx }),
      });
      const body: unknown = await upstream.json();
      return response.status(upstream.status).json(body);
    } catch (error) {
      console.error("Pi transaction submission proxy failed", error);
      return response.status(502).json({ error: "Unable to contact the Pi network." });
    }
  }

  if (request.method !== "GET") {
    return response.status(405).json({ error: "Method not allowed." });
  }

  if (action === "fee_stats") {
    try {
      return await proxyGet("/fee_stats", response);
    } catch (error) {
      console.error("Pi fee lookup proxy failed", error);
      return response.status(502).json({ error: "Unable to contact the Pi network." });
    }
  }

  const address = queryValue(request.query, "address");
  if (!address || !PUBLIC_KEY_PATTERN.test(address)) {
    return response.status(400).json({ error: "A valid Pi wallet address is required." });
  }

  try {
    if (action === "account") {
      return await proxyGet(`/accounts/${encodeURIComponent(address)}`, response);
    }
    if (action === "claimable_balances") {
      return await proxyGet(
        `/claimable_balances?claimant=${encodeURIComponent(address)}&limit=50`,
        response,
      );
    }
    if (action === "payments") {
      const cursor = queryValue(request.query, "cursor");
      if (cursor && (cursor.length > 128 || !/^[0-9]+$/.test(cursor))) {
        return response.status(400).json({ error: "Invalid payment cursor." });
      }
      const params = new URLSearchParams({ order: "desc", limit: "200" });
      if (cursor) params.set("cursor", cursor);
      return await proxyGet(
        `/accounts/${encodeURIComponent(address)}/payments?${params.toString()}`,
        response,
        true,
      );
    }
    return response.status(400).json({ error: "Unsupported Pi network request." });
  } catch (error) {
    console.error("Pi network proxy failed", error);
    return response.status(502).json({ error: "Unable to contact the Pi network." });
  }
}
