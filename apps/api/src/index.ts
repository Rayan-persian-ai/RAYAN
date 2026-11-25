import { createApp } from "./app";
import { defaultTaskHandlers } from "./cron/handlers";
import { runScheduled } from "./cron/scheduled";
import type { AppDeps } from "./deps";
import type { Env } from "./env";
import { workersAiProvider } from "./lib/ai";

export const productionDeps: AppDeps = {
  ai: workersAiProvider,
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
