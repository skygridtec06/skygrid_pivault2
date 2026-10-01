import { getSupabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import type { PiPayment } from "./pi";

export type SavedWallet = { address: string; label: string; addedAt: string };
export type PersistableWallet = SavedWallet & { id: string; userId: string };

const sessionSecrets = new Map<string, string>();
let vaultPassword: string | undefined;
const AUTO_VAULT_PASSWORD_KEY = "pivault-auto-vault-key";
const VAULT_BACKUP_VERSION = 1;

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

function validateVaultPassword(password: string): string {
  const normalized = password.trim();
  if (normalized.length < 12) throw new Error("Use a vault password with at least 12 characters.");
  return normalized;
}

function promptForVaultPassword(
  title: string,
  description: string,
  autocomplete: "current-password" | "new-password" = "current-password",
): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className =
      "w-[calc(100%-2rem)] max-w-md rounded-2xl border border-border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/60";
    const form = document.createElement("form");
    form.className = "space-y-5 p-6";
    const heading = document.createElement("h2");
    heading.className = "text-xl font-bold";
    heading.textContent = title;
    const help = document.createElement("p");
    help.className = "text-sm text-muted-foreground";
    help.textContent = description;
    const label = document.createElement("label");
    label.className = "block text-xs font-semibold uppercase tracking-[0.16em]";
    label.textContent = "Vault password";
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = autocomplete;
    input.minLength = 12;
    input.required = true;
    input.className =
      "mt-2 w-full rounded-xl border border-border bg-input/40 px-4 py-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40";
    input.placeholder = "At least 12 characters";
    const error = document.createElement("p");
    error.className = "hidden text-sm text-destructive";
    const actions = document.createElement("div");
    actions.className = "flex justify-end gap-3";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "rounded-xl border border-border px-4 py-2.5 text-sm font-semibold";
    cancel.textContent = "Cancel";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className =
      "rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground";
    submit.textContent = "Continue";
    actions.append(cancel, submit);
    label.append(input);
    form.append(heading, help, label, error, actions);
    dialog.append(form);

    cancel.addEventListener("click", () => dialog.close());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        validateVaultPassword(input.value);
        dialog.close(input.value);
      } catch (reason) {
        error.textContent = reason instanceof Error ? reason.message : "Invalid vault password.";
        error.classList.remove("hidden");
      }
    });
    dialog.addEventListener(
      "close",
      () => {
        const password = dialog.returnValue || null;
        dialog.remove();
        resolve(password);
      },
      { once: true },
    );
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

async function promptForNewVaultPassword(): Promise<string> {
  const password = await promptForVaultPassword(
    "Create your vault password",
    "This password encrypts wallet keys before they are saved to Supabase. It is never stored. If you forget it, the encrypted keys cannot be recovered.",
    "new-password",
  );
  if (!password) throw new Error("Vault password setup was cancelled.");
  const confirmation = await promptForVaultPassword(
    "Confirm your vault password",
    "Enter the same vault password again to confirm it.",
    "new-password",
  );
  if (!confirmation) throw new Error("Vault password setup was cancelled.");
  if (password !== confirmation) throw new Error("The vault passwords do not match.");
  return validateVaultPassword(password);
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
  password: string,
): Promise<void> {
  const restored = new Map<string, string>();
  const encryptedRows = [];
  for (const row of rows) {
    let secret: string;
    try {
      secret = await decryptWalletSecret(row, password);
    } catch {
      secret = await decryptWalletSecret(row, automaticPassword);
    }
    if (row.wallets?.address) restored.set(row.wallets.address, secret);
    encryptedRows.push(await encryptWalletSecret(row, secret, password));
  }

  if (encryptedRows.length > 0) {
    const { error } = await getSupabase()
      .from("wallet_secrets")
      .upsert(encryptedRows, { onConflict: "wallet_id" });
    if (error) throw new Error(`Could not re-encrypt saved wallet keys: ${error.message}`);
  }
  sessionSecrets.clear();
  for (const [address, secret] of restored) sessionSecrets.set(address, secret);
  vaultPassword = password;
  window.localStorage.removeItem(AUTO_VAULT_PASSWORD_KEY);
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
}

