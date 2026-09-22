import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { getCurrentUser, login, logout, signUp, type AuthUser } from "../lib/auth";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { ActionButton, Field } from "../components/Field";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Pi Vault — Pi Network Wallet" },
      { name: "description", content: "View balances and send Pi on the Pi Network mainnet." },
      { property: "og:title", content: "Pi Vault — Pi Network Wallet" },
      {
        property: "og:description",
        content: "View balances and send Pi on the Pi Network mainnet.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap",
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),

  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    void getCurrentUser()
      .then(setUser)
      .finally(() => setAuthReady(true));
  }, []);

  if (!authReady) {
    return <div className="min-h-screen bg-background" />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen">
        {user ? (
          <>
            <nav className="sticky top-0 z-20 border-b border-border/60 bg-background/70 backdrop-blur-xl">
              <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5 sm:py-4">
                <Link to="/" className="text-lg font-bold tracking-tight">
                  PI<span className="text-accent">VAULT</span>
                </Link>
                <div className="flex max-w-full flex-wrap items-center justify-end gap-1 text-sm">
                  <Link
                    to="/"
                    activeOptions={{ exact: true }}
                    className="rounded-lg px-3 py-2 text-muted-foreground transition hover:text-foreground"
                    activeProps={{ className: "bg-secondary text-foreground" }}
                  >
                    Wallet
                  </Link>
                  <Link
                    to="/admin"
                    className="rounded-lg px-3 py-2 text-muted-foreground transition hover:text-foreground"
                    activeProps={{ className: "bg-secondary text-foreground" }}
                  >
                    Dashboard
                  </Link>
                  <Link
                    to="/control"
                    className="rounded-lg bg-primary px-3 py-2 font-semibold text-primary-foreground transition hover:brightness-125"
                    activeProps={{ className: "bg-accent text-accent-foreground" }}
                  >
                    Admin
                  </Link>
                  <button
                    type="button"
                    className="rounded-lg px-3 py-2 text-muted-foreground transition hover:text-foreground"
                    onClick={() => {
                      void logout().then(() => setUser(null));
                    }}
                  >
                    Log out
                  </button>
                </div>
              </div>
            </nav>
            <Outlet />
          </>
        ) : (
          <AuthPanel onAuthenticated={setUser} />
        )}
      </div>
    </QueryClientProvider>
  );
}

function AuthPanel({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      const user = mode === "login" ? await login(username, pin) : await signUp(username, pin);
      onAuthenticated(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md items-center px-5 py-16">
      <section className="panel glow w-full p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Pi Vault</p>
        <h1 className="mt-3 text-3xl font-bold">
          {mode === "login" ? "Welcome back" : "Create your account"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {mode === "login"
            ? "Log in to access your wallets, balances, and transactions."
            : "Sign up to securely use the Pi Vault platform on this device."}
        </p>
        <div className="mt-6 space-y-4">
          <Field
            label="Username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <Field
            label="4-digit PIN"
            type="password"
            inputMode="numeric"
            maxLength={4}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            hint="Enter exactly 4 digits."
          />
          <ActionButton tone="accent" onClick={() => void submit()} disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Log in" : "Sign up"}
          </ActionButton>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <button
          type="button"
          className="mt-6 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => {
            setMode((current) => (current === "login" ? "signup" : "login"));
            setError("");
          }}
        >
          {mode === "login" ? "Need an account? Sign up" : "Already have an account? Log in"}
        </button>
      </section>
    </main>
  );
}
