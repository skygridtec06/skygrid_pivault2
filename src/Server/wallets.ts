import { getSupabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import type { PiPayment } from "./pi";

export type SavedWallet = { address: string; label: string; addedAt: string };
export type PersistableWallet = SavedWallet & { id: string; userId: string };

const sessionSecrets = new Map<string, string>();
let vaultPassword: string | undefined;
let walletVaultUnlocked = false;
const AUTO_VAULT_PASSWORD_KEY = "pivault-auto-vault-key";

export class WalletKeyMigrationRequiredError extends Error {
  constructor() {
    super("Existing wallet keys need a one-time migration to automatic browser unlock.");
    this.name = "WalletKeyMigrationRequiredError";
  }
}

type EncryptedWalletSecret = {
  wallet_id: string;
  user_id: string;
  ciphertext: string;
  salt: string;
  iv: string;
  wallets: { address?: string } | null;
};

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

async function loadEncryptedWalletSecrets(): Promise<EncryptedWalletSecret[]> {
  const { data, error } = await getSupabase()
    .from("wallet_secrets")
    .select("ciphertext, salt, iv, wallet_id, user_id, wallets(address)");
  if (error) throw new Error(error.message);
  return (data ?? []) as EncryptedWalletSecret[];
}

async function decryptWalletSecret(row: EncryptedWalletSecret, password: string): Promise<string> {
  const key = await deriveVaultKey(password, base64ToBytes(row.salt));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(row.iv)) },
    key,
    toArrayBuffer(base64ToBytes(row.ciphertext)),
  );
  return new TextDecoder().decode(plaintext);
}

async function encryptWalletSecret(
  row: Pick<EncryptedWalletSecret, "wallet_id" | "user_id">,
  secret: string,
  password: string,
) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    new TextEncoder().encode(secret),
  );
  return {
    wallet_id: row.wallet_id,
    user_id: row.user_id,
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    updated_at: new Date().toISOString(),
  };
}

async function migrateAutomaticVault(
  rows: EncryptedWalletSecret[],
  automaticPassword: string,
  previousPassword: string,
): Promise<void> {
  const restored = new Map<string, string>();
  const encryptedRows: Awaited<ReturnType<typeof encryptWalletSecret>>[] = [];
  for (const row of rows) {
    let secret: string;
    try {
      secret = await decryptWalletSecret(row, automaticPassword);
    } catch {
      secret = await decryptWalletSecret(row, previousPassword);
    }
    if (row.wallets?.address) restored.set(row.wallets.address, secret);
    encryptedRows.push(await encryptWalletSecret(row, secret, automaticPassword));
  }

  if (encryptedRows.length > 0) {
    const { error } = await getSupabase()
      .from("wallet_secrets")
      .upsert(encryptedRows, { onConflict: "wallet_id" });
    if (error) throw new Error(`Could not re-encrypt saved wallet keys: ${error.message}`);
  }
  sessionSecrets.clear();
  for (const [address, secret] of restored) sessionSecrets.set(address, secret);
  vaultPassword = automaticPassword;
  walletVaultUnlocked = true;
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

export function lockWalletVault() {
  sessionSecrets.clear();
  vaultPassword = undefined;
  walletVaultUnlocked = false;
}

export async function persistWalletSecret(
  address: string,
  secret: string,
  password: string,
  walletReference?: Pick<PersistableWallet, "id" | "userId">,
) {
  let wallet = walletReference;
  if (!wallet) {
    const { data, error } = await getSupabase()
      .from("wallets")
      .select("id, user_id")
      .eq("address", address)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("The saved wallet could not be found while recording transactions.");
    wallet = { id: data.id, userId: data.user_id };
  }

  const encrypted = await encryptWalletSecret(
    { wallet_id: wallet.id, user_id: wallet.userId },
    secret.trim(),
    password,
  );
  const { error } = await getSupabase()
    .from("wallet_secrets")
    .upsert(encrypted, { onConflict: "wallet_id" });
  if (error) throw new Error(error.message);
  vaultPassword = password;
  sessionSecrets.set(address, secret.trim());
}

export function getOrCreateVaultPassword(): string {
  if (vaultPassword) return vaultPassword;
  const existing = window.localStorage.getItem(AUTO_VAULT_PASSWORD_KEY);
  if (existing && existing.length >= 12) {
    vaultPassword = existing;
    return existing;
  }
  const generated = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  window.localStorage.setItem(AUTO_VAULT_PASSWORD_KEY, generated);
  vaultPassword = generated;
  return generated;
}

export async function unlockWalletVaultAutomatically(previousPassword?: string): Promise<number> {
  if (walletVaultUnlocked) return sessionSecrets.size;
  const rows = await loadEncryptedWalletSecrets();
  const automaticPassword = getOrCreateVaultPassword();
  const restored = new Map<string, string>();

  try {
    for (const row of rows) {
      const secret = await decryptWalletSecret(row, automaticPassword);
      if (row.wallets?.address) restored.set(row.wallets.address, secret);
    }
    sessionSecrets.clear();
    for (const [address, secret] of restored) sessionSecrets.set(address, secret);
    walletVaultUnlocked = true;
    return restored.size;
  } catch {
    if (rows.length === 0) throw new Error("No encrypted wallet keys were found.");
  }

  if (!previousPassword) throw new WalletKeyMigrationRequiredError();
  try {
    await migrateAutomaticVault(rows, automaticPassword, previousPassword.trim());
    return sessionSecrets.size;
  } catch {
    throw new Error(
      "The previous vault password is incorrect or a stored wallet key is corrupted.",
    );
  }
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

export async function addWallet(address: string, label: string): Promise<PersistableWallet | null> {
  const { data, error } = await getSupabase()
    .from("wallets")
    .upsert(
      { address, label: label || "Wallet" },
      { onConflict: "user_id,address", ignoreDuplicates: true },
    )
    .select("id, user_id, address, label, added_at")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    id: data.id,
    userId: data.user_id,
    address: data.address,
    label: data.label,
    addedAt: data.added_at,
  };
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
