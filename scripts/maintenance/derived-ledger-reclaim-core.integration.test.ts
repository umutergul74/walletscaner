import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reclaimDerivedLedgerCache } from "./derived-ledger-reclaim-core.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const schema = `derived_reclaim_${process.pid}`;
let pool: pg.Pool;

describeDatabase("derived ledger reclaim core", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`
      CREATE TABLE ${schema}.wallet_trade_events (id integer PRIMARY KEY);
      CREATE TABLE ${schema}.wallet_position_episodes (id integer PRIMARY KEY);
      CREATE TABLE ${schema}.wallet_position_lots (id integer PRIMARY KEY);
      CREATE TABLE ${schema}.wallet_alpha_scores (
        strategy_version text NOT NULL,
        chain text NOT NULL,
        wallet_address text NOT NULL,
        calculated_at timestamptz NOT NULL,
        status text NOT NULL
      );
      CREATE INDEX wallet_alpha_scores_latest ON ${schema}.wallet_alpha_scores
        (strategy_version, chain, wallet_address, calculated_at DESC);
      CREATE TABLE ${schema}.wallet_alpha_work_queue (
        strategy_version text NOT NULL,
        chain text NOT NULL,
        wallet_address text NOT NULL,
        revision integer NOT NULL,
        not_before timestamptz NOT NULL,
        locked_by text,
        locked_at timestamptz,
        lock_expires_at timestamptz,
        last_error text,
        PRIMARY KEY (strategy_version, chain, wallet_address)
      );
    `);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  it("reclaims only derived rows and requeues current observed wallets", async () => {
    await resetFixture();
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schema}`);
      const result = await reclaimDerivedLedgerCache(client);
      expect(result).toMatchObject({
        tradeSourcePresent: true,
        qualifiedWallets: 0,
        requeuedObservedWallets: 1,
      });
    } finally {
      client.release();
    }

    const state = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM ${schema}.wallet_trade_events)::integer AS trades,
        (SELECT COUNT(*) FROM ${schema}.wallet_position_episodes)::integer AS episodes,
        (SELECT COUNT(*) FROM ${schema}.wallet_position_lots)::integer AS lots,
        (SELECT revision FROM ${schema}.wallet_alpha_work_queue)::integer AS revision,
        (SELECT last_error FROM ${schema}.wallet_alpha_work_queue) AS last_error
    `);
    expect(state.rows[0]).toEqual({
      trades: 1,
      episodes: 0,
      lots: 0,
      revision: 2,
      last_error: null,
    });
  });

  it("rolls back without deleting derived rows when a current wallet is qualified", async () => {
    await resetFixture();
    await pool.query(`
      INSERT INTO ${schema}.wallet_alpha_scores VALUES
        ('evidence-v1','solana','wallet-1',NOW() + interval '1 minute','watch')
    `);
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schema}`);
      await expect(reclaimDerivedLedgerCache(client)).rejects.toThrow(
        "Qualified wallets exist"
      );
    } finally {
      client.release();
    }
    const state = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM ${schema}.wallet_position_episodes)::integer AS episodes,
        (SELECT COUNT(*) FROM ${schema}.wallet_position_lots)::integer AS lots,
        (SELECT revision FROM ${schema}.wallet_alpha_work_queue)::integer AS revision
    `);
    expect(state.rows[0]).toEqual({ episodes: 1, lots: 1, revision: 1 });
  });
});

async function resetFixture(): Promise<void> {
  await pool.query(`
    TRUNCATE ${schema}.wallet_trade_events, ${schema}.wallet_position_episodes,
      ${schema}.wallet_position_lots, ${schema}.wallet_alpha_scores,
      ${schema}.wallet_alpha_work_queue;
    INSERT INTO ${schema}.wallet_trade_events VALUES (1);
    INSERT INTO ${schema}.wallet_position_episodes VALUES (1);
    INSERT INTO ${schema}.wallet_position_lots VALUES (1);
    INSERT INTO ${schema}.wallet_alpha_scores VALUES
      ('evidence-v1','solana','wallet-1',NOW() - interval '2 minutes','watch'),
      ('evidence-v1','solana','wallet-1',NOW() - interval '1 minute','observed');
    INSERT INTO ${schema}.wallet_alpha_work_queue VALUES
      ('evidence-v1','solana','wallet-1',1,NOW() + interval '1 hour',
       'worker',NOW(),NOW() + interval '1 hour','old error');
  `);
}
