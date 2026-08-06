import bs58 from "bs58";
import type { RawPoolInstructionDefinition } from "./pool-discovery";
import type { SolanaChainEvent } from "./solana-event-source";
import type { RawBuyInstructionDefinition } from "./wallet-buy";

export const RAYDIUM_IDL_COMMIT = "e7e0c96fe77bcf6a020b84a44c47a722aac8e359";
export const RAYDIUM_LAUNCHLAB_PROGRAM_ID =
  "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
export const RAYDIUM_CPMM_PROGRAM_ID =
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";

/** Exact account order and discriminators from the pinned official IDLs. */
export const RAYDIUM_PINNED_MANIFEST = {
  idlCommit: RAYDIUM_IDL_COMMIT,
  launchLab: {
    programId: RAYDIUM_LAUNCHLAB_PROGRAM_ID,
    idlPath: "raydium_launchpad/raydium_launchpad.json",
    instructions: {
      initialize: instruction(
        "afaf6d1f0d989bed",
        "payer", "creator", "global_config", "platform_config", "authority",
        "pool_state", "base_mint", "quote_mint", "base_vault", "quote_vault",
        "metadata_account", "base_token_program", "quote_token_program",
        "metadata_program", "system_program", "rent_program", "event_authority", "program"
      ),
      initialize_v2: instruction(
        "4399af27da102620",
        "payer", "creator", "global_config", "platform_config", "authority",
        "pool_state", "base_mint", "quote_mint", "base_vault", "quote_vault",
        "metadata_account", "base_token_program", "quote_token_program",
        "metadata_program", "system_program", "rent_program", "event_authority", "program"
      ),
      initialize_with_token_2022: instruction(
        "25be7ede2c9aab11",
        "payer", "creator", "global_config", "platform_config", "authority",
        "pool_state", "base_mint", "quote_mint", "base_vault", "quote_vault",
        "base_token_program", "quote_token_program", "system_program", "event_authority", "program"
      ),
      migrate_to_cpswap: instruction(
        "885cc8671cda908c",
        "payer", "base_mint", "quote_mint", "platform_config", "cpswap_program",
        "cpswap_pool", "cpswap_authority", "cpswap_lp_mint", "cpswap_base_vault",
        "cpswap_quote_vault", "cpswap_config", "cpswap_create_pool_fee",
        "cpswap_observation", "lock_program", "lock_authority", "lock_lp_vault",
        "authority", "pool_state", "global_config", "base_vault", "quote_vault",
        "pool_lp_token", "base_token_program", "quote_token_program",
        "associated_token_program", "system_program", "rent_program", "metadata_program"
      ),
      buy_exact_in: launchTradeInstruction("faea0d7bd59c13ec"),
      buy_exact_out: launchTradeInstruction("18d3742869039938"),
      sell_exact_in: launchTradeInstruction("9527de9bd37c981a"),
      sell_exact_out: launchTradeInstruction("5fc8472208090ba6")
    }
  },
  cpmm: {
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    idlPath: "raydium_cpmm/raydium_cp_swap.json",
    instructions: {
      initialize: instruction(
        "afaf6d1f0d989bed",
        "creator", "amm_config", "authority", "pool_state", "token_0_mint",
        "token_1_mint", "lp_mint", "creator_token_0", "creator_token_1",
        "creator_lp_token", "token_0_vault", "token_1_vault", "create_pool_fee",
        "observation_state", "token_program", "token_0_program", "token_1_program",
        "associated_token_program", "system_program", "rent"
      ),
      initialize_with_permission: instruction(
        "3f37fe4131b25979",
        "payer", "creator", "amm_config", "authority", "pool_state", "token_0_mint",
        "token_1_mint", "lp_mint", "payer_token_0", "payer_token_1", "payer_lp_token",
        "token_0_vault", "token_1_vault", "create_pool_fee", "observation_state",
        "permission", "token_program", "token_0_program", "token_1_program",
        "associated_token_program", "system_program"
      ),
      swap_base_input: cpmmSwapInstruction("8fbe5adac41e33de"),
      swap_base_output: cpmmSwapInstruction("37d96256a34ab4ad")
    }
  }
} as const;

