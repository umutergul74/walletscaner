import bs58 from "bs58";
import type { SolanaChainEvent } from "./solana-event-source";

export interface RawBuyInstructionDefinition {
  name: string;
  programId: string;
  discriminatorHex: string;
  poolAccountIndex: number;
  outputTokenAccountIndex: number;
  traderAccountIndex: number;
  inputTokenAccountIndex?: number;
  staticInputTokenAddress?: string;
}

export interface WalletBuyDiscovery {
  signature: string;
  slot: number;
  observedAt: string;
  programId: string;
  poolAddress: string;
  traderAddress: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  raw: Record<string, unknown>;
}

export function decodeWalletBuys(
  event: SolanaChainEvent,
  definitions: RawBuyInstructionDefinition[]
): WalletBuyDiscovery[] {
  const message = event.transaction.transaction?.message as
    | {
        accountKeys?: Array<string | { pubkey?: string }>;
        instructions?: Array<Record<string, unknown>>;
      }
    | undefined;
  const accountKeys = (message?.accountKeys ?? []).map((account) =>
    typeof account === "string" ? account : account.pubkey ?? ""
  );
  const compiledDefinitions = definitions.map((definition) => ({
    ...definition,
    discriminator: Buffer.from(
      definition.discriminatorHex.replace(/^0x/i, ""),
      "hex"
    )
  }));
  const buys = (message?.instructions ?? []).flatMap((instruction) => {
    const programId =
      typeof instruction.programId === "string"
        ? instruction.programId
        : typeof instruction.programIdIndex === "number"
          ? accountKeys[instruction.programIdIndex]
          : undefined;
    if (
      !programId ||
      typeof instruction.data !== "string" ||
      !Array.isArray(instruction.accounts)
    ) {
      return [];
    }
    const data = bs58.decode(instruction.data);
    const definition = compiledDefinitions.find(
      (candidate) =>
        candidate.programId === programId &&
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
    const outputTokenAddress = accounts[definition.outputTokenAccountIndex];
    const traderAddress = accounts[definition.traderAccountIndex];
    const inputTokenAddress =
      definition.staticInputTokenAddress ??
      (definition.inputTokenAccountIndex === undefined
        ? undefined
        : accounts[definition.inputTokenAccountIndex]);
    if (!poolAddress || !outputTokenAddress || !traderAddress || !inputTokenAddress) {
      return [];
    }
    return [
      {
        signature: event.signature,
        slot: event.slot,
        observedAt: event.observedAt,
        programId,
        poolAddress,
        traderAddress,
        inputTokenAddress,
        outputTokenAddress,
        raw: {
          decoder: definition.name,
          discriminatorHex: definition.discriminatorHex,
          instruction
        }
      }
    ];
  });

  const seen = new Set<string>();
  return buys.filter((buy) => {
    const key = [
      buy.signature,
      buy.poolAddress,
      buy.traderAddress,
      buy.outputTokenAddress
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
