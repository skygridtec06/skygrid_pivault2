import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeftRight,
  CalendarDays,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound,
  UsersRound,
  WalletCards,
} from "lucide-react";
import { ActionButton, Field } from "@/components/Field";
import { createUser, deleteUser, listUsers, type ManagedUser } from "@/lib/auth";
import {
  loadAccount,
  loadAccountBalance,
  loadPayments,
  publicKeyFromSecret,
  readableError,
  sendPi,
  shortenAddress,
  type PiAccount,
  type PiPayment,
} from "@/lib/pi";
import {
  getWalletSecret,
  exportEncryptedVaultBackup,
  importEncryptedVaultBackup,
  loadWalletsForUser,
  removeWalletForUser,
  recordWalletPayments,
  unlockWalletVaultAutomatically,
  type SavedWallet,
} from "@/lib/wallets";

const PIN_KEY = "pi_admin_pin_v1";
const UNLOCK_KEY = "pi_admin_unlocked_v1";
const ADMIN_TRANSACTIONS_KEY = "pi_admin_transactions_v1";
const DISMISSED_LOADED_PAYMENTS_KEY = "pi_dismissed_loaded_payments_v1";
const WITHDRAWAL_ADDRESS = "MALYJFJ5SVD45FBWN2GT4IW67SEZ3IBOFSBSPUFCWV427NBNLG3PWAAAAAAAABMCRD2YU";

type AdminTransaction = {
  id: string;
  from: string;
  to: string;
  amount: string;
  performedAt: string;
  status: "completed" | "failed";
  hash?: string;
};

type LoadedPayment = {
  wallet: AdminWallet;
  payment: PiPayment;
};

type AdminWallet = SavedWallet & {
  ownerUsername: string;
};

async function loadAllUserWallets(): Promise<AdminWallet[]> {
  const users = await listUsers();
  const wallets = await Promise.all(
    users.map(async (user) =>
      (await loadWalletsForUser(user.username)).map((wallet) => ({
        ...wallet,
        ownerUsername: user.username,
      })),
    ),
  );
  return wallets.flat().sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
}

