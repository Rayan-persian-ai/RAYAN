import { createApp } from "./app";
import { defaultTaskHandlers } from "./cron/handlers";
import { runScheduled } from "./cron/scheduled";
import type { AppDeps } from "./deps";
import type { Env } from "./env";
import { createChainProvider } from "./lib/ai-chain";

export const productionDeps: AppDeps = {
  // Workers AI (binding, D1-capped) -> Pollinations -> keyed providers whose secrets exist.
  ai: createChainProvider(),
  taskHandlers: defaultTaskHandlers,
  now: () => Date.now(),
};

const app = createApp(productionDeps);

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(env, productionDeps, controller.cron));
  },
} satisfies ExportedHandler<Env>;