export const RAYDIUM_LAUNCHLAB_POOL_INSTRUCTIONS: RawPoolInstructionDefinition[] = [
  {
    name: "raydium-launchlab-initialize",
    discriminatorHex: RAYDIUM_PINNED_MANIFEST.launchLab.instructions.initialize.discriminatorHex,
    poolAccountIndex: 5,
    baseTokenAccountIndex: 6,
    quoteTokenAccountIndex: 7
  },
  {
    name: "raydium-launchlab-initialize-v2",
    discriminatorHex: RAYDIUM_PINNED_MANIFEST.launchLab.instructions.initialize_v2.discriminatorHex,
    poolAccountIndex: 5,
    baseTokenAccountIndex: 6,
    quoteTokenAccountIndex: 7
  },
  {
    name: "raydium-launchlab-initialize-token-2022",
    discriminatorHex:
      RAYDIUM_PINNED_MANIFEST.launchLab.instructions.initialize_with_token_2022.discriminatorHex,
    poolAccountIndex: 5,
    baseTokenAccountIndex: 6,
    quoteTokenAccountIndex: 7
  },
  {
    name: "raydium-launchlab-migrate-cpmm",
    discriminatorHex:
      RAYDIUM_PINNED_MANIFEST.launchLab.instructions.migrate_to_cpswap.discriminatorHex,
    poolAccountIndex: 5,
    baseTokenAccountIndex: 1,
    quoteTokenAccountIndex: 2
  }
];

export const RAYDIUM_CPMM_POOL_INSTRUCTIONS: RawPoolInstructionDefinition[] = [
  {
    name: "raydium-cpmm-initialize",
    discriminatorHex: RAYDIUM_PINNED_MANIFEST.cpmm.instructions.initialize.discriminatorHex,
    poolAccountIndex: 3,
    baseTokenAccountIndex: 4,
    quoteTokenAccountIndex: 5
  },
  {
    name: "raydium-cpmm-initialize-with-permission",
    discriminatorHex:
      RAYDIUM_PINNED_MANIFEST.cpmm.instructions.initialize_with_permission.discriminatorHex,
    poolAccountIndex: 4,
    baseTokenAccountIndex: 5,
    quoteTokenAccountIndex: 6
  }
];

export const RAYDIUM_LAUNCHLAB_BUY_DEFINITIONS: RawBuyInstructionDefinition[] = [
  {
    name: "raydium-launchlab-buy-exact-in",
    programId: RAYDIUM_LAUNCHLAB_PROGRAM_ID,
    discriminatorHex: RAYDIUM_PINNED_MANIFEST.launchLab.instructions.buy_exact_in.discriminatorHex,
    poolAccountIndex: 4,
    traderAccountIndex: 0,
    outputTokenAccountIndex: 9,
    inputTokenAccountIndex: 10
  },
  {
    name: "raydium-launchlab-buy-exact-out",
    programId: RAYDIUM_LAUNCHLAB_PROGRAM_ID,
    discriminatorHex: RAYDIUM_PINNED_MANIFEST.launchLab.instructions.buy_exact_out.discriminatorHex,
    poolAccountIndex: 4,
    traderAccountIndex: 0,
    outputTokenAccountIndex: 9,
    inputTokenAccountIndex: 10
  }
];

export type RaydiumTradeSide = "buy" | "sell" | "swap";

export interface RaydiumTradeInstructionDefinition {
  name: string;
  programId: string;
  discriminatorHex: string;
  side: RaydiumTradeSide;
  traderAccountIndex: number;
  poolAccountIndex: number;
  inputMintAccountIndex: number;
  outputMintAccountIndex: number;
  infrastructureAccountIndices: number[];
}

export const RAYDIUM_TRADE_INSTRUCTIONS: RaydiumTradeInstructionDefinition[] = [
  launchDefinition("raydium-launchlab-buy-exact-in", "buy", "buy_exact_in"),
  launchDefinition("raydium-launchlab-buy-exact-out", "buy", "buy_exact_out"),
  launchDefinition("raydium-launchlab-sell-exact-in", "sell", "sell_exact_in"),
  launchDefinition("raydium-launchlab-sell-exact-out", "sell", "sell_exact_out"),
  cpmmDefinition("raydium-cpmm-swap-base-input", "swap_base_input"),
  cpmmDefinition("raydium-cpmm-swap-base-output", "swap_base_output")
];

