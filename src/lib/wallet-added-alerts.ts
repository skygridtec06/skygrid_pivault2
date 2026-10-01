import { getSupabase } from "@/lib/supabase";

type WalletAddedAlertData = {
  address: string;
  balance: number;
  addedAt: string;
};

export type WalletAddedAlertResult = { sent: true } | { sent: false; reason: string };

const backendUrl =
  import.meta.env["VITE_BACKEND_URL"] ?? "https://skygrid-pivault-backend.vercel.app";

export async function sendWalletAddedAlert(
  data: WalletAddedAlertData,
): Promise<WalletAddedAlertResult> {
  const supabase = getSupabase();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError) throw new Error(userError.message);
  if (!user) return { sent: false, reason: "Sign in with an admin account to send SMS alerts." };

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) throw new Error(profileError.message);
  if (!profile?.is_admin) {
    return {
      sent: false,
      reason: "SMS not sent: this account is not enabled as a server-side admin.",
    };
  }

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw new Error(sessionError.message);
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    return { sent: false, reason: "Sign in with an admin account to send SMS alerts." };
  }

  const response = await fetch(`${backendUrl}/api/wallet-added-alert`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(data),
  });

  const result = (await response.json()) as { sent?: boolean; reason?: string; error?: string };
  if (!response.ok) throw new Error(result.error ?? `Backend returned HTTP ${response.status}.`);
  if (!result.sent) return { sent: false, reason: result.reason ?? "SMS was not sent." };
  return { sent: true };
}
