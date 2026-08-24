import type { RawPoolInstructionDefinition } from "./pool-discovery";

export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const REVIEWED_QUOTE_MINTS = [WRAPPED_SOL_MINT, USDC_MINT];

export interface ReviewedSolanaVenueProgram {
  venue:
    | "meteora-dbc"
    | "meteora-damm-v2"
    | "meteora-dlmm"
    | "orca-whirlpool"
    | "raydium-clmm";
  programId: string;
  sourceRepository: string;
  sourceCommit: string;
  instructions: RawPoolInstructionDefinition[];
}

/**
 * Account indexes and Anchor discriminators are pinned to the named official
 * SDK commits. Token A/B venues fail closed unless exactly one mint is a
 * reviewed quote asset; canonical sorting is never mistaken for trade side.
 */
export const REVIEWED_SOLANA_VENUE_PROGRAMS: ReviewedSolanaVenueProgram[] = [
  {
    venue: "raydium-clmm",
    programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    sourceRepository: "raydium-io/raydium-idl",
    sourceCommit: "e7e0c96fe77bcf6a020b84a44c47a722aac8e359",
    instructions: [
      tokenPairInstruction("clmm-create-pool", "e992d18ecf6840bc", 2, 3, 4, 0)
    ]
  },
  {
    venue: "meteora-dbc",
    programId: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
    sourceRepository: "MeteoraAg/dynamic-bonding-curve-sdk",
    sourceCommit: "44420de8e735c334b4864762f38368822b0c48f9",
    instructions: [
      dbcInstruction("dbc-initialize-virtual-pool-with-spl-token", "8c55d7b06636684f"),
      dbcInstruction("dbc-initialize-virtual-pool-with-token2022", "a976334e916edc9b"),
      dbcInstruction(
        "dbc-initialize-virtual-pool-with-token2022-transfer-hook",
        "b60de9b12a918702"
      )
    ]
  },
  {
    venue: "meteora-damm-v2",
    programId: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
    sourceRepository: "MeteoraAg/damm-v2-sdk",
    sourceCommit: "7849506ff92477a387fb2ee7a4bfcff84ed3f182",
    instructions: [
      tokenPairInstruction("damm-initialize-customizable-pool", "14a1f118bdddb402", 5, 7, 8, 0),
      tokenPairInstruction("damm-initialize-pool", "5fb40aac54aee828", 6, 8, 9, 0),
      tokenPairInstruction(
        "damm-initialize-pool-with-dynamic-config",
        "955248c5fdfc440f",
        7,
        9,
        10,
        0
      )
    ]
  },
  {
    venue: "meteora-dlmm",
    programId: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    sourceRepository: "MeteoraAg/dlmm-sdk",
    sourceCommit: "fb02e51ae677bbd18e76543f702dae40632426db",
    instructions: [
      tokenPairInstruction(
        "dlmm-initialize-customizable-permissionless-lb-pair",
        "2e2729876fb7c840",
        0,
        2,
        3,
        8
      ),
      tokenPairInstruction(
        "dlmm-initialize-customizable-permissionless-lb-pair2",
        "f349817e3313f16b",
        0,
        2,
        3,
        8
      ),
      tokenPairInstruction("dlmm-initialize-lb-pair", "2d9aedd2dd0fa65c", 0, 2, 3, 8),
      tokenPairInstruction("dlmm-initialize-lb-pair2", "493b2478ed536cc6", 0, 2, 3, 8),
      tokenPairInstruction(
        "dlmm-initialize-permission-lb-pair",
        "6c66d555fb033515",
        1,
        3,
        4,
        8
      )
    ]
  },
  {
    venue: "orca-whirlpool",
    programId: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    sourceRepository: "orca-so/whirlpools",
    sourceCommit: "630c0e01b74ad88eab69f8ed4cc2d3dc9a3d0bd5",
    instructions: [
      tokenPairInstruction("orca-initialize-pool", "5fb40aac54aee828", 4, 1, 2, 3),
      tokenPairInstruction("orca-initialize-pool-v2", "cf2d57f21b3fcc43", 6, 1, 2, 5),
      tokenPairInstruction(
        "orca-initialize-pool-with-adaptive-fee",
        "8f5e604cac7c77c7",
        7,
        1,
        2,
        5
      )
    ]
  }
];

function dbcInstruction(name: string, discriminatorHex: string): RawPoolInstructionDefinition {
  return {
    name,
    discriminatorHex,
    poolAccountIndex: 5,
    baseTokenAccountIndex: 3,
    quoteTokenAccountIndex: 4,
    creatorAccountIndex: 2
  };
}

function tokenPairInstruction(
  name: string,
  discriminatorHex: string,
  poolAccountIndex: number,
  tokenAIndex: number,
  tokenBIndex: number,
  creatorAccountIndex: number
): RawPoolInstructionDefinition {
  return {
    name,
    discriminatorHex,
    poolAccountIndex,
    tokenPairAccountIndexes: [tokenAIndex, tokenBIndex],
    quoteTokenAddresses: REVIEWED_QUOTE_MINTS,
    creatorAccountIndex
  };
}