export interface RaydiumTradeInstructionMatch {
  idempotencyKey: string;
  signature: string;
  slot: number;
  transactionIndex?: number;
  instructionIndex: number;
  innerInstructionIndex?: number;
  decoderVersion: string;
  programId: string;
  name: string;
  side: RaydiumTradeSide;
  poolAddress: string;
  traderAddress: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  verifiedUserAuthorityAddresses: string[];
  infrastructureAddresses: string[];
  raw: Record<string, unknown>;
}

export function decodeRaydiumTradeInstructions(
  event: SolanaChainEvent,
  definitions: RaydiumTradeInstructionDefinition[] = RAYDIUM_TRADE_INSTRUCTIONS
): RaydiumTradeInstructionMatch[] {
  const message = event.transaction.transaction?.message as
    | {
        header?: { numRequiredSignatures?: number };
        accountKeys?: Array<string | { pubkey?: string; signer?: boolean }>;
        instructions?: Array<Record<string, unknown>>;
      }
    | undefined;
  const accountKeys = (message?.accountKeys ?? []).map((account) =>
    typeof account === "string" ? account : account.pubkey ?? ""
  );
  const signers = messageSigners(message);
  const meta = event.transaction.meta as
    | {
        innerInstructions?: Array<{
          index?: number;
          instructions?: Array<Record<string, unknown>>;
        }>;
      }
    | undefined;
  const candidates: Array<{
    instruction: Record<string, unknown>;
    instructionIndex: number;
    innerInstructionIndex?: number;
  }> = (message?.instructions ?? []).map((instruction, instructionIndex) => ({
    instruction,
    instructionIndex
  }));
  for (const group of meta?.innerInstructions ?? []) {
    if (!Number.isSafeInteger(group.index)) continue;
    (group.instructions ?? []).forEach((instruction, innerInstructionIndex) => {
      candidates.push({
        instruction,
        instructionIndex: group.index!,
        innerInstructionIndex
      });
    });
  }

  return candidates.flatMap(({ instruction: rawInstruction, instructionIndex, innerInstructionIndex }) => {
    const programId = instructionProgramId(rawInstruction, accountKeys);
    if (!programId || typeof rawInstruction.data !== "string" || !Array.isArray(rawInstruction.accounts)) {
      return [];
    }
    let data: Uint8Array;
    try {
      data = bs58.decode(rawInstruction.data);
    } catch {
      return [];
    }
    const definition = definitions.find((candidate) =>
      candidate.programId === programId && startsWithHex(data, candidate.discriminatorHex)
    );
    if (!definition) return [];
    const accounts = rawInstruction.accounts.map((account) =>
      typeof account === "number"
        ? accountKeys[account] ?? ""
        : typeof account === "string"
          ? account
          : ""
    );
    const traderAddress = accounts[definition.traderAccountIndex];
    const poolAddress = accounts[definition.poolAccountIndex];
    const inputTokenAddress = accounts[definition.inputMintAccountIndex];
    const outputTokenAddress = accounts[definition.outputMintAccountIndex];
    if (
      !traderAddress ||
      !poolAddress ||
      !inputTokenAddress ||
      !outputTokenAddress ||
      !signers.has(traderAddress)
    ) {
      return [];
    }
    const decoderVersion = `raydium-idl:${RAYDIUM_IDL_COMMIT}`;
    const idempotencyKey = [
      "raydium-trade",
      event.signature,
      event.transactionIndex ?? "transaction-index-unknown",
      instructionIndex,
      innerInstructionIndex ?? "top-level",
      traderAddress,
      inputTokenAddress,
      outputTokenAddress,
      decoderVersion
    ].join(":");
    const infrastructureAddresses = definition.infrastructureAccountIndices
      .map((index) => accounts[index])
      .filter((address): address is string => Boolean(address && address !== traderAddress));
    return [{
      idempotencyKey,
      signature: event.signature,
      slot: event.slot,
      ...(event.transactionIndex !== undefined
        ? { transactionIndex: event.transactionIndex }
        : {}),
      instructionIndex,
      ...(innerInstructionIndex !== undefined ? { innerInstructionIndex } : {}),
      decoderVersion,
      programId,
      name: definition.name,
      side: definition.side,
      poolAddress,
      traderAddress,
      inputTokenAddress,
      outputTokenAddress,
      verifiedUserAuthorityAddresses: [traderAddress],
      infrastructureAddresses,
      raw: {
        idlCommit: RAYDIUM_IDL_COMMIT,
        discriminatorHex: definition.discriminatorHex,
        instruction: rawInstruction
      }
    } satisfies RaydiumTradeInstructionMatch];
  });
}

