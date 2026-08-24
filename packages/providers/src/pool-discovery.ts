import bs58 from "bs58";
import type { SolanaChainEvent } from "./solana-event-source";

export const POOL_DISCOVERY_DECODER_VERSION = "walletscaner-v3-inner-cpi";

export interface PoolDiscovery {
  signature: string;
  slot: number;
  observedAt: string;
  programId: string;
  poolAddress: string;
  baseTokenAddress: string;
  quoteTokenAddress?: string;
  creatorAddress?: string;
  createdAt: string;
  instructionIndex: number;
  innerInstructionIndex?: number;
  raw: Record<string, unknown>;
}

export interface PoolEventDecoder {
  programId: string;
  decode(event: SolanaChainEvent): PoolDiscovery[];
}

export function decodePoolDiscoveries(
  event: SolanaChainEvent,
  decoders: PoolEventDecoder[]
): PoolDiscovery[] {
  return decoders
    .filter((decoder) => decoder.programId === event.address)
    .flatMap((decoder) => decoder.decode(event))
    .filter(
      (discovery, index, discoveries) =>
        discoveries.findIndex((candidate) => candidate.poolAddress === discovery.poolAddress) === index
    );
}

export function createParsedInstructionPoolDecoder(options: {
  programId: string;
  instructionTypes: string[];
}): PoolEventDecoder {
  return {
    programId: options.programId,
    decode(event) {
      return transactionInstructionCandidates(event).flatMap(
        ({ instruction, instructionIndex, innerInstructionIndex }) => {
          const parsed = instruction.parsed as
            | { type?: string; info?: Record<string, unknown> }
            | undefined;
          if (
            instruction.programId !== options.programId ||
            !parsed?.type ||
            !options.instructionTypes.includes(parsed.type)
          ) {
            return [];
          }
          const info = parsed.info ?? {};
          const poolAddress = stringField(info, ["pool", "poolAddress", "amm"]);
          const baseTokenAddress = stringField(info, ["baseMint", "tokenMint", "mint"]);
          if (!poolAddress || !baseTokenAddress) return [];
          const quoteTokenAddress = stringField(info, ["quoteMint", "currencyMint"]);
          return [
            {
              signature: event.signature,
              slot: event.slot,
              observedAt: event.observedAt,
              programId: options.programId,
              poolAddress,
              baseTokenAddress,
              ...(quoteTokenAddress ? { quoteTokenAddress } : {}),
              createdAt: chainOccurredAt(event),
              instructionIndex,
              ...(innerInstructionIndex !== undefined ? { innerInstructionIndex } : {}),
              raw: {
                decoder: "parsed-instruction",
                instructionIndex,
                ...(innerInstructionIndex !== undefined ? { innerInstructionIndex } : {}),
                instruction
              }
            }
          ];
        }
      );
    }
  };
}

export interface RawPoolInstructionDefinition {
  name: string;
  discriminatorHex: string;
  poolAccountIndex: number;
  baseTokenAccountIndex?: number;
  quoteTokenAccountIndex?: number;
  /** Resolve canonical token A/B pools only when exactly one mint is a reviewed quote asset. */
  tokenPairAccountIndexes?: [number, number];
  quoteTokenAddresses?: string[];
  creatorAccountIndex?: number;
  creatorDataEncoding?: "pump-borsh-after-3-strings";
}

