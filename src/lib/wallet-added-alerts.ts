import { getSupabase } from "@/lib/supabase";

type WalletAddedAlertData = {
  address: string;
  balance: number;
  addedAt: string;
};

const backendUrl =
  import.meta.env["VITE_BACKEND_URL"] ?? "https://skygrid-pivault-backend.vercel.app";

export async function sendWalletAddedAlert(data: WalletAddedAlertData): Promise<void> {
  const { data: sessionData, error: sessionError } = await getSupabase().auth.getSession();
  if (sessionError) throw new Error(sessionError.message);
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Sign in as an admin to send wallet SMS alerts.");

  const response = await fetch(`${backendUrl}/api/wallet-added-alert`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Backend returned HTTP ${response.status}.`);
  }
}
