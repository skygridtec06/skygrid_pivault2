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
  profiles: { username?: string } | null;
};

type WalletCiphertextBackupEntry = {
  address: string;
  ownerUsername: string;
  ciphertext: string;
  salt: string;
  iv: string;
};

type WalletCiphertextBackupPayload = {
  version: 1;
  createdAt: string;
  sourceEncryptionKey: string;
  wallets: WalletCiphertextBackupEntry[];
};

type LegacyWalletBackupPayload = {
  version: 1;
  createdAt: string;
  wallets: Array<{ address: string; secret: string }>;
};

type WalletCiphertextBackupFile = {
  version: 1;
  ciphertext: string;
  salt: string;
  iv: string;
};

const WALLET_CIPHERTEXT_BACKUP_VERSION = 1;

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

function validateBackupPassword(password: string): string {
  const normalized = password.trim();
  if (normalized.length < 12) throw new Error("Use a backup password with at least 12 characters.");
  return normalized;
}

async function loadEncryptedWalletSecrets(): Promise<EncryptedWalletSecret[]> {
  const { data, error } = await getSupabase()
    .from("wallet_secrets")
    .select("ciphertext, salt, iv, wallet_id, user_id, wallets(address), profiles(username)");
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

function isWalletCiphertextBackupPayload(value: unknown): value is WalletCiphertextBackupPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return (
    payload["version"] === WALLET_CIPHERTEXT_BACKUP_VERSION &&
    typeof payload["createdAt"] === "string" &&
    typeof payload["sourceEncryptionKey"] === "string" &&
    Array.isArray(payload["wallets"]) &&
    payload["wallets"].every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof entry["address"] === "string" &&
        /^G[A-Z2-7]{55}$/.test(entry["address"]) &&
        typeof entry["ownerUsername"] === "string" &&
        typeof entry["ciphertext"] === "string" &&
        typeof entry["salt"] === "string" &&
        typeof entry["iv"] === "string",
    )
  );
}

function isLegacyWalletBackupPayload(value: unknown): value is LegacyWalletBackupPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return (
    payload["version"] === WALLET_CIPHERTEXT_BACKUP_VERSION &&
    typeof payload["createdAt"] === "string" &&
    Array.isArray(payload["wallets"]) &&
    payload["wallets"].every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof entry["address"] === "string" &&
        /^G[A-Z2-7]{55}$/.test(entry["address"]) &&
        typeof entry["secret"] === "string" &&
        entry["secret"].length > 0,
    )
  );
}

