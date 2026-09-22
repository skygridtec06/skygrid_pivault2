// Saved wallet list and the local secret-key vault for wallets added on this device.
import { getCurrentUser } from "@/lib/auth";

export type SavedWallet = {
  address: string;
  label: string;
  addedAt: string;
};

const KEY_PREFIX = "pi_saved_wallets_v1:";
const SECRET_KEY_PREFIX = "pi_wallet_secret_v1:";
const sessionSecrets = new Map<string, string>();

function storageKey(username = getCurrentUser()?.username) {
  return username ? `${KEY_PREFIX}${username}` : `${KEY_PREFIX}guest`;
}

export function rememberWalletSecret(address: string, secret: string) {
  const normalizedSecret = secret.trim();
  sessionSecrets.set(address, normalizedSecret);
  const username = getCurrentUser()?.username;
  if (typeof window !== "undefined" && username) {
    window.localStorage.setItem(`${SECRET_KEY_PREFIX}${username}:${address}`, normalizedSecret);
  }
}

export function getWalletSecret(address: string): string | undefined {
  const inMemory = sessionSecrets.get(address);
  if (inMemory) return inMemory;
  if (typeof window === "undefined") return undefined;

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(SECRET_KEY_PREFIX) || !key.endsWith(`:${address}`)) continue;
    const secret = window.localStorage.getItem(key);
    if (secret) {
      sessionSecrets.set(address, secret);
      return secret;
    }
  }
  return undefined;
}

export function forgetWalletSecret(address: string) {
  sessionSecrets.delete(address);
  if (typeof window === "undefined") return;
  const keysToRemove: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(SECRET_KEY_PREFIX) && key.endsWith(`:${address}`)) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => window.localStorage.removeItem(key));
}

export function loadWallets(): SavedWallet[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedWallet[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(list: SavedWallet[]) {
  window.localStorage.setItem(storageKey(), JSON.stringify(list));
}

export function loadWalletsForUser(username: string): SavedWallet[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(username));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedWallet[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addWallet(address: string, label: string): SavedWallet[] {
  const list = loadWallets();
  if (!list.some((w) => w.address === address)) {
    list.unshift({ address, label: label || "Wallet", addedAt: new Date().toISOString() });
    persist(list);
  }
  return list;
}

export function removeWallet(address: string): SavedWallet[] {
  forgetWalletSecret(address);
  const list = loadWallets().filter((w) => w.address !== address);
  persist(list);
  return list;
}

export function removeWalletForUser(username: string, address: string): SavedWallet[] {
  forgetWalletSecret(address);
  const list = loadWalletsForUser(username).filter((wallet) => wallet.address !== address);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(storageKey(username), JSON.stringify(list));
  }
  return list;
}

export function renameWallet(address: string, label: string): SavedWallet[] {
  const list = loadWallets().map((w) => (w.address === address ? { ...w, label } : w));
  persist(list);
  return list;
}
