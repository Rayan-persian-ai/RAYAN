import type { D1Migration } from "cloudflare:test";
import type { Env as RayanEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends RayanEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
export {};
