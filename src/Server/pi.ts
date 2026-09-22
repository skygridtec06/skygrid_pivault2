// Pi Network (Stellar-based) client helpers.
// All calls run in the browser; secret keys never leave the device.

export const PI_HORIZON = "https://api.mainnet.minepi.com";
export const PI_PASSPHRASE = "Pi Network";

async function sdk() {
  return await import("@stellar/stellar-sdk");
}

export function shortenAddress(address: string, size = 6) {
  if (address.length <= size * 2 + 3) return address;
  return `${address.slice(0, size)}…${address.slice(-size)}`;
}

export async function publicKeyFromSecret(secret: string): Promise<string> {
  const { Keypair } = await sdk();
  return Keypair.fromSecret(secret.trim()).publicKey();
}

export async function secretFromMnemonic(mnemonic: string): Promise<string> {
  const [{ mnemonicToSeed, validateMnemonic }, { wordlist }, { derivePath }, { Keypair }] =
    await Promise.all([
      import("@scure/bip39"),
      import("@scure/bip39/wordlists/english.js"),
      import("ed25519-hd-key"),
      sdk(),
    ]);
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized.split(" ").length !== 24 || !validateMnemonic(normalized, wordlist)) {
    throw new Error("Enter exactly 24 English wallet words.");
  }
  const seed = await mnemonicToSeed(normalized, "");
  const seedHex = Array.from(seed, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const derived = derivePath("m/44'/314159'/0'", seedHex);
  return Keypair.fromRawEd25519Seed(derived.key).secret();
}

export type PiClaim = {
  id: string;
  amount: string;
  asset: string;
  unlocksAt?: string | null;
};

export type PiAccount = {
  publicKey: string;
  balance: string;
  lockedBalance: string;
  lockedBreakdown: PiClaim[];
  sequence: string;
  subentryCount: number;
  funded: boolean;
};

function extractUnlockDate(predicate: unknown): string | null {
  if (!predicate || typeof predicate !== "object") return null;
  const record = predicate as Record<string, unknown>;

  const absBefore = record["abs_before"];
  if (typeof absBefore === "string") return absBefore;

  const andValues = record["and"];
  if (Array.isArray(andValues)) {
    const values = andValues
      .map((item) => extractUnlockDate(item))
      .filter((value): value is string => typeof value === "string");
    return values.length ? (values.sort()[0] ?? null) : null;
  }

  const orValues = record["or"];
  if (Array.isArray(orValues)) {
    const values = orValues
      .map((item) => extractUnlockDate(item))
      .filter((value): value is string => typeof value === "string");
    return values.length ? (values.sort()[0] ?? null) : null;
  }

  const notValue = record["not"];
  if (notValue && typeof notValue === "object") return extractUnlockDate(notValue);

  return null;
}

export async function loadAccount(publicKey: string): Promise<PiAccount> {
  const { Horizon } = await sdk();
  const server = new Horizon.Server(PI_HORIZON);
  try {
    const [acct, claimablePage] = await Promise.all([
      server.loadAccount(publicKey),
      server.claimableBalances().claimant(publicKey).limit(50).call(),
    ]);
    const native = acct.balances.find((b) => b.asset_type === "native");
    const lockedBreakdown = claimablePage.records
      .map((record) => {
        const claimant = record.claimants.find((candidate) => candidate.destination === publicKey);
        return {
          id: record.id,
          amount: record.amount,
          asset: record.asset,
          unlocksAt: claimant ? extractUnlockDate(claimant.predicate) : null,
        };
      })
      .filter((item) => Number(item.amount) > 0);
    const lockedBalance = lockedBreakdown
      .reduce((sum, item) => sum + Number(item.amount || "0"), 0)
      .toString();

    return {
      publicKey,
      balance: native && "balance" in native ? native.balance : "0",
      lockedBalance,
      lockedBreakdown,
      sequence: acct.sequenceNumber(),
      subentryCount: acct.subentry_count,
      funded: true,
    };
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return {
        publicKey,
        balance: "0",
        lockedBalance: "0",
        lockedBreakdown: [],
        sequence: "0",
        subentryCount: 0,
        funded: false,
      };
    }

    throw err;
  }
}

export async function loadAccountBalance(publicKey: string): Promise<PiAccount> {
  const { Horizon } = await sdk();
  const server = new Horizon.Server(PI_HORIZON);
  try {
    const acct = await server.loadAccount(publicKey);
    const native = acct.balances.find((b) => b.asset_type === "native");
    return {
      publicKey,
      balance: native && "balance" in native ? native.balance : "0",
      lockedBalance: "0",
      lockedBreakdown: [],
      sequence: acct.sequenceNumber(),
      subentryCount: acct.subentry_count,
      funded: true,
    };
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return {
        publicKey,
        balance: "0",
        lockedBalance: "0",
        lockedBreakdown: [],
        sequence: "0",
        subentryCount: 0,
        funded: false,
      };
    }
    throw err;
  }
}

export type PiPayment = {
  id: string;
  type: string;
  direction: "in" | "out" | "other";
  counterparty: string;
  amount: string;
  asset: string;
  createdAt: string;
  hash: string;
};