export async function persistWalletSecret(
  address: string,
  secret: string,
  password: string,
  walletReference?: Pick<PersistableWallet, "id" | "userId">,
) {
  password = validateVaultPassword(password);
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

export async function exportEncryptedVaultBackup(password: string): Promise<string> {
  password = validateVaultPassword(password);
  const wallets = [...sessionSecrets.entries()].map(([address, secret]) => ({ address, secret }));
  if (wallets.length === 0)
    throw new Error("Unlock at least one wallet before exporting a backup.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(password, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    new TextEncoder().encode(
      JSON.stringify({
        version: VAULT_BACKUP_VERSION,
        createdAt: new Date().toISOString(),
        wallets,
      }),
    ),
  );
  return JSON.stringify({
    version: VAULT_BACKUP_VERSION,
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
  });
}

export async function importEncryptedVaultBackup(
  backupText: string,
  password: string,
  vaultEncryptionPassword: string,
): Promise<number> {
  password = validateVaultPassword(password);
  vaultEncryptionPassword = validateVaultPassword(vaultEncryptionPassword);
  let backup: { version?: number; ciphertext?: string; salt?: string; iv?: string };
  try {
    backup = JSON.parse(backupText) as typeof backup;
  } catch {
    throw new Error("This is not a valid Pi Vault backup file.");
  }
  if (backup.version !== VAULT_BACKUP_VERSION || !backup.ciphertext || !backup.salt || !backup.iv) {
    throw new Error("This backup file is not supported.");
  }
  let payload: { version?: number; wallets?: Array<{ address?: string; secret?: string }> };
  try {
    const key = await deriveVaultKey(password, base64ToBytes(backup.salt));
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(backup.iv)) },
      key,
      toArrayBuffer(base64ToBytes(backup.ciphertext)),
    );
    payload = JSON.parse(new TextDecoder().decode(decrypted)) as typeof payload;
  } catch {
    throw new Error("The backup password is incorrect or the backup is corrupted.");
  }
  if (payload.version !== VAULT_BACKUP_VERSION || !Array.isArray(payload.wallets)) {
    throw new Error("This backup payload is not supported.");
  }
  let imported = 0;
  for (const wallet of payload.wallets) {
    if (!wallet.address || !wallet.secret) continue;
    await persistWalletSecret(wallet.address, wallet.secret, vaultEncryptionPassword);
    imported += 1;
  }
  return imported;
}

export async function unlockWalletVault(password: string): Promise<number> {
  password = validateVaultPassword(password);
  const rows = await loadEncryptedWalletSecrets();
  const restoredSecrets = new Map<string, string>();
  for (const row of rows) {
    try {
      const secret = await decryptWalletSecret(row, password);
      if (row.wallets?.address) restoredSecrets.set(row.wallets.address, secret);
    } catch {
      sessionSecrets.clear();
      vaultPassword = undefined;
      throw new Error("Vault password is incorrect or a stored wallet secret is corrupted.");
    }
  }
  sessionSecrets.clear();
  for (const [address, secret] of restoredSecrets) sessionSecrets.set(address, secret);
  vaultPassword = password;
  return restoredSecrets.size;
}

export async function requestVaultPassword(): Promise<string> {
  if (vaultPassword) return vaultPassword;
  const rows = await loadEncryptedWalletSecrets();
  const automaticPassword = window.localStorage.getItem(AUTO_VAULT_PASSWORD_KEY);
  if (rows.length > 0 && automaticPassword) {
    const password = await promptForNewVaultPassword();
    await migrateAutomaticVault(rows, automaticPassword, password);
    return password;
  }
  if (rows.length > 0) {
    const password = await promptForVaultPassword(
      "Unlock your vault",
      "Enter the password you chose to encrypt your wallet keys.",
    );
    if (!password) throw new Error("Vault unlock was cancelled.");
    await unlockWalletVault(password);
    return password;
  }
  const password = await promptForNewVaultPassword();
  window.localStorage.removeItem(AUTO_VAULT_PASSWORD_KEY);
  vaultPassword = password;
  return password;
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
