export type AuthUser = {
  username: string;
};

export type ManagedUser = AuthUser & {
  createdAt: string;
};

type StoredUser = AuthUser & {
  salt: string;
  pinHash: string;
  createdAt: string;
};

const USERS_KEY = "pi_vault_users_v2";
const SESSION_KEY = "pi_vault_session_v1";

function readUsers(): StoredUser[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(USERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredUser[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeUsers(users: StoredUser[]) {
  window.localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function hashPin(pin: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 120_000, hash: "SHA-256" },
    key,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
}

export function getCurrentUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  const username = window.sessionStorage.getItem(SESSION_KEY);
  return username ? { username } : null;
}

function validateCredentials(username: string, pin: string) {
  const normalizedUsername = normalizeUsername(username);
  if (!/^[a-z0-9_-]{3,32}$/.test(normalizedUsername)) {
    throw new Error("Use 3–32 letters, numbers, underscores, or hyphens for your username.");
  }
  if (!/^\d{4}$/.test(pin)) {
    throw new Error("Your PIN must be exactly 4 digits.");
  }
  return normalizedUsername;
}

async function createStoredUser(username: string, pin: string): Promise<StoredUser> {
  const normalizedUsername = validateCredentials(username, pin);

  const users = readUsers();
  if (users.some((user) => user.username === normalizedUsername)) {
    throw new Error("That username is already in use.");
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const user: StoredUser = {
    username: normalizedUsername,
    salt: bytesToBase64(salt),
    pinHash: await hashPin(pin, salt),
    createdAt: new Date().toISOString(),
  };
  return user;
}

export async function signUp(username: string, pin: string): Promise<AuthUser> {
  const user = await createStoredUser(username, pin);
  const users = readUsers();
  writeUsers([...users, user]);
  window.sessionStorage.setItem(SESSION_KEY, user.username);
  return { username: user.username };
}

export async function createUser(username: string, pin: string): Promise<ManagedUser> {
  const user = await createStoredUser(username, pin);
  writeUsers([...readUsers(), user]);
  return { username: user.username, createdAt: user.createdAt };
}

export function listUsers(): ManagedUser[] {
  return readUsers().map(({ username, createdAt }) => ({ username, createdAt }));
}

export function deleteUser(username: string) {
  const normalizedUsername = normalizeUsername(username);
  writeUsers(readUsers().filter((user) => user.username !== normalizedUsername));
  window.localStorage.removeItem(`pi_saved_wallets_v1:${normalizedUsername}`);
}

export async function login(username: string, pin: string): Promise<AuthUser> {
  const normalizedUsername = normalizeUsername(username);
  const user = readUsers().find((candidate) => candidate.username === normalizedUsername);
  if (!user) throw new Error("Username or PIN is incorrect.");

  const pinHash = await hashPin(pin, base64ToBytes(user.salt));
  if (pinHash !== user.pinHash) {
    throw new Error("Username or PIN is incorrect.");
  }

  window.sessionStorage.setItem(SESSION_KEY, normalizedUsername);
  return { username: normalizedUsername };
}

export function logout() {
  window.sessionStorage.removeItem(SESSION_KEY);
}
