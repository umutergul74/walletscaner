import pg from "pg";

export default async function setup(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) return;

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    // PostgreSQL extensions are database-wide, while integration fixtures use
    // isolated schemas in parallel. Install every extension used by migrations
    // once before file workers start; concurrent CREATE EXTENSION IF NOT EXISTS
    // commands can otherwise race on pg_extension_name_index.
    await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public");
  } finally {
    await pool.end();
  }
}
