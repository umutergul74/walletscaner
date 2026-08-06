import type { SolanaChainEvent } from "./solana-event-source";

export interface WalletTradeDecodeContext {
  poolAddress: string;
  tokenAddress: string;
  quoteTokenAddress?: string;
  poolCreatedAt?: string;
  /** Authorities verified by a venue-specific decoder may be non-fee-payer accounts. */
  verifiedUserAuthorityAddresses?: string[];
  /** Vaults, bonding curves, router authorities and other known program infrastructure. */
  infrastructureAddresses?: string[];
  instructionIndex?: number;
  innerInstructionIndex?: number;
  decoderVersion?: string;
}

export interface DecodedTokenAmount {
  rawAmount: string;
  decimals: number;
}

export interface WalletTradeDiscovery {
  idempotencyKey: string;
  signature: string;
  slot: number;
  transactionIndex?: number;
  instructionIndex?: number;
  innerInstructionIndex?: number;
  decoderVersion: string;
  observedAt: string;
  poolAddress: string;
  walletAddress: string;
  tokenAddress: string;
  quoteTokenAddress?: string;
  side: "buy" | "sell";
  baseAmount: number;
  quoteAmount?: number;
  baseTokenAmount?: DecodedTokenAmount;
  quoteTokenAmount?: DecodedTokenAmount;
  poolCreatedAt?: string;
  poolAgeMinutes?: number;
  raw: Record<string, unknown>;
}

interface TokenBalanceRow {
  accountIndex?: unknown;
  owner?: unknown;
  mint?: unknown;
  uiTokenAmount?: {
    amount?: unknown;
    decimals?: unknown;
    uiAmount?: unknown;
    uiAmountString?: unknown;
  };
}

interface TokenBalanceAccumulator {
  preRaw: bigint;
  postRaw: bigint;
  preRawExact: boolean;
  postRawExact: boolean;
  preUi: number;
  postUi: number;
  decimals?: number;
  decimalsConsistent: boolean;
}

interface AmountDelta {
  uiAmount: number;
  rawAmount?: string;
  decimals?: number;
}

const MIN_UI_DELTA = 0.000001;
const DEFAULT_DECODER_VERSION = "wallet-balance-v2";

/**
 * Decode wallet-owned balance movement only for transaction signers or an
 * authority explicitly verified by a venue decoder. Token-balance owners on
 * their own are not evidence that an address is a trader: pool vaults and PDAs
 * also appear there.
 */