export async function loadPayments(
  publicKey: string,
  limit = Number.POSITIVE_INFINITY,
): Promise<PiPayment[]> {
  const { Horizon } = await sdk();
  const server = new Horizon.Server(PI_HORIZON);
  try {
    const pageLimit = 200;
    const payments = server.payments().forAccount(publicKey).order("desc").limit(pageLimit);
    const records: Array<{
      id: string;
      type: string;
      from?: string;
      to?: string;
      funder?: string;
      account?: string;
      amount?: string;
      starting_balance?: string;
      asset_type?: string;
      asset_code?: string;
      asset_issuer?: string;
      created_at: string;
      transaction_hash: string;
    }> = [];
    let page = await payments.call();
    records.push(...(page.records as typeof records));
    while (records.length < limit && page.records.length === pageLimit) {
      page = await page.next();
      records.push(...(page.records as typeof records));
    }

    return records.slice(0, limit).map((r) => {
      const rec = r as unknown as {
        id: string;
        type: string;
        from?: string;
        to?: string;
        funder?: string;
        account?: string;
        amount?: string;
        starting_balance?: string;
        asset_type?: string;
        asset_code?: string;
        asset_issuer?: string;
        created_at: string;
        transaction_hash: string;
      };
      const from = rec.from ?? rec.funder ?? "";
      const to = rec.to ?? rec.account ?? "";
      const direction = to === publicKey ? "in" : from === publicKey ? "out" : "other";
      const asset =
        rec.asset_type === "native"
          ? "Pi"
          : rec.asset_code
            ? `${rec.asset_code}${rec.asset_issuer ? ` (${rec.asset_issuer})` : ""}`
            : "Unknown asset";
      return {
        id: rec.id,
        type: rec.type,
        direction: direction as PiPayment["direction"],
        counterparty: direction === "in" ? from : to,
        amount: rec.amount ?? rec.starting_balance ?? "0",
        asset,
        createdAt: rec.created_at,
        hash: rec.transaction_hash,
      };
    });
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) return [];
    throw err;
  }
}

export type SendResult = { hash: string; ledger?: number | undefined };

export async function sendPi(opts: {
  secret: string;
  destination: string;
  amount: string;
  memo?: string;
}): Promise<SendResult> {
  const { Horizon, Keypair, TransactionBuilder, Operation, Asset, Memo, extractBaseAddress } =
    await sdk();
  const server = new Horizon.Server(PI_HORIZON);
  const keypair = Keypair.fromSecret(opts.secret.trim());
  const source = await server.loadAccount(keypair.publicKey());
  const startedAt = Date.now();
  const destination = opts.destination.trim();
  const isMuxedDestination = destination.startsWith("M");
  const accountLookupAddress = isMuxedDestination ? extractBaseAddress(destination) : destination;

  const [baseFee, destinationExists] = await Promise.all([
    server.fetchBaseFee(),
    (async () => {
      try {
        await server.loadAccount(accountLookupAddress);
        return true;
      } catch (err: unknown) {
        if ((err as { response?: { status?: number } })?.response?.status === 404) {
          return false;
        }
        throw err;
      }
    })(),
  ]);

  const builder = new TransactionBuilder(source, {
    fee: String(baseFee),
    networkPassphrase: PI_PASSPHRASE,
  });

  if (destinationExists || isMuxedDestination) {
    builder.addOperation(
      Operation.payment({
        destination,
        asset: Asset.native(),
        amount: opts.amount,
      }),
    );
  } else {
    builder.addOperation(
      Operation.createAccount({
        destination: opts.destination.trim(),
        startingBalance: opts.amount,
      }),
    );
  }

  if (opts.memo && opts.memo.trim()) builder.addMemo(Memo.text(opts.memo.trim().slice(0, 28)));

  const tx = builder.setTimeout(60).build();
  tx.sign(keypair);
  const res = (await server.submitTransaction(tx)) as unknown as { hash: string; ledger?: number };
  const remainingDelay = 1000 - (Date.now() - startedAt);
  if (remainingDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, remainingDelay));
  }
  return { hash: res.hash, ledger: res.ledger };
}

export function readableError(err: unknown): string {
  const e = err as {
    message?: string;
    response?: { data?: { extras?: { result_codes?: Record<string, unknown> } } };
  };
  const codes = e?.response?.data?.extras?.result_codes;
  if (codes) {
    const op = Array.isArray(codes["operations"])
      ? (codes["operations"] as string[]).join(", ")
      : "";
    const map: Record<string, string> = {
      op_underfunded: "Not enough Pi in this wallet for that amount plus the fee.",
      op_no_destination: "The destination wallet does not exist yet.",
      op_low_reserve: "Amount is below the minimum needed to activate a new wallet (1 Pi).",
      tx_insufficient_balance: "Not enough Pi to cover the amount and network fee.",
      tx_insufficient_fee: "The network fee changed. Please try sending again.",
      tx_bad_seq: "Wallet was busy, please try again.",
    };
    return (
      map[op] ??
      map[String(codes["transaction"])] ??
      `Transaction failed: ${op || codes["transaction"]}`
    );
  }
  if (e?.message?.includes("invalid encoded string") || e?.message?.includes("checksum"))
    return "That key or address doesn't look valid.";
  return e?.message ?? "Something went wrong.";
}
