import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

// Tests run inside workerd (Miniflare) with a real local D1. The AI binding is NOT bound:
// tests inject a mock AiProvider through createApp(deps), so nothing ever calls a remote/paid service.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(migrationsDir);
  return {
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        miniflare: {
          compatibilityDate: "2025-11-01",
          d1Databases: ["DB"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            OWNER_EMAIL: "owner@rayan.test",
            ALLOWED_ORIGINS: "https://app.rayan.test",
            ENVIRONMENT: "test",
            AI_DAILY_LIMIT: "3",
            RATE_LIMIT_API_PER_MIN: "1000",
            RATE_LIMIT_AUTH_PER_MIN: "1000",
            RATE_LIMIT_LOGIN_PER_EMAIL_15MIN: "1000",
            RATE_LIMIT_CHAT_PER_MIN: "1000",
            PBKDF2_ITERATIONS: "100000",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      // Files share one local D1; run them sequentially so cron tests can reset() safely.
      fileParallelism: false,
    },
  };
});