export function decodeWalletTrades(
  event: SolanaChainEvent,
  context: WalletTradeDecodeContext
): WalletTradeDiscovery[] {
  const meta = event.transaction.meta as
    | {
        err?: unknown;
        preTokenBalances?: TokenBalanceRow[];
        postTokenBalances?: TokenBalanceRow[];
        preBalances?: unknown[];
        postBalances?: unknown[];
      }
    | undefined;
  if (!meta || meta.err) return [];

  const blockTime = finiteUnixSeconds(event.transaction.blockTime);
  // Wallet alpha must be ordered by chain time, never by worker receive time.
  if (blockTime === null) return [];

  const message = event.transaction.transaction?.message as
    | {
        header?: { numRequiredSignatures?: unknown };
        accountKeys?: Array<
          string | { pubkey?: string; signer?: boolean; writable?: boolean }
        >;
      }
    | undefined;
  const accountKeys = (message?.accountKeys ?? []).map((account) =>
    typeof account === "string" ? account : account.pubkey ?? ""
  );
  const verifiedTraders = verifiedTraderAddresses(message, context);
  if (verifiedTraders.size === 0) return [];

  const tokenBalances = new Map<string, TokenBalanceAccumulator>();
  for (const row of meta.preTokenBalances ?? []) {
    addTokenBalance(tokenBalances, row, "pre");
  }
  for (const row of meta.postTokenBalances ?? []) {
    addTokenBalance(tokenBalances, row, "post");
  }

  const nativeDeltas = new Map<string, AmountDelta>();
  const preBalances = meta.preBalances ?? [];
  const postBalances = meta.postBalances ?? [];
  for (let index = 0; index < accountKeys.length; index += 1) {
    const address = accountKeys[index];
    if (!address) continue;
    const pre = integerBigInt(preBalances[index]);
    const post = integerBigInt(postBalances[index]);
    if (pre === null || post === null) continue;
    const rawDelta = post - pre;
    nativeDeltas.set(address, {
      uiAmount: Number(rawDelta) / 1_000_000_000,
      rawAmount: rawDelta.toString(),
      decimals: 9
    });
  }

  const observedAt = new Date(blockTime * 1_000).toISOString();
  const poolAgeMinutes = context.poolCreatedAt
    ? (new Date(observedAt).getTime() - new Date(context.poolCreatedAt).getTime()) / 60_000
    : undefined;
  const owners = new Set(
    [...tokenBalances.keys()]
      .map((key) => key.slice(0, key.lastIndexOf(":")))
      .filter(Boolean)
  );
  const decoderVersion = context.decoderVersion ?? DEFAULT_DECODER_VERSION;

  return [...owners].flatMap((walletAddress) => {
    if (!verifiedTraders.has(walletAddress)) return [];
    if (isInfrastructureAddress(walletAddress, context)) return [];
    const baseDelta = balanceDelta(tokenBalances, walletAddress, context.tokenAddress);
    if (!baseDelta || Math.abs(baseDelta.uiAmount) < MIN_UI_DELTA) return [];

    const tokenQuoteDelta = context.quoteTokenAddress
      ? balanceDelta(tokenBalances, walletAddress, context.quoteTokenAddress)
      : undefined;
    const nativeQuoteDelta = nativeDeltas.get(walletAddress);
    const selectedQuoteDelta = tokenQuoteDelta &&
      Math.abs(tokenQuoteDelta.uiAmount) >= MIN_UI_DELTA
      ? tokenQuoteDelta
      : nativeQuoteDelta;
    const quoteDelta = selectedQuoteDelta?.uiAmount ?? 0;
    const side = baseDelta.uiAmount > 0 ? "buy" : "sell";
    const quoteAmount =
      side === "buy" && quoteDelta < 0
        ? Math.abs(quoteDelta)
        : side === "sell" && quoteDelta > 0
          ? quoteDelta
          : undefined;
    const baseTokenAmount = exactAbsoluteAmount(baseDelta);
    const quoteTokenAmount = quoteAmount !== undefined
      ? exactAbsoluteAmount(selectedQuoteDelta)
      : undefined;
    const idempotencyKey = walletTradeIdempotencyKey({
      signature: event.signature,
      ...(event.transactionIndex !== undefined
        ? { transactionIndex: event.transactionIndex }
        : {}),
      ...(context.instructionIndex !== undefined
        ? { instructionIndex: context.instructionIndex }
        : {}),
      ...(context.innerInstructionIndex !== undefined
        ? { innerInstructionIndex: context.innerInstructionIndex }
        : {}),
      walletAddress,
      mint: context.tokenAddress,
      side,
      decoderVersion
    });

    return [{
      idempotencyKey,
      signature: event.signature,
      slot: event.slot,
      ...(event.transactionIndex !== undefined
        ? { transactionIndex: event.transactionIndex }
        : {}),
      ...(context.instructionIndex !== undefined
        ? { instructionIndex: context.instructionIndex }
        : {}),
      ...(context.innerInstructionIndex !== undefined
        ? { innerInstructionIndex: context.innerInstructionIndex }
        : {}),
      decoderVersion,
      observedAt,
      poolAddress: context.poolAddress,
      walletAddress,
      tokenAddress: context.tokenAddress,
      ...(context.quoteTokenAddress ? { quoteTokenAddress: context.quoteTokenAddress } : {}),
      side,
      baseAmount: Math.abs(baseDelta.uiAmount),
      ...(quoteAmount !== undefined && quoteAmount > 0 ? { quoteAmount } : {}),
      ...(baseTokenAmount ? { baseTokenAmount } : {}),
      ...(quoteTokenAmount ? { quoteTokenAmount } : {}),
      ...(context.poolCreatedAt ? { poolCreatedAt: context.poolCreatedAt } : {}),
      ...(poolAgeMinutes !== undefined && Number.isFinite(poolAgeMinutes)
        ? { poolAgeMinutes }
        : {}),
      raw: {
        decoder: "verified-wallet-balance-delta",
        decoderVersion,
        transactionIndex: event.transactionIndex ?? null,
        instructionIndex: context.instructionIndex ?? null,
        innerInstructionIndex: context.innerInstructionIndex ?? null,
        baseDelta: baseDelta.uiAmount,
        baseRawDelta: baseDelta.rawAmount ?? null,
        quoteTokenDelta: tokenQuoteDelta?.uiAmount ?? 0,
        quoteTokenRawDelta: tokenQuoteDelta?.rawAmount ?? null,
        nativeQuoteDelta: nativeQuoteDelta?.uiAmount ?? 0,
        nativeQuoteRawDelta: nativeQuoteDelta?.rawAmount ?? null,
        chainBlockTime: blockTime,
        authorityEvidence: verifiedUserAuthorityType(message, walletAddress, context)
      }
    } satisfies WalletTradeDiscovery];
  });
}

