import { getSupabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import type { PiPayment } from "./pi";

export type SavedWallet = { address: string; label: string; addedAt: string };

const sessionSecrets = new Map<string, string>();
let vaultPassword: string | undefined;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function deriveVaultKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: toArrayBuffer(salt), iterations: 310_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function rememberWalletSecret(address: string, secret: string) {
  sessionSecrets.set(address, secret.trim());
}

export function getWalletSecret(address: string): string | undefined {
  return sessionSecrets.get(address);
}

export function forgetWalletSecret(address: string) {
  sessionSecrets.delete(address);
}

export async function persistWalletSecret(address: string, secret: string, password: string) {
  if (password.trim().length < 12) {
    throw new Error("Use a vault password with at least 12 characters.");
  }
  const { data: wallet, error: walletError } = await getSupabase()
    .from("wallets")
    .select("id, user_id")
    .eq("address", address)
    .single();
  if (walletError) throw new Error(walletError.message);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(password, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    new TextEncoder().encode(secret.trim()),
  );
  const { error } = await getSupabase()
    .from("wallet_secrets")
    .upsert({
      wallet_id: wallet.id,
      user_id: wallet.user_id,
      ciphertext: bytesToBase64(new Uint8Array(encrypted)),
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      updated_at: new Date().toISOString(),
    });
  if (error) throw new Error(error.message);
  vaultPassword = password;
  sessionSecrets.set(address, secret.trim());
}

export async function unlockWalletVault(password: string): Promise<number> {
  if (password.trim().length < 12)
    throw new Error("Vault password must be at least 12 characters.");
  const { data, error } = await getSupabase()
    .from("wallet_secrets")
    .select("ciphertext, salt, iv, wallet_id, wallets(address)");
  if (error) throw new Error(error.message);

  let restored = 0;
  for (const row of data ?? []) {
    try {
      const key = await deriveVaultKey(password, base64ToBytes(row.salt));
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(row.iv)) },
        key,
        toArrayBuffer(base64ToBytes(row.ciphertext)),
      );
      const wallet = row.wallets as unknown as { address?: string } | null;
      if (wallet?.address) {
        sessionSecrets.set(wallet.address, new TextDecoder().decode(plaintext));
        restored += 1;
      }
    } catch {
      throw new Error("Vault password is incorrect or a stored wallet secret is corrupted.");
    }
  }
  vaultPassword = password;
  return restored;
}

export function getVaultPassword(): string | undefined {
  return vaultPassword;
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