export async function exportEncryptedWalletCiphertextBackup(
  backupPassword: string,
): Promise<string> {
  backupPassword = validateBackupPassword(backupPassword);
  await unlockWalletVaultAutomatically();
  const rows = await loadEncryptedWalletSecrets();
  if (rows.length === 0) throw new Error("No encrypted wallet keys are available to export.");

  const wallets: WalletCiphertextBackupEntry[] = [];
  for (const row of rows) {
    const address = row.wallets?.address;
    const ownerUsername = row.profiles?.username;
    if (!address || !ownerUsername) {
      throw new Error("A saved encrypted wallet key is missing its wallet or owner record.");
    }
    await decryptWalletSecret(row, getOrCreateVaultPassword());
    wallets.push({
      address,
      ownerUsername,
      ciphertext: row.ciphertext,
      salt: row.salt,
      iv: row.iv,
    });
  }
  if (wallets.length === 0)
    throw new Error("No valid encrypted wallet keys are available to export.");

  const payload: WalletCiphertextBackupPayload = {
    version: WALLET_CIPHERTEXT_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    sourceEncryptionKey: getOrCreateVaultPassword(),
    wallets,
  };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(backupPassword, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const backup: WalletCiphertextBackupFile = {
    version: WALLET_CIPHERTEXT_BACKUP_VERSION,
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
  };
  return JSON.stringify(backup);
}

export async function importEncryptedWalletCiphertextBackup(
  backupText: string,
  backupPassword: string,
): Promise<number> {
  backupPassword = validateBackupPassword(backupPassword);

  let backup: WalletCiphertextBackupFile;
  try {
    const parsed: unknown = JSON.parse(backupText);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as Record<string, unknown>)["version"] !== WALLET_CIPHERTEXT_BACKUP_VERSION ||
      typeof (parsed as Record<string, unknown>)["ciphertext"] !== "string" ||
      typeof (parsed as Record<string, unknown>)["salt"] !== "string" ||
      typeof (parsed as Record<string, unknown>)["iv"] !== "string"
    ) {
      throw new Error("unsupported");
    }
    backup = parsed as WalletCiphertextBackupFile;
  } catch {
    throw new Error("This is not a supported encrypted wallet backup.");
  }

  let payload: unknown;
  try {
    const key = await deriveVaultKey(backupPassword, base64ToBytes(backup.salt));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(backup.iv)) },
      key,
      toArrayBuffer(base64ToBytes(backup.ciphertext)),
    );
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error("The backup password is incorrect or the backup is corrupted.");
  }
  const ciphertextPayload = isWalletCiphertextBackupPayload(payload) ? payload : null;
  const legacyPayload = isLegacyWalletBackupPayload(payload) ? payload : null;
  if (!ciphertextPayload && !legacyPayload) {
    throw new Error("The encrypted wallet backup contents are invalid.");
  }

  const targetEncryptionKey = getOrCreateVaultPassword();
  const rows = [];
  const restoredSecrets = new Map<string, string>();
  const backupEntries: Array<{
    address: string;
    ownerUsername?: string;
    readSecret: () => Promise<string>;
  }> = [];
  if (ciphertextPayload) {
    for (const entry of ciphertextPayload.wallets) {
      backupEntries.push({
        address: entry.address,
        ownerUsername: entry.ownerUsername,
        readSecret: () =>
          decryptWalletSecret(
            {
              wallet_id: "",
              user_id: "",
              ciphertext: entry.ciphertext,
              salt: entry.salt,
              iv: entry.iv,
              wallets: { address: entry.address },
              profiles: null,
            },
            ciphertextPayload.sourceEncryptionKey,
          ),
      });
    }
  } else if (legacyPayload) {
    for (const entry of legacyPayload.wallets) {
      backupEntries.push({
        address: entry.address,
        readSecret: async () => entry.secret,
      });
    }
  }

  for (const entry of backupEntries) {
    let ownerId: string | undefined;
    if (entry.ownerUsername) {
      const { data: profile, error: profileError } = await getSupabase()
        .from("profiles")
        .select("id")
        .eq("username", entry.ownerUsername)
        .maybeSingle();
      if (profileError) {
        throw new Error(
          `Could not find the wallet owner for ${entry.address}: ${profileError.message}`,
        );
      }
      if (!profile?.id) {
        throw new Error(`Wallet owner "${entry.ownerUsername}" was not found for this backup.`);
      }
      ownerId = profile.id;
    }
    const walletQuery = getSupabase()
      .from("wallets")
      .select("id, user_id")
      .eq("address", entry.address);
    const { data: wallet, error } = ownerId
      ? await walletQuery.eq("user_id", ownerId).maybeSingle()
      : await walletQuery.maybeSingle();
    if (error) throw new Error(`Could not find wallet ${entry.address}: ${error.message}`);
    if (!wallet) {
      throw new Error(
        `Add wallet ${entry.address.slice(0, 8)}… to this account before importing its key.`,
      );
    }

    let secret: string;
    try {
      secret = await entry.readSecret();
    } catch {
      throw new Error(
        `Encrypted key for ${entry.address.slice(0, 8)}… could not be opened from the backup.`,
      );
    }
    rows.push(
      await encryptWalletSecret(
        { wallet_id: wallet.id, user_id: wallet.user_id },
        secret,
        targetEncryptionKey,
      ),
    );
    restoredSecrets.set(entry.address, secret);
  }

  if (rows.length > 0) {
    const { error } = await getSupabase()
      .from("wallet_secrets")
      .upsert(rows, { onConflict: "wallet_id" });
    if (error) throw new Error(`Could not restore encrypted wallet keys: ${error.message}`);
  }
  for (const [address, secret] of restoredSecrets) sessionSecrets.set(address, secret);
  walletVaultUnlocked = true;
  return restoredSecrets.size;
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
    if (rows.length === 0) {
      sessionSecrets.clear();
      walletVaultUnlocked = true;
      return 0;
    }
  }

  if (!previousPassword) throw new WalletKeyMigrationRequiredError();
  try {
    await migrateAutomaticVault(rows, automaticPassword, previousPassword.trim());
    return sessionSecrets.size;
  } catch {
    throw new Error(
      "These keys could not be unlocked with that previous password. If you are using another device, import the encrypted backup made on the device where the keys are available. Its backup password is separate from your sign-in password.",
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