export function walletTradeIdempotencyKey(input: {
  signature: string;
  transactionIndex?: number;
  instructionIndex?: number;
  innerInstructionIndex?: number;
  walletAddress: string;
  mint: string;
  side: "buy" | "sell";
  decoderVersion: string;
}): string {
  return [
    "wallet-trade",
    input.signature,
    input.transactionIndex ?? "transaction-index-unknown",
    input.instructionIndex ?? "transaction-balance",
    input.innerInstructionIndex ?? "no-inner-instruction",
    input.walletAddress,
    input.mint,
    input.side,
    input.decoderVersion
  ].join(":");
}

function verifiedTraderAddresses(
  message: {
    header?: { numRequiredSignatures?: unknown };
    accountKeys?: Array<string | { pubkey?: string; signer?: boolean }>;
  } | undefined,
  context: WalletTradeDecodeContext
): Set<string> {
  const verified = new Set(context.verifiedUserAuthorityAddresses ?? []);
  const keys = message?.accountKeys ?? [];
  const requiredSignatures = finiteNonNegativeInteger(
    message?.header?.numRequiredSignatures
  );
  keys.forEach((account, index) => {
    const address = typeof account === "string" ? account : account.pubkey;
    if (!address) return;
    if (typeof account !== "string" && account.signer === true) verified.add(address);
    if (requiredSignatures !== null && index < requiredSignatures) verified.add(address);
  });
  // In a valid Solana message the first static key is the fee payer and signer.
  // This preserves compatibility with compact fixtures/RPC responses that omit
  // the parsed `signer` flag and message header.
  if (requiredSignatures === null) {
    const first = keys[0];
    const feePayer = typeof first === "string" ? first : first?.pubkey;
    if (feePayer) verified.add(feePayer);
  }
  return verified;
}

function verifiedUserAuthorityType(
  message: {
    header?: { numRequiredSignatures?: unknown };
    accountKeys?: Array<string | { pubkey?: string; signer?: boolean }>;
  } | undefined,
  walletAddress: string,
  context: WalletTradeDecodeContext
): "signer" | "venue-authority" {
  const keys = message?.accountKeys ?? [];
  const requiredSignatures = finiteNonNegativeInteger(
    message?.header?.numRequiredSignatures
  );
  const signer = keys.some((account, index) => {
    const address = typeof account === "string" ? account : account.pubkey;
    return address === walletAddress &&
      ((typeof account !== "string" && account.signer === true) ||
        (requiredSignatures !== null && index < requiredSignatures) ||
        (requiredSignatures === null && index === 0));
  });
  return signer || !context.verifiedUserAuthorityAddresses?.includes(walletAddress)
    ? "signer"
    : "venue-authority";
}

