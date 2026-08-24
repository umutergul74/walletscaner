export interface DiscoveryBackfillProfile {
  initialLimit: number;
  pageLimit: number;
  maxPages: number;
  maximumReconnectSignatures: number;
}

const MAXIMUM_DISCOVERY_BACKFILL_SIGNATURES = 2_000;

function strictInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

/**
 * Discovery reconnect repair scans signatures first and only fetches transactions
 * after it proves the durable cursor is inside the bounded window. The default
 * 500-signature window covers the measured LaunchLab reconnect gaps while the
 * hard 2,000-signature ceiling prevents an operator typo from turning program
 * history into an unbounded RPC/CPU job on the shared host.
 */
export function discoveryBackfillProfile(
  env: Record<string, string | undefined> = process.env
): DiscoveryBackfillProfile {
  const initialLimit = strictInteger(
    env.SOLANA_DISCOVERY_INITIAL_BACKFILL_LIMIT,
    100,
    1,
    1_000,
    "SOLANA_DISCOVERY_INITIAL_BACKFILL_LIMIT"
  );
  const pageLimit = strictInteger(
    env.SOLANA_DISCOVERY_BACKFILL_PAGE_LIMIT,
    100,
    1,
    1_000,
    "SOLANA_DISCOVERY_BACKFILL_PAGE_LIMIT"
  );
  const maxPages = strictInteger(
    env.SOLANA_DISCOVERY_MAX_BACKFILL_PAGES,
    5,
    1,
    10,
    "SOLANA_DISCOVERY_MAX_BACKFILL_PAGES"
  );
  const maximumReconnectSignatures = pageLimit * maxPages;
  if (maximumReconnectSignatures > MAXIMUM_DISCOVERY_BACKFILL_SIGNATURES) {
    throw new Error(
      `Discovery reconnect backfill is capped at ${MAXIMUM_DISCOVERY_BACKFILL_SIGNATURES} signatures; ` +
        `received ${pageLimit} x ${maxPages} = ${maximumReconnectSignatures}.`
    );
  }
  return { initialLimit, pageLimit, maxPages, maximumReconnectSignatures };
}