function instruction(discriminatorHex: string, ...accounts: string[]) {
  return { discriminatorHex, accounts };
}

function launchTradeInstruction(discriminatorHex: string) {
  return instruction(
    discriminatorHex,
    "payer", "authority", "global_config", "platform_config", "pool_state",
    "user_base_token", "user_quote_token", "base_vault", "quote_vault",
    "base_token_mint", "quote_token_mint", "base_token_program", "quote_token_program",
    "event_authority", "program"
  );
}

function cpmmSwapInstruction(discriminatorHex: string) {
  return instruction(
    discriminatorHex,
    "payer", "authority", "amm_config", "pool_state", "input_token_account",
    "output_token_account", "input_vault", "output_vault", "input_token_program",
    "output_token_program", "input_token_mint", "output_token_mint", "observation_state"
  );
}

function launchDefinition(
  name: string,
  side: "buy" | "sell",
  instructionName: "buy_exact_in" | "buy_exact_out" | "sell_exact_in" | "sell_exact_out"
): RaydiumTradeInstructionDefinition {
  const inputMintAccountIndex = side === "buy" ? 10 : 9;
  const outputMintAccountIndex = side === "buy" ? 9 : 10;
  return {
    name,
    programId: RAYDIUM_LAUNCHLAB_PROGRAM_ID,
    discriminatorHex:
      RAYDIUM_PINNED_MANIFEST.launchLab.instructions[instructionName].discriminatorHex,
    side,
    traderAccountIndex: 0,
    poolAccountIndex: 4,
    inputMintAccountIndex,
    outputMintAccountIndex,
    infrastructureAccountIndices: [1, 2, 3, 4, 7, 8, 11, 12, 13, 14]
  };
}

function cpmmDefinition(
  name: string,
  instructionName: "swap_base_input" | "swap_base_output"
): RaydiumTradeInstructionDefinition {
  return {
    name,
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    discriminatorHex: RAYDIUM_PINNED_MANIFEST.cpmm.instructions[instructionName].discriminatorHex,
    side: "swap",
    traderAccountIndex: 0,
    poolAccountIndex: 3,
    inputMintAccountIndex: 10,
    outputMintAccountIndex: 11,
    infrastructureAccountIndices: [1, 2, 3, 6, 7, 8, 9, 12]
  };
}

function messageSigners(message: {
  header?: { numRequiredSignatures?: number };
  accountKeys?: Array<string | { pubkey?: string; signer?: boolean }>;
} | undefined): Set<string> {
  const signers = new Set<string>();
  const required = message?.header?.numRequiredSignatures;
  (message?.accountKeys ?? []).forEach((account, index) => {
    const address = typeof account === "string" ? account : account.pubkey;
    if (!address) return;
    if (
      (typeof account !== "string" && account.signer === true) ||
      (Number.isSafeInteger(required) && index < (required ?? 0)) ||
      (required === undefined && index === 0)
    ) {
      signers.add(address);
    }
  });
  return signers;
}

function instructionProgramId(
  instruction: Record<string, unknown>,
  accountKeys: string[]
): string | undefined {
  if (typeof instruction.programId === "string") return instruction.programId;
  return typeof instruction.programIdIndex === "number"
    ? accountKeys[instruction.programIdIndex]
    : undefined;
}

function startsWithHex(data: Uint8Array, discriminatorHex: string): boolean {
  const discriminator = Buffer.from(discriminatorHex, "hex");
  return discriminator.length > 0 && data.length >= discriminator.length &&
    discriminator.every((byte, index) => data[index] === byte);
}
