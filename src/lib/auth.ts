import { getSupabase } from "./supabase";

export type AuthUser = { username: string };
export type ManagedUser = AuthUser & { createdAt: string };

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function validateCredentials(username: string, pin: string): string {
  const normalized = normalizeUsername(username);
  if (!/^[a-z0-9_-]{3,32}$/.test(normalized)) {
    throw new Error("Use 3–32 letters, numbers, underscores, or hyphens for your username.");
  }
  if (!/^\d{4}$/.test(pin)) throw new Error("Your PIN must be exactly 4 digits.");
  return normalized;
}

function authEmail(username: string): string {
  return `${username}@pivault.local`;
}

function authPassword(pin: string): string {
  return `${pin}-PiVault`;
}

async function profileForCurrentSession(): Promise<AuthUser | null> {
  const { data } = await getSupabase().auth.getUser();
  const user = data.user;
  if (!user) return null;
  const username = String(user.user_metadata["username"] ?? "")
    .trim()
    .toLowerCase();
  return username ? { username } : null;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  return profileForCurrentSession();
}

export async function signUp(username: string, pin: string): Promise<AuthUser> {
  const normalized = validateCredentials(username, pin);
  const { data, error } = await getSupabase().auth.signUp({
    email: authEmail(normalized),
    password: authPassword(pin),
    options: { data: { username: normalized } },
  });
  if (error) throw new Error(error.message);
  if (!data.session) {
    throw new Error(
      "Account created. Supabase email confirmation must be disabled for username login.",
    );
  }
  return { username: normalized };
}

export async function login(username: string, pin: string): Promise<AuthUser> {
  const normalized = validateCredentials(username, pin);
  const { error } = await getSupabase().auth.signInWithPassword({
    email: authEmail(normalized),
    password: authPassword(pin),
  });
  if (error) throw new Error("Username or PIN is incorrect.");
  return { username: normalized };
}

export async function logout(): Promise<void> {
  const { error } = await getSupabase().auth.signOut();
  if (error) throw new Error(error.message);
}

export async function createUser(username: string, pin: string): Promise<ManagedUser> {
  const normalized = validateCredentials(username, pin);
  const { data, error } = await getSupabase().auth.signUp({
    email: authEmail(normalized),
    password: authPassword(pin),
    options: { data: { username: normalized } },
  });
  if (error) throw new Error(error.message);
  if (!data.user) throw new Error("The user could not be created.");
  return { username: normalized, createdAt: data.user.created_at };
}

export async function listUsers(): Promise<ManagedUser[]> {
  const { data, error } = await getSupabase()
    .from("profiles")
    .select("username, created_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data.map((row) => ({ username: row.username, createdAt: row.created_at }));
}

export async function deleteUser(username: string): Promise<void> {
  throw new Error(`Deleting ${normalizeUsername(username)} requires a protected admin endpoint.`);
}
