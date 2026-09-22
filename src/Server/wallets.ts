import { getSupabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import type { PiPayment } from "./pi";

export type SavedWallet = { address: string; label: string; addedAt: string };

const sessionSecrets = new Map<string, string>();

export function rememberWalletSecret(address: string, secret: string) {
  sessionSecrets.set(address, secret.trim());
}

export function getWalletSecret(address: string): string | undefined {
  return sessionSecrets.get(address);
}

export function forgetWalletSecret(address: string) {
  sessionSecrets.delete(address);
}

export async function loadWallets(): Promise<SavedWallet[]> {
  const user = await getCurrentUser();
  if (!user) return [];
  const { data, error } = await getSupabase()
    .from("wallets")
    .select("address, label, added_at")
    .order("added_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data.map((row) => ({ address: row.address, label: row.label, addedAt: row.added_at }));
}

export async function loadWalletsForUser(username: string): Promise<SavedWallet[]> {
  const { data: profile, error: profileError } = await getSupabase()
    .from("profiles")
    .select("id")
    .eq("username", username.trim().toLowerCase())
    .single();
  if (profileError) throw new Error(profileError.message);
  const { data, error } = await getSupabase()
    .from("wallets")
    .select("address, label, added_at")
    .eq("user_id", profile.id)
    .order("added_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data.map((row) => ({ address: row.address, label: row.label, addedAt: row.added_at }));
}

export async function addWallet(address: string, label: string): Promise<SavedWallet[]> {
  const { error } = await getSupabase()
    .from("wallets")
    .upsert({ address, label: label || "Wallet" }, { onConflict: "user_id,address" });
  if (error) throw new Error(error.message);
  return loadWallets();
}

export async function removeWallet(address: string): Promise<SavedWallet[]> {
  forgetWalletSecret(address);
  const { error } = await getSupabase().from("wallets").delete().eq("address", address);
  if (error) throw new Error(error.message);
  return loadWallets();
}

export async function removeWalletForUser(
  username: string,
  address: string,
): Promise<SavedWallet[]> {
  const wallets = await loadWalletsForUser(username);
  const wallet = wallets.find((item) => item.address === address);
  if (!wallet) return wallets;
  const { error } = await getSupabase().from("wallets").delete().eq("address", address);
  if (error) throw new Error(error.message);
  forgetWalletSecret(address);
  return loadWalletsForUser(username);
}

export async function renameWallet(address: string, label: string): Promise<SavedWallet[]> {
  const { error } = await getSupabase().from("wallets").update({ label }).eq("address", address);
  if (error) throw new Error(error.message);
  return loadWallets();
}

export async function recordWalletPayments(address: string, payments: PiPayment[]): Promise<void> {
  if (payments.length === 0) return;
  const { data: wallet, error: walletError } = await getSupabase()
    .from("wallets")
    .select("id, user_id")
    .eq("address", address)
    .single();
  if (walletError) throw new Error(walletError.message);

  const walletRecord = wallet as { id: string; user_id: string };
  const rows = payments.map((payment) => ({
    wallet_id: walletRecord.id,
    user_id: walletRecord.user_id,
    external_id: payment.id,
    transaction_type: payment.type,
    direction: payment.direction,
    counterparty: payment.counterparty,
    amount: Number(payment.amount) || 0,
    asset: payment.asset,
    created_at: payment.createdAt,
    transaction_hash: payment.hash,
  }));
  const { error } = await getSupabase()
    .from("wallet_transactions")
    .upsert(rows, { onConflict: "user_id,external_id" });
  if (error) throw new Error(error.message);
}
