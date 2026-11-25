/**
 * Example Cloudflare Worker wiring RAYAN AUTOPILOT to a Cron Trigger.
 *
 * wrangler.toml:
 *   [triggers]
 *   crons = ["* * * * *"]          # tick every minute; job crons decide what actually runs
 *   [[d1_databases]]
 *   binding = "DB"
 *   database_name = "rayan"
 *   database_id = "<id>"
 *
 * Nothing here publishes or sends: the daily job only creates DRAFTS (status
 * "pending_approval") that an admin approves in the panel.
 */
import {
  CampaignPlanner,
  D1CampaignStore,
  D1SchedulerStore,
  EventCalendar,
  Scheduler,
  type BusinessProfile,
  type D1DatabaseLike,
  type LlmFn,
} from "../src/index.js";

export interface Env {
  DB: D1DatabaseLike;
  /** Optional Workers AI binding; when absent the planner uses deterministic templates. */
  AI?: { run(model: string, input: unknown): Promise<{ response?: string }> };
}

interface ScheduledControllerLike {
  scheduledTime: number;
  cron: string;
}
interface ExecutionContextLike {
  waitUntil(p: Promise<unknown>): void;
}

function makeLlm(env: Env): LlmFn | undefined {
  if (!env.AI) return undefined;
  const ai = env.AI;
  return async ({ system, prompt, maxTokens }) => {
    const out = await ai.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens ?? 700,
    });
    return out.response ?? "";
  };
}

export function buildScheduler(env: Env): Scheduler {
  const calendar = new EventCalendar();
  const llm = makeLlm(env);
  const planner = new CampaignPlanner(llm ? { llm } : {});
  const campaigns = new D1CampaignStore(env.DB);
  return new Scheduler({
    store: new D1SchedulerStore(env.DB),
    defaultUtcOffsetMinutes: 210, // Asia/Tehran
    handlers: {
      // payload: { business: BusinessProfile, horizonDays: number }
      "campaigns.draft_upcoming": async ({ payload, now }) => {
        const { business, horizonDays } = payload as { business: BusinessProfile; horizonDays: number };
        const created: string[] = [];
        for (const ev of calendar.upcoming(now, horizonDays)) {
          const draft = await planner.plan(ev, business, { now });
          if (draft.relevance.recommendation === "skip") continue;
          if (await campaigns.get(draft.id)) continue; // idempotent: one draft per event instance
          await campaigns.save(draft);
          created.push(draft.id);
        }
        return { created };
      },
    },
  });
}

export default {
  async scheduled(controller: ScheduledControllerLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
    const scheduler = buildScheduler(env);
    ctx.waitUntil(scheduler.tick(new Date(controller.scheduledTime)));
  },
};