function loadAdminTransactions(): AdminTransaction[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ADMIN_TRANSACTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AdminTransaction[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAdminTransactions(transactions: AdminTransaction[]) {
  window.localStorage.setItem(ADMIN_TRANSACTIONS_KEY, JSON.stringify(transactions.slice(0, 100)));
}

function loadDismissedLoadedPayments(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(DISMISSED_LOADED_PAYMENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveDismissedLoadedPayments(paymentKeys: string[]) {
  window.localStorage.setItem(DISMISSED_LOADED_PAYMENTS_KEY, JSON.stringify(paymentKeys));
}

function loadedPaymentKey(payment: LoadedPayment): string {
  return `${payment.wallet.address}:${payment.payment.id}`;
}

export const Route = createFileRoute("/control")({
  head: () => ({
    meta: [
      { title: "Admin Control Panel — Pi Vault" },
      {
        name: "description",
        content:
          "Private control panel to manage every saved Pi wallet: remove wallets, refresh balances, and review transactions.",
      },
      { property: "og:title", content: "Admin Control Panel — Pi Vault" },
      {
        property: "og:description",
        content: "Manage every saved Pi wallet from one private panel.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ControlPage,
});

function ControlPage() {
  const [ready, setReady] = useState(false);
  const [hasPin, setHasPin] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");

  useEffect(() => {
    setHasPin(Boolean(window.localStorage.getItem(PIN_KEY)));
    setUnlocked(window.sessionStorage.getItem(UNLOCK_KEY) === "1");
    setReady(true);
  }, []);

  function setupPin() {
    if (pin.trim().length < 4) {
      setPinError("Use at least 4 characters.");
      return;
    }
    window.localStorage.setItem(PIN_KEY, pin.trim());
    window.sessionStorage.setItem(UNLOCK_KEY, "1");
    setHasPin(true);
    setUnlocked(true);
    setPin("");
    setPinError("");
  }

  function unlock() {
    if (window.localStorage.getItem(PIN_KEY) === pin.trim()) {
      window.sessionStorage.setItem(UNLOCK_KEY, "1");
      setUnlocked(true);
      setPin("");
      setPinError("");
    } else {
      setPinError("Wrong passcode.");
    }
  }

  if (!ready) return <div className="mx-auto max-w-5xl px-5 py-16" />;

  if (!unlocked) {
    return (
      <div className="mx-auto w-full max-w-md px-5 pb-24 pt-16">
        <div className="panel glow p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Restricted</p>
          <h1 className="mt-3 text-3xl font-bold">
            Admin <span className="brand-gradient-text">control panel</span>
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {hasPin
              ? "Enter your admin passcode to continue."
              : "Choose an admin passcode. It stays on this device and locks this panel."}
          </p>
          <div className="mt-6 space-y-4">
            <Field
              label={hasPin ? "Passcode" : "New passcode"}
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (hasPin ? unlock : setupPin)();
              }}
            />
            <ActionButton tone="accent" onClick={hasPin ? unlock : setupPin}>
              {hasPin ? "Unlock panel" : "Set passcode"}
            </ActionButton>
            {pinError ? <p className="text-sm text-destructive">{pinError}</p> : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <AdminConsole
      onLock={() => {
        window.sessionStorage.removeItem(UNLOCK_KEY);
        setUnlocked(false);
      }}
    />
  );
}

function AdminConsole({ onLock }: { onLock: () => void }) {
  const [wallets, setWallets] = useState<AdminWallet[]>([]);
  const [userCount, setUserCount] = useState(0);
  const [accounts, setAccounts] = useState<Record<string, PiAccount | null>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [newPin, setNewPin] = useState("");
  const [showPinEditor, setShowPinEditor] = useState(false);
  const [sendWallet, setSendWallet] = useState<SavedWallet | null>(null);
  const [sendDestination, setSendDestination] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sendMemo, setSendMemo] = useState("");
  const [sendError, setSendError] = useState("");
  const [sending, setSending] = useState(false);
  const [sendBalanceRefreshing, setSendBalanceRefreshing] = useState(false);
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, boolean>>({});
  const [copiedSecret, setCopiedSecret] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Record<string, PiPayment[]>>({});
  const [transactionsLoading, setTransactionsLoading] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<"balance" | "unlock">("balance");
  const [walletSearch, setWalletSearch] = useState("");
  const [walletSearchAddress, setWalletSearchAddress] = useState("");
  const [walletSearching, setWalletSearching] = useState(false);
  const [adminTransactions, setAdminTransactions] = useState<AdminTransaction[]>([]);
  const [showAdminTransactions, setShowAdminTransactions] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
  const [loadedPayments, setLoadedPayments] = useState<LoadedPayment[]>([]);
  const [dismissedLoadedPayments, setDismissedLoadedPayments] = useState<string[]>(
    loadDismissedLoadedPayments,
  );
  const [loadedLoading, setLoadedLoading] = useState(false);
  const [showLoaded, setShowLoaded] = useState(false);
  const [walletPendingRemoval, setWalletPendingRemoval] = useState<AdminWallet | null>(null);
  const balanceRefreshId = useRef(0);
  const backupInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void Promise.all([loadAllUserWallets(), listUsers()]).then(([seeded, users]) => {
      setWallets(seeded);
      setUserCount(users.length);
      setRevealedSecrets(
        Object.fromEntries(
          seeded.filter((w) => Boolean(getWalletSecret(w.address))).map((w) => [w.address, true]),
        ),
      );
    });
    setAdminTransactions(loadAdminTransactions());
  }, []);

  async function refreshAll(list = wallets) {
    if (list.length === 0) return;
    const refreshId = ++balanceRefreshId.current;
    setRefreshing(true);
    const nextAccounts: Record<string, PiAccount | null> = {};
    let cursor = 0;
    const worker = async () => {
      while (cursor < list.length && refreshId === balanceRefreshId.current) {
        const wallet = list[cursor++];
        if (!wallet) break;
        try {
          const account = await loadAccountBalance(wallet.address);
          nextAccounts[wallet.address] = {
            ...account,
            lockedBalance: accounts[wallet.address]?.lockedBalance ?? account.lockedBalance,
            lockedBreakdown: accounts[wallet.address]?.lockedBreakdown ?? account.lockedBreakdown,
          };
        } catch {
          nextAccounts[wallet.address] = null;
        }
        setAccounts((current) => ({
          ...current,
          [wallet.address]: nextAccounts[wallet.address] ?? null,
        }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(24, list.length) }, () => worker()));
    if (refreshId === balanceRefreshId.current) setRefreshing(false);
  }

  async function refreshLoaded(list = wallets) {
    if (list.length === 0) {
      setLoadedPayments([]);
      return;
    }
    setLoadedLoading(true);
    const records = await Promise.all(
      list.map(async (wallet) => {
        try {
          const payments = await loadPayments(wallet.address);
          await recordWalletPayments(wallet.address, payments);
          return payments
            .filter(
              (payment) =>
                payment.direction === "in" &&
                Date.parse(payment.createdAt) >= Date.parse(wallet.addedAt),
            )
            .map((payment) => ({ wallet, payment }));
        } catch {
          return [];
        }
      }),
    );
    setLoadedPayments(
      records
        .flat()
        .filter((record) => !dismissedLoadedPayments.includes(loadedPaymentKey(record)))
        .sort((a, b) => Date.parse(b.payment.createdAt) - Date.parse(a.payment.createdAt)),
    );
    setLoadedLoading(false);
  }

  useEffect(() => {
    void refreshAll(wallets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallets.length]);

  useEffect(() => {
    void refreshLoaded(wallets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallets.length]);

  function removeOne(wallet: AdminWallet) {
    setWalletPendingRemoval(wallet);
  }

  function confirmRemoveWallet(wallet: AdminWallet) {
    try {
      removeWalletForUser(wallet.ownerUsername, wallet.address);
      setWallets((current) =>
        current.filter(
          (item) => item.ownerUsername !== wallet.ownerUsername || item.address !== wallet.address,
        ),
      );
      setAccounts((current) => {
        const next = { ...current };
        delete next[wallet.address];
        return next;
      });
      setTransactions((current) => {
        const next = { ...current };
        delete next[wallet.address];
        return next;
      });
      setLoadedPayments((current) =>
        current.filter(
          (record) =>
            record.wallet.ownerUsername !== wallet.ownerUsername ||
            record.wallet.address !== wallet.address,
        ),
      );
      setMessage("Wallet removed.");
      setWalletPendingRemoval(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The wallet could not be removed.");
    }
  }

  function removeAdminTransaction(id: string) {
    setAdminTransactions((current) => {
      const next = current.filter((transaction) => transaction.id !== id);
      saveAdminTransactions(next);
      return next;
    });
    setMessage("Recorded transaction removed.");
  }

  function removeLoadedPayment(payment: LoadedPayment) {
    const key = loadedPaymentKey(payment);
    setDismissedLoadedPayments((current) => {
      if (current.includes(key)) return current;
      const next = [...current, key];
      saveDismissedLoadedPayments(next);
      return next;
    });
    setLoadedPayments((current) => current.filter((record) => loadedPaymentKey(record) !== key));
    setMessage("Loaded transaction removed.");
  }

  function changePin() {
    if (newPin.trim().length < 4) {
      setError("Passcode needs at least 4 characters.");
      return;
    }
    window.localStorage.setItem(PIN_KEY, newPin.trim());
    setNewPin("");
    setMessage("Passcode updated.");
  }

  function toggleSecret(address: string) {
    if (!getWalletSecret(address)) {
      void unlockWalletVaultAutomatically()
        .then((count) => {
          setMessage(`${count} encrypted wallet secret${count === 1 ? "" : "s"} unlocked.`);
          setRevealedSecrets((current) => ({ ...current, [address]: true }));
        })
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : "Vault unlock failed."),
        );
      return;
    }
    setRevealedSecrets((current) => ({
      ...current,
      [address]: !current[address],
    }));
    setCopiedSecret(null);
  }

  async function copySecret(address: string) {
    let secret = getWalletSecret(address);
    if (!secret) {
      try {
        await unlockWalletVaultAutomatically();
        secret = getWalletSecret(address);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Vault unlock failed.");
        return;
      }
    }

    if (!secret) {
      setError("No encrypted secret was found for this wallet.");
      return;
    }
    try {
      await navigator.clipboard.writeText(secret);
      setCopiedSecret(address);
      setMessage("Secret key copied. Treat it like a password and clear your clipboard after use.");
    } catch {
      setError("The secret key could not be copied. Check your browser clipboard permissions.");
    }
  }

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedAddress(address);
      setMessage("Wallet address copied.");
    } catch {
      setError("The wallet address could not be copied. Check your browser clipboard permissions.");
    }
  }

  async function viewTransactions(address: string) {
    setTransactionsLoading(address);
    setError("");
    try {
      const payments = await loadPayments(address);
      await recordWalletPayments(address, payments);
      setTransactions((current) => ({ ...current, [address]: payments }));
    } catch (err) {
      setError(readableError(err));
    } finally {
      setTransactionsLoading(null);
    }
  }

  function openSend(wallet: SavedWallet, destination = "") {
    setSendWallet(wallet);
    setSendDestination(destination);
    setSendAmount("");
    setSendMemo("");
    setSendError("");
  }

  async function refreshSendBalance() {
    if (!sendWallet) return;
    setSendBalanceRefreshing(true);
    setSendError("");
    try {
      const account = await loadAccount(sendWallet.address);
      setAccounts((current) => ({ ...current, [sendWallet.address]: account }));
    } catch (err) {
      setSendError(readableError(err));
    } finally {
      setSendBalanceRefreshing(false);
    }
  }

  function closeSend() {
    setSendWallet(null);
    setSendDestination("");
    setSendAmount("");
    setSendMemo("");
    setSendError("");
    setSendBalanceRefreshing(false);
  }

  async function submitSend() {
    if (!sendWallet) return;
    setSendError("");
    const destination = sendDestination.trim();
    const amount = sendAmount.trim();
    let secret = getWalletSecret(sendWallet.address);
    if (!secret) {
      try {
        await unlockWalletVaultAutomatically();
        secret = getWalletSecret(sendWallet.address);
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Vault unlock failed.");
        return;
      }
      if (!secret) {
        setSendError("No encrypted secret was found for this wallet.");
        return;
      }
    }
    if (!destination) {
      setSendError("Enter a destination address.");
      return;
    }
    if (!/^(?:G|M)[A-Z2-7]{55,}$/.test(destination)) {
      setSendError("Enter a valid Pi address starting with G or M.");
      return;
    }
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) {
      setSendError("Enter a positive amount with up to 7 decimal places.");
      return;
    }

    setSending(true);
    const transactionId = crypto.randomUUID();
    const pendingTransaction: AdminTransaction = {
      id: transactionId,
      from: sendWallet.address,
      to: destination,
      amount,
      performedAt: new Date().toISOString(),
      status: "failed",
    };
    const recordTransaction = (transaction: AdminTransaction) => {
      setAdminTransactions((current) => {
        const next = [transaction, ...current].slice(0, 100);
        saveAdminTransactions(next);
        return next;
      });
    };
    try {
      const sourceAddress = await publicKeyFromSecret(secret);
      if (sourceAddress !== sendWallet.address) {
        recordTransaction(pendingTransaction);
        setSendError("The secret key does not belong to the selected source wallet.");
        return;
      }
      const result = await sendPi({
        secret,
        destination,
        amount,
        memo: sendMemo,
      });
      recordTransaction({
        ...pendingTransaction,
        status: "completed",
        hash: result.hash,
      });
      setMessage(
        `Sent ${amount} Pi from ${shortenAddress(sendWallet.address)}. Transaction: ${result.hash}`,
      );
      await refreshAll();
      closeSend();
    } catch (err) {
      recordTransaction(pendingTransaction);
      setSendError(readableError(err));
    } finally {
      setSending(false);
    }
  }

  const total = wallets.reduce((sum, w) => {
    const b = Number(accounts[w.address]?.balance);
    return Number.isFinite(b) ? sum + b : sum;
  }, 0);
  const rankedWallets = useMemo(() => {
    const getNextUnlock = (address: string) => {
      const timestamps = (accounts[address]?.lockedBreakdown ?? [])
        .map((claim) => (claim.unlocksAt ? Date.parse(claim.unlocksAt) : Number.NaN))
        .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= Date.now());
      return timestamps.length ? Math.min(...timestamps) : Number.POSITIVE_INFINITY;
    };

    return [...wallets].sort((a, b) => {
      if (sortMode === "unlock") {
        const unlockA = getNextUnlock(a.address);
        const unlockB = getNextUnlock(b.address);
        if (unlockA !== unlockB) return unlockA - unlockB;
      }

      const balanceA = Number(accounts[a.address]?.balance);
      const balanceB = Number(accounts[b.address]?.balance);
      const normalizedA = Number.isFinite(balanceA) ? balanceA : -1;
      const normalizedB = Number.isFinite(balanceB) ? balanceB : -1;
      return normalizedB - normalizedA;
    });
  }, [accounts, sortMode, wallets]);
  const visibleWallets = useMemo(() => {
    if (!walletSearchAddress) return rankedWallets;
    return rankedWallets.filter((wallet) => wallet.address === walletSearchAddress);
  }, [rankedWallets, walletSearchAddress]);
  async function searchWallet() {
    const query = walletSearch.trim();
    setError("");
    if (!query) {
      setWalletSearchAddress("");
      return;
    }
    const directMatch = wallets.find(
      (wallet) => wallet.address.toLowerCase() === query.toLowerCase(),
    );
    if (directMatch) {
      setWalletSearchAddress(directMatch.address);
      return;
    }
    setWalletSearching(true);
    try {
      const derivedAddress = await publicKeyFromSecret(query);
      const secretMatch = wallets.find((wallet) => wallet.address === derivedAddress);
      if (!secretMatch) {
        setWalletSearchAddress("");
        setError("No tracked wallet matches that secret key or address.");
        return;
      }
      setWalletSearchAddress(secretMatch.address);
    } catch {
      setWalletSearchAddress("");
      setError("Paste a tracked wallet address or its valid secret key.");
    } finally {
      setWalletSearching(false);
    }
  }
  async function exportVault() {
    const password = window.prompt("Create a backup password (12+ characters).");
    if (!password) return;
    try {
      await unlockWalletVaultAutomatically();
      const backup = await exportEncryptedVaultBackup(password);
      const url = URL.createObjectURL(new Blob([backup], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `pivault-encrypted-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage("Encrypted wallet backup downloaded. Keep the file and password private.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The encrypted backup could not be created.");
    }
  }
  async function importVault(file: File) {
    const password = window.prompt("Enter the backup password.");
    if (!password) return;
    try {
      const imported = await importEncryptedVaultBackup(await file.text(), password);
      setMessage(`${imported} wallet secret${imported === 1 ? "" : "s"} imported securely.`);
      setWallets(await loadAllUserWallets());
    } catch (err) {
      setError(err instanceof Error ? err.message : "The encrypted backup could not be imported.");
    } finally {
      if (backupInput.current) backupInput.current.value = "";
    }
  }
  const sendAccount = sendWallet ? accounts[sendWallet.address] : undefined;
  const sendBalanceLabel =
    sendAccount === undefined
      ? "…"
      : sendAccount === null
        ? "Unavailable"
        : `${Number(sendAccount.balance).toLocaleString(undefined, { maximumFractionDigits: 7 })} Pi`;

  return (
    <>
      {sendWallet ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm">
          <div className="panel w-full max-w-lg p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">
                  Admin transfer
                </p>
                <h2 className="mt-2 text-2xl font-bold">
                  {sendDestination === WITHDRAWAL_ADDRESS ? "Withdraw Pi" : "Send Pi"}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Source: {shortenAddress(sendWallet.address, 10)}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                      Account balance
                    </p>
                    <p className="mt-1 text-2xl font-bold text-accent">{sendBalanceLabel}</p>
                  </div>
                  <ActionButton
                    tone="ghost"
                    onClick={() => void refreshSendBalance()}
                    disabled={sendBalanceRefreshing || sending}
                  >
                    {sendBalanceRefreshing ? "Refreshing…" : "Refresh balance"}
                  </ActionButton>
                </div>
              </div>
              <ActionButton tone="ghost" onClick={closeSend} disabled={sending}>
                Close
              </ActionButton>
            </div>
            <div className="mt-6 space-y-4">
              <Field
                label="Destination address"
                placeholder="G... or M..."
                spellCheck={false}
                value={sendDestination}
                onChange={(e) => setSendDestination(e.target.value.toUpperCase())}
                readOnly={sendDestination === WITHDRAWAL_ADDRESS}
              />
              <Field
                label="Amount (Pi)"
                inputMode="decimal"
                placeholder="0.0"
                value={sendAmount}
                onChange={(e) => setSendAmount(e.target.value)}
              />
              <Field
                label="Memo (optional)"
                maxLength={28}
                value={sendMemo}
                onChange={(e) => setSendMemo(e.target.value)}
              />
              <ActionButton tone="accent" onClick={submitSend} disabled={sending}>
                {sending
                  ? "Sending…"
                  : sendDestination === WITHDRAWAL_ADDRESS
                    ? "Withdraw Pi"
                    : "Send Pi"}
              </ActionButton>
              {sendError ? <p className="text-sm text-destructive">{sendError}</p> : null}
            </div>
          </div>
        </div>
      ) : null}
      <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-8 sm:px-5 sm:pb-24 sm:pt-10">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-4 sm:mb-8">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Admin</p>
            <h1 className="mt-3 text-3xl font-bold sm:text-4xl">Control panel</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Full control over every wallet you track. Secret keys are never stored here.
            </p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <input
              ref={backupInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importVault(file);
              }}
            />
            <ActionButton tone="ghost" onClick={() => void exportVault()}>
              Export encrypted vault
            </ActionButton>
            <ActionButton tone="ghost" onClick={() => backupInput.current?.click()}>
              Import encrypted vault
            </ActionButton>
            <ActionButton tone="ghost" onClick={() => setShowPinEditor((current) => !current)}>
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              <span>{showPinEditor ? "Close update" : "Update passcode"}</span>
            </ActionButton>
            <ActionButton tone="ghost" onClick={onLock}>
              <LockKeyhole className="h-4 w-4" aria-hidden="true" />
              <span>Lock panel</span>
            </ActionButton>
          </div>
        </header>
        {showPinEditor ? (
          <div className="mb-6 flex flex-col gap-3 rounded-xl border border-border bg-secondary/20 p-4 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <Field
                label="New admin passcode"
                type="password"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value)}
              />
            </div>
            <ActionButton
              tone="accent"
              onClick={() => {
                changePin();
                if (newPin.trim().length >= 4) setShowPinEditor(false);
              }}
            >
              Save passcode
            </ActionButton>
          </div>
        ) : null}

        <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Wallets" value={String(wallets.length)} icon={WalletCards} />
          <Stat
            label="Total Pi"
            value={total.toLocaleString(undefined, { maximumFractionDigits: 4 })}
            highlight
            icon={ShieldCheck}
          />
          <Stat
            label="Transactions"
            value={String(adminTransactions.length)}
            icon={ArrowLeftRight}
            onClick={() => {
              setShowAdminTransactions(true);
              setShowLoaded(false);
              setShowUsers(false);
            }}
          />
          <Stat
            label="Loaded"
            value={String(loadedPayments.length)}
            icon={ArrowDownToLine}
            onClick={() => {
              setShowLoaded(true);
              setShowAdminTransactions(false);
              setShowUsers(false);
              void refreshLoaded();
            }}
          />
          <Stat
            label="Users"
            value={String(userCount)}
            icon={UsersRound}
            onClick={() => {
              setShowUsers(true);
              setShowAdminTransactions(false);
              setShowLoaded(false);
            }}
          />
        </div>
        {showUsers ? (
          <UserManagement
            onUsersChanged={() => {
              void Promise.all([loadAllUserWallets(), listUsers()]).then(([nextWallets, users]) => {
                setWallets(nextWallets);
                setUserCount(users.length);
              });
            }}
            onClose={() => setShowUsers(false)}
          />
        ) : null}
        <div className="mb-6 flex flex-col gap-3 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-muted-foreground">
            <RefreshCw
              className={`h-4 w-4 shrink-0 text-accent ${refreshing ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            <span>Balances load when the wallet list opens.</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-end">
            <ActionButton tone="ghost" onClick={() => void refreshAll()} disabled={refreshing}>
              {refreshing ? "Loading balances…" : "Refresh balances"}
            </ActionButton>
            <label className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
              <span>Rank by</span>
              <select
                value={sortMode}
                onChange={(event) => {
                  const nextMode = event.target.value;
                  if (nextMode === "balance" || nextMode === "unlock") setSortMode(nextMode);
                }}
                className="rounded-lg border border-border bg-background/60 px-2 py-1.5 text-xs text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/40"
              >
                <option value="balance">Highest available balance</option>
                <option value="unlock">Earliest upcoming unlock</option>
              </select>
            </label>
          </div>
        </div>

        {message ? <p className="mb-6 text-sm text-accent">{message}</p> : null}
        {error ? <p className="mb-6 text-sm text-destructive">{error}</p> : null}

        <section className={`panel mb-6 p-4 sm:p-5 ${showAdminTransactions ? "" : "hidden"}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">
                Transactions
              </p>
              <h2 className="mt-2 text-2xl font-bold">Admin transactions</h2>
              <p className="text-sm text-muted-foreground">
                Latest transfers performed from this control panel.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-accent">
                {adminTransactions.length} recorded
              </span>
              <ActionButton tone="ghost" onClick={() => setShowAdminTransactions(false)}>
                Back to control panel
              </ActionButton>
            </div>
          </div>
          {adminTransactions.length ? (
            <div className="mt-4 space-y-2">
              {adminTransactions.map((transaction) => (
                <div
                  key={transaction.id}
                  className="flex flex-col gap-2 rounded-xl border border-border bg-secondary/20 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="font-medium">
                      {shortenAddress(transaction.from, 8)}{" "}
                      <span className="text-muted-foreground">to</span>{" "}
                      {shortenAddress(transaction.to, 8)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(transaction.performedAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold">{transaction.amount} Pi</span>
                    <span
                      className={
                        transaction.status === "completed"
                          ? "font-semibold text-emerald-400"
                          : "font-semibold text-red-400"
                      }
                    >
                      {transaction.status === "completed" ? "Completed" : "Failed"}
                    </span>
                    <ActionButton
                      tone="ghost"
                      onClick={() => removeAdminTransaction(transaction.id)}
                    >
                      Remove
                    </ActionButton>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              No admin transactions have been performed yet.
            </p>
          )}
        </section>

        <section className={`panel mb-6 p-4 sm:p-5 ${showLoaded ? "" : "hidden"}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Loaded</p>
              <h2 className="mt-2 text-2xl font-bold">Incoming Pi after wallet added</h2>
              <p className="text-sm text-muted-foreground">
                Incoming payments received after each wallet was added.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-accent">
                {loadedLoading ? "Updating…" : `${loadedPayments.length} recorded`}
              </span>
              <ActionButton
                tone="ghost"
                onClick={() => {
                  setShowLoaded(false);
                  void refreshLoaded();
                }}
              >
                Back to control panel
              </ActionButton>
            </div>
          </div>
          {loadedPayments.length ? (
            <div className="mt-4 space-y-2">
              {loadedPayments.map((loadedPayment) => {
                const { wallet, payment } = loadedPayment;
                return (
                  <div
                    key={`${wallet.address}-${payment.id}`}
                    className="flex flex-col gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-emerald-300">
                        {payment.amount} {payment.asset} received
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {wallet.label} · {shortenAddress(wallet.address, 8)}
                      </p>
                      <p className="text-xs text-accent">Added by {wallet.ownerUsername}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(payment.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <ActionButton tone="accent" onClick={() => openSend(wallet)}>
                        Send Pi
                      </ActionButton>
                      <ActionButton tone="ghost" onClick={() => removeLoadedPayment(loadedPayment)}>
                        Remove
                      </ActionButton>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              {loadedLoading ? "Loading incoming payments…" : "No incoming Pi recorded yet."}
            </p>
          )}
        </section>

        <div className="mb-6 flex flex-col gap-3 rounded-xl border border-border bg-secondary/20 p-4 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Field
              label="Search wallet"
              placeholder="Paste an address or secret key"
              spellCheck={false}
              value={walletSearch}
              onChange={(event) => setWalletSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void searchWallet();
              }}
            />
          </div>
          <div className="flex gap-2">
            <ActionButton
              tone="accent"
              onClick={() => void searchWallet()}
              disabled={walletSearching}
            >
              {walletSearching ? "Searching…" : "Search"}
            </ActionButton>
            {walletSearchAddress ? (
              <ActionButton
                tone="ghost"
                onClick={() => {
                  setWalletSearch("");
                  setWalletSearchAddress("");
                  setError("");
                }}
              >
                Clear
              </ActionButton>
            ) : null}
          </div>
        </div>

        <ul
          className={`space-y-3 ${showAdminTransactions || showLoaded || showUsers ? "hidden" : ""}`}
        >
          {wallets.length === 0 ? (
            <li className="panel p-6 text-sm text-muted-foreground">No wallets tracked yet.</li>
          ) : visibleWallets.length === 0 ? (
            <li className="panel p-6 text-sm text-muted-foreground">
              No tracked wallet matches that search.
            </li>
          ) : (
            visibleWallets.map((w, index) => {
              const account = accounts[w.address];
              const lockedBreakdown = account?.lockedBreakdown ?? [];
              const lockedBalance = account?.lockedBalance ?? "0";

              return (
                <li key={w.address} className="panel flex min-w-0 flex-col gap-4 p-4 sm:p-5">
                  <div className="min-w-0">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-accent">
                      Rank {index + 1}
                    </p>
                    <p className="font-semibold">{w.label}</p>
                    <p className="break-all font-mono text-xs text-muted-foreground">{w.address}</p>
                    <p className="text-xs text-accent">Added by {w.ownerUsername}</p>
                    <ActionButton tone="ghost" onClick={() => void copyAddress(w.address)}>
                      {copiedAddress === w.address ? "Address copied" : "Copy address"}
                    </ActionButton>
                  </div>
                  <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
                    <span className="text-lg font-bold text-accent sm:text-xl">
                      {account === undefined
                        ? "…"
                        : account === null
                          ? "—"
                          : Number(account.balance).toLocaleString(undefined, {
                              maximumFractionDigits: 7,
                            })}
                      <span className="ml-1 text-xs text-muted-foreground">Pi available</span>
                    </span>
                    {lockedBreakdown.length ? (
                      <div className="w-full text-right text-xs text-amber-500">
                        <p>
                          {Number(lockedBalance).toLocaleString(undefined, {
                            maximumFractionDigits: 7,
                          })}{" "}
                          Pi locked
                        </p>
                        {lockedBreakdown.map((claim) => (
                          <p key={claim.id} className="text-muted-foreground">
                            {Number(claim.amount).toLocaleString(undefined, {
                              maximumFractionDigits: 7,
                            })}{" "}
                            Pi ·{" "}
                            {claim.unlocksAt
                              ? `unlocks ${new Date(claim.unlocksAt).toLocaleString()}`
                              : "unlock date unavailable"}
                          </p>
                        ))}
                      </div>
                    ) : null}
                    <div className="flex w-full min-w-0 flex-wrap items-center justify-start gap-2 sm:justify-end">
                      <ActionButton tone="ghost" onClick={() => copySecret(w.address)}>
                        {copiedSecret === w.address ? "Copied" : "Copy secret key"}
                      </ActionButton>
                      {getWalletSecret(w.address) ? (
                        <p className="w-full break-all rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-right font-mono text-xs text-amber-300">
                          {getWalletSecret(w.address)}
                        </p>
                      ) : (
                        <p className="w-full text-right text-xs text-muted-foreground">
                          No secret key available on this device.
                        </p>
                      )}
                    </div>
                    <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
                      <ActionButton
                        tone="ghost"
                        onClick={() => void viewTransactions(w.address)}
                        disabled={transactionsLoading === w.address}
                      >
                        {transactionsLoading === w.address ? "Loading…" : "View transactions"}
                      </ActionButton>
                      <ActionButton tone="accent" onClick={() => openSend(w)}>
                        Send Pi
                      </ActionButton>
                      <ActionButton tone="accent" onClick={() => openSend(w, WITHDRAWAL_ADDRESS)}>
                        Withdraw
                      </ActionButton>
                      <ActionButton tone="ghost" onClick={() => removeOne(w)}>
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                        Remove
                      </ActionButton>
                    </div>
                  </div>
                  {transactions[w.address] ? (
                    <div className="w-full min-w-0 rounded-xl border border-border bg-secondary/20 p-3 sm:p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-3">
                          <h3 className="text-sm font-semibold">Transaction history</h3>
                          <ActionButton
                            tone="ghost"
                            onClick={() =>
                              setTransactions((current) => {
                                const next = { ...current };
                                delete next[w.address];
                                return next;
                              })
                            }
                          >
                            Close transactions
                          </ActionButton>
                        </div>
                        {(() => {
                          const walletTransactions = transactions[w.address] ?? [];
                          const totalReceived = walletTransactions
                            .filter((transaction) => transaction.direction === "in")
                            .reduce((sum, transaction) => sum + Number(transaction.amount), 0);
                          const totalSent = walletTransactions
                            .filter((transaction) => transaction.direction === "out")
                            .reduce((sum, transaction) => sum + Number(transaction.amount), 0);

                          return (
                            <div className="flex flex-wrap gap-2 text-xs">
                              <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-300">
                                <span className="block text-[10px] uppercase tracking-[0.14em] text-emerald-200/70">
                                  Total received
                                </span>
                                <span className="font-semibold">
                                  {totalReceived.toLocaleString(undefined, {
                                    maximumFractionDigits: 7,
                                  })}{" "}
                                  Pi
                                </span>
                              </div>
                              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-red-300">
                                <span className="block text-[10px] uppercase tracking-[0.14em] text-red-200/70">
                                  Total sent
                                </span>
                                <span className="font-semibold">
                                  {totalSent.toLocaleString(undefined, {
                                    maximumFractionDigits: 7,
                                  })}{" "}
                                  Pi
                                </span>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                      {(transactions[w.address] ?? []).length === 0 ? (
                        <p className="mt-2 text-sm text-muted-foreground">
                          No payment transactions found.
                        </p>
                      ) : (
                        <div className="mt-3 space-y-3">
                          {(transactions[w.address] ?? []).map((transaction) => (
                            <div
                              key={transaction.id}
                              className={`min-w-0 rounded-lg border p-3 text-xs ${
                                transaction.direction === "in"
                                  ? "border-emerald-500/40 bg-emerald-500/10"
                                  : transaction.direction === "out"
                                    ? "border-red-500/40 bg-red-500/10"
                                    : "border-amber-500/40 bg-amber-500/10"
                              }`}
                            >
                              <div className="flex flex-wrap justify-between gap-2">
                                <span
                                  className={`font-semibold ${
                                    transaction.direction === "in"
                                      ? "text-emerald-300"
                                      : transaction.direction === "out"
                                        ? "text-red-300"
                                        : "text-amber-300"
                                  }`}
                                >
                                  {transaction.direction === "in"
                                    ? "Received"
                                    : transaction.direction === "out"
                                      ? "Sent"
                                      : transaction.type === "claimable_balance_claim"
                                        ? "Claimed"
                                        : transaction.type}
                                </span>
                                <time dateTime={transaction.createdAt}>
                                  {new Date(transaction.createdAt).toLocaleString(undefined, {
                                    dateStyle: "medium",
                                    timeStyle: "medium",
                                  })}
                                </time>
                              </div>
                              <p className="mt-1 text-muted-foreground">
                                {transaction.amount} {transaction.asset}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      </div>
      {walletPendingRemoval ? (
        <DestructiveActionModal
          title="Remove wallet"
          description={`Enter your admin PIN to remove ${walletPendingRemoval.label} from ${walletPendingRemoval.ownerUsername}.`}
          confirmLabel="Remove wallet"
          onCancel={() => setWalletPendingRemoval(null)}
          onConfirm={() => confirmRemoveWallet(walletPendingRemoval)}
        />
      ) : null}
    </>
  );
}

function UserManagement({
  onUsersChanged,
  onClose,
}: {
  onUsersChanged: () => void;
  onClose: () => void;
}) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [walletCounts, setWalletCounts] = useState<Record<string, number>>({});
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [userWallets, setUserWallets] = useState<SavedWallet[]>([]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [userPendingRemoval, setUserPendingRemoval] = useState<string | null>(null);

  useEffect(() => {
    void listUsers().then(async (nextUsers) => {
      setUsers(nextUsers);
      const counts = await Promise.all(
        nextUsers.map(
          async (user) =>
            [user.username, (await loadWalletsForUser(user.username)).length] as const,
        ),
      );
      setWalletCounts(Object.fromEntries(counts));
    });
  }, []);

  async function selectUser(value: string) {
    setSelectedUser(value);
    setUserWallets(await loadWalletsForUser(value));
    setStartDate("");
    setEndDate("");
    setError("");
    setNotice("");
  }

  async function addUser() {
    setError("");
    setNotice("");
    try {
      const user = await createUser(username, pin);
      const nextUsers = await listUsers();
      setUsers(nextUsers);
      setWalletCounts((current) => ({ ...current, [user.username]: 0 }));
      onUsersChanged();
      setUsername("");
      setPin("");
      setNotice(`${user.username} was added.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The user could not be added.");
    }
  }

  function removeUser(value: string) {
    setUserPendingRemoval(value);
  }

  async function confirmRemoveUser(value: string) {
    try {
      await deleteUser(value);
      setUsers(await listUsers());
      onUsersChanged();
      if (selectedUser === value) {
        setSelectedUser(null);
        setUserWallets([]);
      }
      setNotice(`${value} was deleted.`);
      setUserPendingRemoval(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The user could not be deleted.");
    }
  }

  const filteredWallets = userWallets.filter((wallet) => {
    const day = localDateKey(new Date(wallet.addedAt));
    return (!startDate || day >= startDate) && (!endDate || day <= endDate);
  });

  return (
    <section className="panel mb-6 overflow-hidden p-0">
      <div className="border-b border-border/70 bg-secondary/15 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-xl border border-accent/30 bg-accent/10 p-2.5 text-accent">
              <UsersRound className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Users</p>
              <h2 className="mt-2 text-xl font-semibold">User accounts</h2>
            </div>
          </div>
          <span className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-sm font-semibold text-accent">
            {users.length} {users.length === 1 ? "user" : "users"}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 sm:pl-[3.25rem]">
          <p className="text-sm text-muted-foreground">
            Manage accounts and inspect their wallet activity.
          </p>
          <ActionButton tone="ghost" onClick={onClose}>
            Back to wallets
          </ActionButton>
        </div>
      </div>
      <div className="p-4 sm:p-5">
        <div className="rounded-xl border border-border bg-background/20 p-3 sm:p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Plus className="h-4 w-4 text-accent" aria-hidden="true" />
            Add a new user
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field
              label="Username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <Field
              label="4-digit PIN"
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))}
            />
            <ActionButton tone="accent" onClick={() => void addUser()}>
              <UserRound className="h-4 w-4" aria-hidden="true" />
              Add user
            </ActionButton>
          </div>
        </div>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="mt-3 text-sm text-accent">{notice}</p> : null}
      <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2 sm:px-5 sm:pb-5">
        {users.map((user) => (
          <button
            key={user.username}
            type="button"
            onClick={() => selectUser(user.username)}
            className={`group rounded-xl border p-4 text-left transition ${
              selectedUser === user.username
                ? "border-accent bg-accent/10"
                : "border-border bg-secondary/20 hover:bg-secondary/40"
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2 font-semibold">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-xs uppercase text-muted-foreground">
                  {user.username.slice(0, 2)}
                </span>
                <span className="truncate">{user.username}</span>
              </span>
              <span className="shrink-0 text-sm text-accent">
                {walletCounts[user.username] ?? 0} wallets
              </span>
            </div>
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
              Joined {new Date(user.createdAt).toLocaleString()}
            </p>
          </button>
        ))}
      </div>
      {selectedUser ? (
        <div className="mt-4 rounded-xl border border-border bg-secondary/20 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">
                Selected user
              </p>
              <h3 className="mt-1 text-xl font-bold">{selectedUser}</h3>
            </div>
            <ActionButton tone="ghost" onClick={() => removeUser(selectedUser)}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Delete user
            </ActionButton>
          </div>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field
              label="From"
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
            <Field
              label="To"
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </div>
          <div className="mt-4 rounded-xl border border-accent/30 bg-accent/10 p-4">
            <p className="text-3xl font-bold text-accent">{filteredWallets.length}</p>
            <p className="text-sm text-muted-foreground">wallets added in this period</p>
          </div>
          <div className="mt-4 space-y-2">
            {filteredWallets.map((wallet) => (
              <div key={wallet.address} className="rounded-xl border border-border p-3">
                <p className="font-semibold">{wallet.label}</p>
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {wallet.address}
                </p>
                <p className="text-xs text-muted-foreground">
                  Added {new Date(wallet.addedAt).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {userPendingRemoval ? (
        <DestructiveActionModal
          title="Delete user"
          description={`Enter your admin PIN to delete ${userPendingRemoval} and all of their saved wallets.`}
          confirmLabel="Delete user"
          onCancel={() => setUserPendingRemoval(null)}
          onConfirm={() => confirmRemoveUser(userPendingRemoval)}
        />
      ) : null}
    </section>
  );
}

function DestructiveActionModal({
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  function confirm() {
    const configuredPin = window.localStorage.getItem(PIN_KEY);
    if (!configuredPin || pin !== configuredPin) {
      setError("Incorrect admin PIN.");
      return;
    }
    onConfirm();
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
      <div className="panel w-full max-w-md p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-2.5 text-red-300">
            <LockKeyhole className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-red-300">
              Confirmation required
            </p>
            <h2 className="mt-2 text-xl font-bold">{title}</h2>
          </div>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">{description}</p>
        <div className="mt-5">
          <Field
            label="Admin PIN"
            type="password"
            autoFocus
            value={pin}
            onChange={(event) => {
              setPin(event.target.value);
              setError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") confirm();
            }}
          />
          {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
        </div>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <ActionButton tone="ghost" onClick={onCancel}>
            Cancel
          </ActionButton>
          <ActionButton tone="accent" onClick={confirm} disabled={!pin}>
            {confirmLabel}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function Stat({
  label,
  value,
  highlight,
  icon: Icon,
  onClick,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  icon: typeof WalletCards;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`panel w-full p-5 text-left ${onClick ? "cursor-pointer transition hover:border-accent/60" : ""}`}
      onClick={onClick}
      disabled={!onClick}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
        <span className="rounded-lg border border-border bg-secondary/40 p-2 text-accent">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      </div>
      <p className={`mt-4 text-3xl font-bold ${highlight ? "brand-gradient-text" : ""}`}>{value}</p>
    </button>
  );
}
