import bs58 from "bs58";
import type { SolanaChainEvent } from "./solana-event-source";

export interface PoolDiscovery {
  signature: string;
  slot: number;
  observedAt: string;
  programId: string;
  poolAddress: string;
  baseTokenAddress: string;
  quoteTokenAddress?: string;
  createdAt: string;
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
      const message = event.transaction.transaction?.message as
        | { instructions?: Array<Record<string, unknown>> }
        | undefined;
      return (message?.instructions ?? []).flatMap((instruction) => {
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
            raw: instruction
          }
        ];
      });
    }
  };
}

export interface RawPoolInstructionDefinition {
  name: string;
  discriminatorHex: string;
  poolAccountIndex: number;
  baseTokenAccountIndex: number;
  quoteTokenAccountIndex?: number;
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
            instructions?: Array<Record<string, unknown>>;
          }
        | undefined;
      const accountKeys = (message?.accountKeys ?? []).map((account) =>
        typeof account === "string" ? account : account.pubkey ?? ""
      );
      return (message?.instructions ?? []).flatMap((instruction) => {
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
        const data = bs58.decode(instruction.data);
        const definition = definitions.find(
          (candidate) =>
            candidate.discriminator.length > 0 &&
            data.length >= candidate.discriminator.length &&
            candidate.discriminator.every((byte, index) => data[index] === byte)
        );
        if (!definition) return [];
        const accounts = instruction.accounts.map((account) =>
          typeof account === "number"
            ? accountKeys[account]
            : typeof account === "string"
              ? account
              : ""
        );
        const poolAddress = accounts[definition.poolAccountIndex];
        const baseTokenAddress = accounts[definition.baseTokenAccountIndex];
        const quoteTokenAddress =
          definition.quoteTokenAccountIndex === undefined
            ? undefined
            : accounts[definition.quoteTokenAccountIndex];
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
            createdAt: chainOccurredAt(event),
            raw: {
              decoder: definition.name,
              discriminatorHex: definition.discriminatorHex,
              instruction
            }
          }
        ];
      });
    }
  };
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
