import type { HeliusAsset } from "@memecoin-alpha/providers";

interface RpcEnvelope<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

interface TokenAccountAmount {
  amount?: string;
}

interface TokenLargestAccounts {
  value?: TokenAccountAmount[];
}

interface TokenSupply {
  value?: { amount?: string };
}

interface ParsedMintAccount {
  value?: {
    owner?: string;
    data?: {
      parsed?: {
        info?: Record<string, unknown>;
      };
    };
  } | null;
}

export interface SolanaTokenRiskAssessment {
  known: boolean;
  passed: boolean;
  riskScore: number;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  topHolderPercent: number;
  top10HolderPercent: number;
  tokenProgram: "spl-token" | "token-2022" | "unknown";
  tokenExtensionEvidenceKnown: boolean;
  tokenExtensions: string[];
  blockingTokenExtensions: string[];
  creatorAddress?: string;
  warnings: string[];
  evidence: Record<string, unknown>;
}

export interface FetchSolanaTokenRiskOptions {
  rpcUrl: string;
  mint: string;
  asset?: HeliusAsset;
  maximumTopHolderPercent: number;
  fetchImpl?: typeof fetch;
}

export interface SolanaRiskMarketGateInput {
  liquidityUsd: number;
  volume5mUsd: number;
  buys5m: number;
  sells5m: number;
  minimumLiquidityUsd: number;
  minimumVolume5mUsd: number;
  maximumSwaps5m: number;
  maximumVolumeLiquidityRatio: number;
}

/** Cheap market-data gate that runs before any paid DAS lookup. */
export function passesSolanaRiskMarketGate(input: SolanaRiskMarketGateInput): boolean {
  const swaps5m = input.buys5m + input.sells5m;
  const buyShare5m = input.buys5m / Math.max(swaps5m, 1);
  const volumeLiquidityRatio = input.volume5mUsd / Math.max(input.liquidityUsd, 1);
  return (
    input.liquidityUsd >= input.minimumLiquidityUsd &&
    input.volume5mUsd >= input.minimumVolume5mUsd &&
    swaps5m >= 5 &&
    swaps5m <= input.maximumSwaps5m &&
    buyShare5m >= 0.5 &&
    buyShare5m <= 0.85 &&
    volumeLiquidityRatio <= input.maximumVolumeLiquidityRatio
  );
}

export async function fetchSolanaTokenRisk(
  options: FetchSolanaTokenRiskOptions
): Promise<SolanaTokenRiskAssessment> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const [largest, supply, mintAccount] = await Promise.all([
    rpc<TokenLargestAccounts>(fetchImpl, options.rpcUrl, "getTokenLargestAccounts", [
      options.mint,
      { commitment: "confirmed" }
    ]),
    rpc<TokenSupply>(fetchImpl, options.rpcUrl, "getTokenSupply", [
      options.mint,
      { commitment: "confirmed" }
    ]),
    rpc<ParsedMintAccount>(fetchImpl, options.rpcUrl, "getAccountInfo", [
      options.mint,
      { commitment: "confirmed", encoding: "jsonParsed" }
    ])
  ]);

  const parsedInfo = mintAccount.value?.data?.parsed?.info;
  const rpcAsset = parsedInfo ? mintInfoAsset(options.mint, parsedInfo) : undefined;
  const resolvedAsset = options.asset ?? rpcAsset;

  return evaluateSolanaTokenRisk({
    ...(resolvedAsset ? { asset: resolvedAsset } : {}),
    largestRawAmounts: (largest.value ?? []).map((row) => row.amount ?? "0"),
    supplyRawAmount: supply.value?.amount ?? "0",
    maximumTopHolderPercent: options.maximumTopHolderPercent,
    ...(mintAccount.value?.owner ? { tokenProgramOwner: mintAccount.value.owner } : {}),
    tokenExtensions: parsedInfo?.extensions
  });
}

