import { applyD1Migrations, env } from "cloudflare:test";

// Applies migrations/0001..000N to the local test D1 (idempotent; tracked in d1_migrations).
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