export function createRawInstructionPoolDecoder(options: {
  programId: string;
  instructions: RawPoolInstructionDefinition[];
}): PoolEventDecoder {
  const definitions = options.instructions.map((definition) => ({
    ...definition,
    discriminator: Buffer.from(
      definition.discriminatorHex.replace(/^0x/i, ""),
      "hex"
    )
  }));
  return {
    programId: options.programId,
    decode(event) {
      const message = event.transaction.transaction?.message as
        | {
            accountKeys?: Array<string | { pubkey?: string }>;
          }
        | undefined;
      const loadedAddresses = event.transaction.meta?.loadedAddresses as
        | {
            writable?: Array<string | { pubkey?: string }>;
            readonly?: Array<string | { pubkey?: string }>;
          }
        | undefined;
      const accountKeys = [
        ...arrayValues(message?.accountKeys),
        ...arrayValues(loadedAddresses?.writable),
        ...arrayValues(loadedAddresses?.readonly)
      ].map(accountAddress);
      return transactionInstructionCandidates(event).flatMap(
        ({ instruction, instructionIndex, innerInstructionIndex }) => {
          const instructionProgramId =
            typeof instruction.programId === "string"
              ? instruction.programId
              : typeof instruction.programIdIndex === "number"
                ? accountKeys[instruction.programIdIndex]
                : undefined;
          if (
            instructionProgramId !== options.programId ||
            typeof instruction.data !== "string" ||
            !Array.isArray(instruction.accounts)
          ) {
            return [];
          }
          let data: Uint8Array;
          try {
            data = bs58.decode(instruction.data);
          } catch {
            return [];
          }
          const definition = definitions.find(
            (candidate) =>
              candidate.discriminator.length > 0 &&
              data.length >= candidate.discriminator.length &&
              candidate.discriminator.every((byte, index) => data[index] === byte)
          );
          if (!definition) return [];
          const accounts = instruction.accounts.map((account) =>
            typeof account === "number" ? accountKeys[account] : accountAddress(account)
          );
          const poolAddress = accounts[definition.poolAccountIndex];
          const tokenPair = definition.tokenPairAccountIndexes
            ? resolveReviewedTokenPair(
                accounts,
                definition.tokenPairAccountIndexes,
                definition.quoteTokenAddresses ?? []
              )
            : undefined;
          const baseTokenAddress = tokenPair?.baseTokenAddress ??
            (definition.baseTokenAccountIndex === undefined
              ? undefined
              : accounts[definition.baseTokenAccountIndex]);
          const quoteTokenAddress = tokenPair?.quoteTokenAddress ??
            (definition.quoteTokenAccountIndex === undefined
              ? undefined
              : accounts[definition.quoteTokenAccountIndex]);
          const creatorAddress =
            definition.creatorDataEncoding === "pump-borsh-after-3-strings"
              ? decodePumpCreatorAddress(data, definition.discriminator.length)
              : definition.creatorAccountIndex === undefined
                ? undefined
                : accounts[definition.creatorAccountIndex];
          if (!poolAddress || !baseTokenAddress) return [];
          return [
            {
              signature: event.signature,
              slot: event.slot,
              observedAt: event.observedAt,
              programId: options.programId,
              poolAddress,
              baseTokenAddress,
              ...(quoteTokenAddress ? { quoteTokenAddress } : {}),
              ...(creatorAddress ? { creatorAddress } : {}),
              createdAt: chainOccurredAt(event),
              instructionIndex,
              ...(innerInstructionIndex !== undefined ? { innerInstructionIndex } : {}),
              raw: {
                decoder: definition.name,
                discriminatorHex: definition.discriminatorHex,
                instructionIndex,
                ...(creatorAddress
                  ? {
                      creatorAddress,
                      creatorSource:
                        definition.creatorDataEncoding === "pump-borsh-after-3-strings"
                          ? "pump-create-instruction-data"
                          : "pool-create-instruction-account"
                    }
                  : {}),
                ...(tokenPair ? { tokenPairOrientation: "reviewed-quote-mint" } : {}),
                ...(innerInstructionIndex !== undefined ? { innerInstructionIndex } : {}),
                instruction
              }
            }
          ];
        }
      );
    }
  };
}

