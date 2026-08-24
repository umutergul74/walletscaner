import pg from "pg";

export default async function setup(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) return;

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    // PostgreSQL extensions are database-wide, while integration fixtures use
    // isolated schemas in parallel. Installing pgcrypto once in public keeps
    // migration 001 idempotent and makes digest() visible to every fixture.
    await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
  } finally {
    await pool.end();
  }
}
