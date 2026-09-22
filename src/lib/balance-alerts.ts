type BalanceAlertData = {
  address: string;
  amount: number;
  availableBalance: number;
  receivedAt: string;
};

const backendUrl =
  import.meta.env["VITE_BACKEND_URL"] ?? "https://skygrid-pivault-backend.vercel.app";

export async function sendBalanceAlert(data: BalanceAlertData): Promise<void> {
  const response = await fetch(`${backendUrl}/api/balance-alert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Backend returned HTTP ${response.status}.`);
  }
}