function resolveReviewedTokenPair(
  accounts: Array<string | undefined>,
  indexes: [number, number],
  quoteTokenAddresses: string[]
): { baseTokenAddress: string; quoteTokenAddress: string } | undefined {
  const left = accounts[indexes[0]];
  const right = accounts[indexes[1]];
  if (!left || !right || left === right) return undefined;
  const reviewedQuotes = new Set(quoteTokenAddresses);
  const leftIsQuote = reviewedQuotes.has(left);
  const rightIsQuote = reviewedQuotes.has(right);
  if (leftIsQuote === rightIsQuote) return undefined;
  return leftIsQuote
    ? { baseTokenAddress: right, quoteTokenAddress: left }
    : { baseTokenAddress: left, quoteTokenAddress: right };
}

/**
 * Pump create/create_v2 encode name, symbol and URI as Borsh strings followed
 * by the creator pubkey. Bounds are checked at every step; malformed data
 * returns no provenance instead of guessing an account role.
 */
export function decodePumpCreatorAddress(
  data: Uint8Array,
  discriminatorLength = 8
): string | undefined {
  let offset = discriminatorLength;
  for (let field = 0; field < 3; field += 1) {
    if (offset + 4 > data.length) return undefined;
    const length =
      data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24);
    if (length < 0 || length > 10_000 || offset + 4 + length > data.length) return undefined;
    offset += 4 + length;
  }
  if (offset + 32 > data.length) return undefined;
  const creator = data.slice(offset, offset + 32);
  if (creator.every((byte) => byte === 0)) return undefined;
  return bs58.encode(creator);
}

interface InstructionCandidate {
  instruction: Record<string, unknown>;
  instructionIndex: number;
  innerInstructionIndex?: number;
}

function transactionInstructionCandidates(event: SolanaChainEvent): InstructionCandidate[] {
  const message = event.transaction.transaction?.message as
    | { instructions?: Array<Record<string, unknown>> }
    | undefined;
  const candidates: InstructionCandidate[] = recordArray(message?.instructions).map(
    (instruction, instructionIndex) => ({ instruction, instructionIndex })
  );
  const meta = event.transaction.meta as
    | {
        innerInstructions?: Array<{
          index?: number;
          instructions?: Array<Record<string, unknown>>;
        }>;
      }
    | null
    | undefined;
  for (const group of recordArray(meta?.innerInstructions)) {
    if (
      typeof group.index !== "number" ||
      !Number.isSafeInteger(group.index) ||
      group.index < 0
    ) {
      continue;
    }
    for (const [innerInstructionIndex, instruction] of recordArray(group.instructions).entries()) {
      candidates.push({
        instruction,
        instructionIndex: group.index,
        innerInstructionIndex
      });
    }
  }
  return candidates;
}

function accountAddress(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "pubkey" in value) {
    const pubkey = (value as { pubkey?: unknown }).pubkey;
    return typeof pubkey === "string" ? pubkey : "";
  }
  return "";
}

function arrayValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return arrayValues(value).filter(
    (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object"
  );
}

function stringField(
  value: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string") return value[key];
  }
  return undefined;
}

function chainOccurredAt(event: SolanaChainEvent): string {
  return event.transaction.blockTime
    ? new Date(event.transaction.blockTime * 1_000).toISOString()
    : event.observedAt;
}

export function activePoolSampleDelayMs(ageMinutes: number): number | null {
  if (ageMinutes < 0) return 30_000;
  if (ageMinutes < 40) return 30_000;
  if (ageMinutes <= 120) return 120_000;
  return null;
}

export interface ActivePoolState {
  poolAddress: string;
  createdAt: string;
  lastSampledAt?: string;
}

export function dueActivePools(states: ActivePoolState[], now: string): ActivePoolState[] {
  const nowMs = new Date(now).getTime();
  return states.filter((state) => {
    const ageMinutes = (nowMs - new Date(state.createdAt).getTime()) / 60_000;
    const delay = activePoolSampleDelayMs(ageMinutes);
    if (delay === null) return false;
    if (!state.lastSampledAt) return true;
    return nowMs - new Date(state.lastSampledAt).getTime() >= delay;
  });
}
