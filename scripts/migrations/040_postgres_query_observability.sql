SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- The library is preloaded by docker-compose.server.yml before this migration
-- is used in production. The extension stores aggregate query fingerprints;
-- it does not change application data or enable statement logging by itself.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