function addTokenBalance(
  balances: Map<string, TokenBalanceAccumulator>,
  row: TokenBalanceRow,
  side: "pre" | "post"
): void {
  const owner = typeof row.owner === "string" ? row.owner : "";
  const mint = typeof row.mint === "string" ? row.mint : "";
  if (!owner || !mint) return;
  const key = `${owner}:${mint}`;
  const value = balances.get(key) ?? {
    preRaw: 0n,
    postRaw: 0n,
    preRawExact: true,
    postRawExact: true,
    preUi: 0,
    postUi: 0,
    decimalsConsistent: true
  };
  const decimals = finiteNonNegativeInteger(row.uiTokenAmount?.decimals);
  if (decimals !== null) {
    if (value.decimals !== undefined && value.decimals !== decimals) {
      value.decimalsConsistent = false;
    } else {
      value.decimals = decimals;
    }
  }
  const raw = unsignedBigInt(row.uiTokenAmount?.amount) ??
    (decimals !== null
      ? decimalUiToRaw(row.uiTokenAmount?.uiAmountString, decimals)
      : null);
  if (side === "pre") {
    if (raw === null) value.preRawExact = false;
    else value.preRaw += raw;
    value.preUi += tokenUiAmount(row, raw, decimals);
  } else {
    if (raw === null) value.postRawExact = false;
    else value.postRaw += raw;
    value.postUi += tokenUiAmount(row, raw, decimals);
  }
  balances.set(key, value);
}

function balanceDelta(
  balances: Map<string, TokenBalanceAccumulator>,
  owner: string,
  mint: string
): AmountDelta | undefined {
  const value = balances.get(`${owner}:${mint}`);
  if (!value) return undefined;
  if (
    value.preRawExact &&
    value.postRawExact &&
    value.decimalsConsistent &&
    value.decimals !== undefined
  ) {
    const rawDelta = value.postRaw - value.preRaw;
    const uiAmount = Number(rawDelta) / 10 ** value.decimals;
    if (Number.isFinite(uiAmount)) {
      return {
        uiAmount,
        rawAmount: rawDelta.toString(),
        decimals: value.decimals
      };
    }
  }
  const uiAmount = value.postUi - value.preUi;
  return Number.isFinite(uiAmount) ? { uiAmount } : undefined;
}

function exactAbsoluteAmount(delta: AmountDelta | undefined): DecodedTokenAmount | undefined {
  if (!delta?.rawAmount || delta.decimals === undefined) return undefined;
  const raw = BigInt(delta.rawAmount);
  return { rawAmount: (raw < 0n ? -raw : raw).toString(), decimals: delta.decimals };
}

function tokenUiAmount(
  row: TokenBalanceRow,
  raw: bigint | null,
  decimals: number | null
): number {
  if (raw !== null && decimals !== null) {
    const value = Number(raw) / 10 ** decimals;
    if (Number.isFinite(value)) return value;
  }
  return finiteNumber(row.uiTokenAmount?.uiAmountString ?? row.uiTokenAmount?.uiAmount) ?? 0;
}

function decimalUiToRaw(value: unknown, decimals: number): bigint | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  const padded = fraction.padEnd(decimals, "0");
  if (padded.length > decimals && /[1-9]/.test(padded.slice(decimals))) return null;
  return BigInt(`${whole}${padded.slice(0, decimals)}` || "0");
}

function unsignedBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

function integerBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function finiteUnixSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function isInfrastructureAddress(
  address: string,
  context: WalletTradeDecodeContext
): boolean {
  return (
    address.length < 32 ||
    address === context.poolAddress ||
    address === context.tokenAddress ||
    address === context.quoteTokenAddress ||
    context.infrastructureAddresses?.includes(address) === true
  );
}