const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const BLOCKING_TOKEN_2022_EXTENSIONS = new Set([
  "confidentialtransferfeeconfig",
  "confidentialtransfermint",
  "defaultaccountstate",
  "interestbearingconfig",
  "mintcloseauthority",
  "nontransferable",
  "pausable",
  "permanentdelegate",
  "scaleduiamount",
  "transferfeeconfig",
  "transferhook"
]);
const REVIEWED_NON_BLOCKING_TOKEN_2022_EXTENSIONS = new Set([
  "grouppointer",
  "groupmemberpointer",
  "metadatapointer",
  "tokenmetadata",
  "tokengroup",
  "tokengroupmember"
]);

function mintInfoAsset(mint: string, info: Record<string, unknown>): HeliusAsset {
  const tokenInfo: NonNullable<HeliusAsset["token_info"]> = {};
  if (Object.prototype.hasOwnProperty.call(info, "mintAuthority")) {
    tokenInfo.mint_authority = typeof info.mintAuthority === "string" ? info.mintAuthority : null;
  }
  if (Object.prototype.hasOwnProperty.call(info, "freezeAuthority")) {
    tokenInfo.freeze_authority =
      typeof info.freezeAuthority === "string" ? info.freezeAuthority : null;
  }
  if (typeof info.decimals === "number") tokenInfo.decimals = info.decimals;
  return { id: mint, token_info: tokenInfo };
}

export function evaluateSolanaTokenRisk(input: {
  asset?: HeliusAsset;
  largestRawAmounts: string[];
  supplyRawAmount: string;
  maximumTopHolderPercent: number;
  tokenProgramOwner?: string;
  tokenExtensions?: unknown;
}): SolanaTokenRiskAssessment {
  const tokenInfo = input.asset?.token_info;
  const hasMintAuthorityEvidence = Boolean(
    tokenInfo && Object.prototype.hasOwnProperty.call(tokenInfo, "mint_authority")
  );
  const hasFreezeAuthorityEvidence = Boolean(
    tokenInfo && Object.prototype.hasOwnProperty.call(tokenInfo, "freeze_authority")
  );
  const mintAuthorityRevoked = hasMintAuthorityEvidence && tokenInfo?.mint_authority === null;
  const freezeAuthorityRevoked = hasFreezeAuthorityEvidence && tokenInfo?.freeze_authority === null;
  const supply = safeBigInt(input.supplyRawAmount);
  const holders = input.largestRawAmounts.map(safeBigInt).filter((value) => value >= 0n);
  const holderEvidenceKnown = supply > 0n && holders.length > 0;
  const topHolderPercent = holderEvidenceKnown ? ratioPercent(holders[0] ?? 0n, supply) : 100;
  const top10HolderPercent = holderEvidenceKnown
    ? ratioPercent(
        holders.slice(0, 10).reduce((sum, value) => sum + value, 0n),
        supply
      )
    : 100;
  const tokenProgram =
    input.tokenProgramOwner === SPL_TOKEN_PROGRAM_ID
      ? "spl-token"
      : input.tokenProgramOwner === TOKEN_2022_PROGRAM_ID
        ? "token-2022"
        : "unknown";
  const parsedExtensions = parseTokenExtensionNames(input.tokenExtensions);
  const tokenExtensionEvidenceKnown =
    tokenProgram === "spl-token" || (tokenProgram === "token-2022" && parsedExtensions !== null);
  const tokenExtensions = parsedExtensions ?? [];
  const blockingTokenExtensions =
    tokenProgram === "token-2022"
      ? tokenExtensions.filter(
          (extension) =>
            BLOCKING_TOKEN_2022_EXTENSIONS.has(extension) ||
            !REVIEWED_NON_BLOCKING_TOKEN_2022_EXTENSIONS.has(extension)
        )
      : [];
  const tokenBehaviorPassed =
    tokenExtensionEvidenceKnown && blockingTokenExtensions.length === 0;
  const known =
    hasMintAuthorityEvidence &&
    hasFreezeAuthorityEvidence &&
    holderEvidenceKnown &&
    tokenExtensionEvidenceKnown;
  const warnings: string[] = [];

  if (!known) warnings.push("Critical token safety evidence is incomplete.");
  if (tokenProgram === "unknown") warnings.push("Token program ownership is unknown.");
  if (tokenProgram === "token-2022" && !tokenExtensionEvidenceKnown) {
    warnings.push("Token-2022 extension evidence is unavailable or unparsed.");
  }
  if (blockingTokenExtensions.length > 0) {
    warnings.push(
      `Unsupported or transfer-changing Token-2022 extensions: ${blockingTokenExtensions.join(", ")}.`
    );
  }
  if (!mintAuthorityRevoked) warnings.push("Mint authority is retained or unknown.");
  if (!freezeAuthorityRevoked) warnings.push("Freeze authority is retained or unknown.");
  if (topHolderPercent > input.maximumTopHolderPercent) {
    warnings.push(`Top-holder concentration is ${round(topHolderPercent)}%.`);
  }
  if (top10HolderPercent > 70) {
    warnings.push(`Top-10 concentration is ${round(top10HolderPercent)}%.`);
  }

  const riskScore = Math.min(
    100,
    (!known ? 40 : 0) +
      (!tokenBehaviorPassed ? 35 : 0) +
      (!mintAuthorityRevoked ? 22 : 0) +
      (!freezeAuthorityRevoked ? 18 : 0) +
      Math.max(0, topHolderPercent - input.maximumTopHolderPercent) * 1.2 +
      Math.max(0, top10HolderPercent - 70) * 0.6
  );
  const creatorAddress = input.asset ? creatorAddressFromAsset(input.asset) : undefined;

  return {
    known,
    passed:
      known &&
      mintAuthorityRevoked &&
      freezeAuthorityRevoked &&
      tokenBehaviorPassed &&
      topHolderPercent <= input.maximumTopHolderPercent &&
      top10HolderPercent <= 70,
    riskScore: round(riskScore),
    mintAuthorityRevoked,
    freezeAuthorityRevoked,
    topHolderPercent: round(topHolderPercent),
    top10HolderPercent: round(top10HolderPercent),
    tokenProgram,
    tokenExtensionEvidenceKnown,
    tokenExtensions,
    blockingTokenExtensions,
    ...(creatorAddress ? { creatorAddress } : {}),
    warnings,
    evidence: {
      source: "solana-rpc+helius-das",
      assetId: input.asset?.id ?? null,
      tokenProgramOwner: input.tokenProgramOwner ?? null,
      tokenProgram,
      tokenExtensionEvidenceKnown,
      tokenExtensions,
      blockingTokenExtensions,
      supplyRawAmount: input.supplyRawAmount,
      largestRawAmounts: input.largestRawAmounts.slice(0, 10)
    }
  };
}

function parseTokenExtensionNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names = value.flatMap((extension) => {
    if (typeof extension === "string") return [normalizeExtensionName(extension)];
    if (!extension || typeof extension !== "object") return [];
    const record = extension as Record<string, unknown>;
    const name =
      typeof record.extension === "string"
        ? record.extension
        : typeof record.type === "string"
          ? record.type
          : undefined;
    return name ? [normalizeExtensionName(name)] : [];
  });
  // An object without a recognizable discriminator is not complete evidence.
  if (value.length > 0 && names.length !== value.length) return null;
  return [...new Set(names)].sort();
}

function normalizeExtensionName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

export function creatorAddressFromAsset(asset: HeliusAsset): string | undefined {
  return (
    asset.creators?.find((creator) => creator.verified)?.address ??
    asset.creators?.[0]?.address ??
    asset.authorities?.[0]?.address
  );
}

async function rpc<T>(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  method: string,
  params: unknown[]
): Promise<T> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}.`);
  const payload = (await response.json()) as RpcEnvelope<T>;
  if (payload.error || payload.result === undefined) {
    throw new Error(`${method} failed: ${payload.error?.message ?? "missing result"}`);
  }
  return payload.result;
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function ratioPercent(value: bigint, total: bigint): number {
  if (total <= 0n) return 100;
  return Number((value * 1_000_000n) / total) / 10_000;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
