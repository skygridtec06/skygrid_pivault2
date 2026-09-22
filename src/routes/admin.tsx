import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CalendarDays, Check, Copy, Clock3, WalletCards } from "lucide-react";
import { loadWallets, type SavedWallet } from "@/Server/wallets";
import { ActionButton } from "@/components/Field";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Wallet Dashboard — Pi Vault" },
      {
        name: "description",
        content:
          "Track every Pi wallet you have added in one place: live mainnet balances, totals, and quick access.",
      },
    ],
  }),
  component: AdminPage,
});

function AdminPage() {
  const [wallets, setWallets] = useState<SavedWallet[]>([]);
  const [selectedDate, setSelectedDate] = useState(() => localDateKey(new Date()));
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);

  useEffect(() => {
    void loadWallets().then(setWallets);
  }, []);

  const todayKey = localDateKey(new Date());
  const addedToday = wallets.filter(
    (wallet) => localDateKey(new Date(wallet.addedAt)) === todayKey,
  ).length;
  const addedOnSelectedDate = wallets.filter(
    (wallet) => localDateKey(new Date(wallet.addedAt)) === selectedDate,
  ).length;

  async function copyAddress(address: string) {
    await navigator.clipboard.writeText(address);
    setCopiedAddress(address);
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-8 sm:px-5 sm:pb-24 sm:pt-10">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-xl border border-accent/30 bg-accent/10 p-3 text-accent">
            <WalletCards className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">
              Dashboard
            </p>
            <h1 className="mt-2 text-3xl font-bold sm:text-4xl">Your wallets</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              A quick overview of your saved Pi wallets.
            </p>
          </div>
        </div>
        <span className="rounded-full border border-border bg-secondary/30 px-3 py-1.5 text-sm font-semibold text-muted-foreground">
          {wallets.length} {wallets.length === 1 ? "wallet" : "wallets"}
        </span>
      </header>
      <section className="mb-8 grid gap-3 sm:grid-cols-2">
        <div className="panel p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Added today</p>
            <span className="rounded-lg border border-border bg-secondary/40 p-2 text-accent">
              <CalendarDays className="h-4 w-4" aria-hidden="true" />
            </span>
          </div>
          <p className="mt-4 text-3xl font-bold brand-gradient-text">{addedToday}</p>
          <p className="mt-1 text-sm text-muted-foreground">Wallets added on this day</p>
        </div>
        <div className="panel p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Total wallets added
            </p>
            <span className="rounded-lg border border-border bg-secondary/40 p-2 text-accent">
              <WalletCards className="h-4 w-4" aria-hidden="true" />
            </span>
          </div>
          <p className="mt-4 text-3xl font-bold brand-gradient-text">{wallets.length}</p>
          <p className="mt-1 text-sm text-muted-foreground">All wallets on this device</p>
        </div>
      </section>
      <section className="panel mb-8 overflow-hidden p-0">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-start gap-3 p-4 sm:p-5">
            <div className="rounded-xl border border-accent/30 bg-accent/10 p-2.5 text-accent">
              <CalendarDays className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">
                Activity calendar
              </p>
              <h2 className="mt-2 text-xl font-semibold">Wallets added on a date</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Choose a day to see your wallet activity.
              </p>
            </div>
          </div>
          <label className="block w-full px-4 pb-4 sm:w-auto sm:px-5 sm:pb-5">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Select date
            </span>
            <input
              type="date"
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
              className="w-full rounded-xl border border-border bg-input/40 px-3 py-2.5 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 sm:w-48"
            />
          </label>
        </div>
        <div className="mx-4 mb-4 flex items-center gap-4 rounded-xl border border-accent/30 bg-accent/10 p-4 sm:mx-5 sm:mb-5">
          <div className="rounded-lg bg-accent p-2 text-accent-foreground">
            <CalendarDays className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">
              {new Date(`${selectedDate}T00:00:00`).toLocaleDateString(undefined, {
                dateStyle: "long",
              })}
            </p>
            <p className="mt-1 text-2xl font-bold text-accent">{addedOnSelectedDate}</p>
            <p className="text-sm text-muted-foreground">
              wallet{addedOnSelectedDate === 1 ? "" : "s"} added
            </p>
          </div>
        </div>
      </section>
      <ul className="space-y-3">
        {wallets.length === 0 ? (
          <li className="panel flex items-center gap-3 p-6 text-sm text-muted-foreground">
            <WalletCards className="h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
            <span>
              No wallets yet. Open a wallet on the home page and save it to track it here.
            </span>
          </li>
        ) : (
          wallets.map((wallet) => (
            <li
              key={wallet.address}
              className="panel flex min-w-0 flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-5"
            >
              <div className="flex min-w-0 items-start gap-3">
                <div className="rounded-lg bg-secondary p-2 text-accent">
                  <WalletCards className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold">{wallet.label}</p>
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {wallet.address}
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                    Added {new Date(wallet.addedAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
              <ActionButton tone="ghost" onClick={() => void copyAddress(wallet.address)}>
                {copiedAddress === wallet.address ? (
                  <>
                    <Check className="h-4 w-4" aria-hidden="true" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" aria-hidden="true" />
                    Copy address
                  </>
                )}
              </ActionButton>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
