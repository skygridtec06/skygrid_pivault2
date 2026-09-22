import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ActionButton, Field } from "@/components/Field";
import {
  loadAccount,
  loadPayments,
  publicKeyFromSecret,
  readableError,
  sendPi,
  secretFromMnemonic,
  shortenAddress,
  type PiAccount,
  type PiPayment,
} from "@/lib/pi";
import {
  addWallet,
  getOrCreateVaultPassword,
  loadWallets,
  persistWalletSecret,
  recordWalletPayments,
  rememberWalletSecret,
} from "@/lib/wallets";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Pi Vault — Check Pi Balance & Send Pi Instantly" },
      {
        name: "description",
        content:
          "Unlock a Pi Network wallet with your passphrase key to view your live balance, recent activity, and send Pi on mainnet. Keys never leave your device.",
      },
      { property: "og:title", content: "Pi Vault — Check Pi Balance & Send Pi Instantly" },
      {
        property: "og:description",
        content: "View your live Pi balance and send Pi on mainnet. Your key stays on your device.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: WalletPage,
});

function WalletPage() {
  const [secret, setSecret] = useState("");
  const [credentialType, setCredentialType] = useState<"secret" | "mnemonic">("mnemonic");
  const [account, setAccount] = useState<PiAccount | null>(null);
  const [payments, setPayments] = useState<PiPayment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [label, setLabel] = useState("");

  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [sending, setSending] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [statusModal, setStatusModal] = useState<{
    type: "success" | "error";
    message: string;
    balance?: string;
  } | null>(null);

  async function refresh(publicKey: string) {
    const [acct, pays] = await Promise.all([loadAccount(publicKey), loadPayments(publicKey)]);
    await recordWalletPayments(publicKey, pays);
    setAccount(acct);
    setPayments(pays);
  }

  async function unlock() {
    setError("");
    setNotice("");
    setTxHash("");
    setBusy(true);
    try {
      const signingSecret =
        credentialType === "mnemonic" ? await secretFromMnemonic(secret) : secret.trim();
      const publicKey = await publicKeyFromSecret(signingSecret);
      const existingWallets = await loadWallets();
      const alreadyExists = existingWallets.some((wallet) => wallet.address === publicKey);

      if (alreadyExists) {
        setAccount(null);
        setStatusModal({
          type: "error",
          message: `This wallet already exists in your saved list: ${shortenAddress(publicKey, 8)}.`,
        });
        return;
      }

      const walletAccount = await loadAccount(publicKey);
      const nextLabel = label.trim() || `Wallet ${shortenAddress(publicKey, 4)}`;
      await addWallet(publicKey, nextLabel);
      await persistWalletSecret(publicKey, signingSecret, getOrCreateVaultPassword());
      rememberWalletSecret(publicKey, signingSecret);
      setAccount(null);
      setPayments([]);
      setSecret("");
      setLabel("");
      setNotice("Wallet added. You can add another passphrase now.");
      const availableBalance = Number(walletAccount.balance);
      setStatusModal({
        type: "success",
        message:
          Number.isFinite(availableBalance) && availableBalance >= 2
            ? "This wallet has 2 Pi or more available."
            : "Wallet added successfully.",
        balance: Number.isFinite(availableBalance)
          ? `${availableBalance.toLocaleString(undefined, { maximumFractionDigits: 7 })} Pi`
          : "Unavailable",
      });

      // Do not block wallet creation on the historical payment sync.
      void loadPayments(publicKey)
        .then((walletPayments) => recordWalletPayments(publicKey, walletPayments))
        .catch((syncError: unknown) => {
          console.error("Wallet transaction sync failed", syncError);
          setNotice("Wallet added. Transaction history will retry on the next refresh.");
        });
    } catch (err) {
      setAccount(null);
      setError(readableError(err));
    } finally {
      setBusy(false);
    }
  }

  function lock() {
    setSecret("");
    setAccount(null);
    setPayments([]);
    setTxHash("");
    setNotice("");
    setError("");
  }

  async function send() {
    if (!account) return;
    setError("");
    setTxHash("");
    setSending(true);
    try {
      const res = await sendPi({ secret, destination, amount, memo });
      setTxHash(res.hash);
      setDestination("");
      setAmount("");
      setMemo("");
      await refresh(account.publicKey);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setSending(false);
    }
  }

  async function save() {
    if (!account) return;
    const walletLabel = (label || `Wallet ${shortenAddress(account.publicKey, 4)}`).trim();
    const existingWallets = await loadWallets();
    if (existingWallets.some((wallet) => wallet.address === account.publicKey)) {
      setStatusModal({
        type: "error",
        message: `This wallet is already in your saved list: ${shortenAddress(account.publicKey, 8)}.`,
      });
      return;
    }
    await addWallet(account.publicKey, walletLabel);
    setLabel(walletLabel);
    setNotice("Saved to your dashboard.");
    const availableBalance = Number(account.balance);
    setStatusModal({
      type: "success",
      message:
        Number.isFinite(availableBalance) && availableBalance >= 2
          ? "This wallet has 2 Pi or more available."
          : `Wallet added successfully: ${shortenAddress(account.publicKey, 8)}.`,
      balance: Number.isFinite(availableBalance)
        ? `${availableBalance.toLocaleString(undefined, { maximumFractionDigits: 7 })} Pi`
        : "Unavailable",
    });
  }

  const lockedBalance = Number(account?.lockedBalance ?? "0");
  const nextUnlock = account?.lockedBreakdown
    .filter((lock) => Boolean(lock.unlocksAt))
    .sort((a, b) => Date.parse(String(a.unlocksAt)) - Date.parse(String(b.unlocksAt)))[0];

  return (
    <>
      {statusModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm">
          <div
            className={`w-full max-w-md rounded-2xl border p-6 shadow-2xl ${
              statusModal.type === "success"
                ? "border-emerald-500/60 bg-emerald-950/80 text-emerald-50"
                : "border-red-500/60 bg-red-950/80 text-red-50"
            }`}
          >
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-current/70">
              {statusModal.type === "success" ? "Wallet added" : "Duplicate wallet"}
            </p>
            <h3 className="mt-3 text-2xl font-bold">
              {statusModal.type === "success" ? "Success" : "Already saved"}
            </h3>
            <p className="mt-3 text-sm text-current/80">{statusModal.message}</p>
            {statusModal.balance ? (
              <div className="mt-5 text-center">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-current/60">
                  Available Pi
                </p>
                <p className="mt-1 break-words text-5xl font-black leading-tight tracking-tight sm:text-6xl">
                  {statusModal.balance}
                </p>
              </div>
            ) : null}
            <div className="mt-6 flex justify-end">
              <ActionButton
                onClick={() => setStatusModal(null)}
                tone={statusModal.type === "success" ? "accent" : "ghost"}
              >
                {statusModal.type === "success" ? "Continue" : "Dismiss"}
              </ActionButton>
            </div>
          </div>
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-8 sm:px-5 sm:pb-24 sm:pt-10">
        <header className="mb-8 sm:mb-10">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Pi Mainnet</p>
          <h1 className="mt-3 text-3xl font-bold leading-tight sm:text-5xl">
            <span className="brand-gradient-text">
              Lidnel&apos;s PI Coin Wallets Control Portal
            </span>
          </h1>
        </header>

        {!account ? (
          <section className="panel glow p-4 sm:p-8">
            <div className="space-y-5">
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  tone={credentialType === "mnemonic" ? "accent" : "ghost"}
                  onClick={() => {
                    setCredentialType("mnemonic");
                    setSecret("");
                    setError("");
                  }}
                >
                  24-word passphrase
                </ActionButton>
                <ActionButton
                  tone={credentialType === "secret" ? "accent" : "ghost"}
                  onClick={() => {
                    setCredentialType("secret");
                    setSecret("");
                    setError("");
                  }}
                >
                  Secret key
                </ActionButton>
              </div>
              {credentialType === "secret" ? (
                <Field
                  label="Wallet secret key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="S..."
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  hint="Starts with S. The key is used only in this browser session."
                />
              ) : (
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    24-word wallet passphrase
                  </span>
                  <textarea
                    rows={4}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="word1 word2 word3 ... word24"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    className="min-h-28 w-full resize-y rounded-xl border border-border bg-input/40 px-3 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-accent focus:ring-2 focus:ring-accent/40 sm:px-4"
                  />
                  <span className="mt-1.5 block text-xs text-muted-foreground">
                    Enter the exact 24 English words in order. It is converted locally and never
                    sent or stored.
                  </span>
                </label>
              )}
              <ActionButton
                tone="accent"
                onClick={unlock}
                disabled={busy || secret.trim().length < 20}
              >
                {busy ? "Adding…" : "Add wallet"}
              </ActionButton>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </div>
          </section>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
            <section className="panel glow min-w-0 p-4 sm:p-8">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                    Balance
                  </p>
                  <p className="mt-2 break-words text-4xl font-bold brand-gradient-text sm:text-5xl">
                    {Number(account.balance).toLocaleString(undefined, {
                      maximumFractionDigits: 7,
                    })}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">Pi</p>
                </div>
                <ActionButton tone="ghost" onClick={lock}>
                  Lock
                </ActionButton>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-border bg-secondary/30 p-4">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    Available
                  </p>
                  <p className="mt-2 text-2xl font-bold">
                    {Number(account.balance).toLocaleString(undefined, {
                      maximumFractionDigits: 7,
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground">Pi ready to spend</p>
                </div>
                <div className="rounded-xl border border-border bg-secondary/30 p-4">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    Locked
                  </p>
                  <p className="mt-2 text-2xl font-bold text-amber-500">
                    {Number(lockedBalance).toLocaleString(undefined, { maximumFractionDigits: 7 })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {lockedBalance > 0 ? "Currently locked" : "No locked Pi"}
                  </p>
                </div>
              </div>

              {lockedBalance > 0 ? (
                <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
                  <p className="font-medium text-amber-600 dark:text-amber-300">
                    {nextUnlock
                      ? `Next unlock: ${new Date(nextUnlock.unlocksAt as string).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
                      : "Some coins are currently locked."}
                  </p>
                  <div className="mt-2 space-y-1 text-muted-foreground">
                    {account.lockedBreakdown.map((lock) => (
                      <div
                        key={lock.id}
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <span>
                          {Number(lock.amount).toLocaleString(undefined, {
                            maximumFractionDigits: 7,
                          })}{" "}
                          Pi
                        </span>
                        <span>
                          {lock.unlocksAt
                            ? new Date(lock.unlocksAt).toLocaleString(undefined, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              })
                            : "Unlock date unavailable"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <p className="mt-6 break-all rounded-xl border border-border bg-secondary/40 p-3 font-mono text-xs text-muted-foreground">
                {account.publicKey}
              </p>
              {!account.funded ? (
                <p className="mt-3 text-sm text-destructive">
                  This wallet is not activated on mainnet yet — it needs at least 1 Pi.
                </p>
              ) : null}

              <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <Field
                    label="Name for dashboard"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </div>
                <ActionButton onClick={save}>Save wallet</ActionButton>
              </div>
              {notice ? <p className="mt-2 text-sm text-accent">{notice}</p> : null}

              <div className="mt-8">
                <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                  Recent activity
                </h2>
                <ul className="mt-3 space-y-2">
                  {payments.length === 0 ? (
                    <li className="text-sm text-muted-foreground">No transactions yet.</li>
                  ) : (
                    payments.map((p) => (
                      <li
                        key={p.id}
                        className={`flex min-w-0 flex-col gap-2 rounded-xl border px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-4 ${
                          p.direction === "in"
                            ? "border-emerald-500/40 bg-emerald-500/10"
                            : p.direction === "out"
                              ? "border-red-500/40 bg-red-500/10"
                              : "border-amber-500/40 bg-amber-500/10"
                        }`}
                      >
                        <div className="min-w-0">
                          <p
                            className={`text-sm font-semibold ${
                              p.direction === "in"
                                ? "text-emerald-300"
                                : p.direction === "out"
                                  ? "text-red-300"
                                  : "text-amber-300"
                            }`}
                          >
                            {p.direction === "in"
                              ? "Received"
                              : p.direction === "out"
                                ? "Sent"
                                : p.type === "claimable_balance_claim"
                                  ? "Claimed"
                                  : p.type}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(p.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <span
                          className={`text-sm font-semibold sm:shrink-0 ${
                            p.direction === "in"
                              ? "text-emerald-300"
                              : p.direction === "out"
                                ? "text-red-300"
                                : "text-amber-300"
                          }`}
                        >
                          {p.direction === "in" ? "+" : p.direction === "out" ? "−" : ""}
                          {Number(p.amount).toLocaleString(undefined, {
                            maximumFractionDigits: 7,
                          })}{" "}
                          {p.asset}
                        </span>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            </section>

            <section className="panel p-6 sm:p-8">
              <h2 className="text-lg font-semibold">Send Pi</h2>
              <div className="mt-5 space-y-4">
                <Field
                  label="Destination address"
                  placeholder="G... or M..."
                  spellCheck={false}
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                />
                <Field
                  label="Amount (Pi)"
                  inputMode="decimal"
                  placeholder="0.0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <Field
                  label="Memo (optional)"
                  maxLength={28}
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                />
                <ActionButton
                  tone="accent"
                  onClick={send}
                  disabled={sending || !destination.trim() || Number(amount) <= 0}
                >
                  {sending ? "Sending…" : "Send Pi"}
                </ActionButton>
                {txHash ? (
                  <p className="break-all text-sm text-accent">
                    Sent. Transaction id: <span className="font-mono text-xs">{txHash}</span>
                  </p>
                ) : null}
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
                <p className="text-xs text-muted-foreground">
                  Transfers are final. Double-check the address before sending.
                </p>
              </div>
            </section>
          </div>
        )}
      </div>
    </>
  );
}
