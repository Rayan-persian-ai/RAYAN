import { Hono } from "hono";
import { chatRequestSchema } from "@rayan/shared";
import type { AppEnv } from "../env";
import { guardedChat } from "../lib/ai-guard";
import { parseJson } from "../lib/request";
import { chatUserLimit, requirePermission } from "../middleware/auth";

export const chatRoutes = new Hono<AppEnv>();

chatRoutes.post("/", requirePermission("chat:use"), chatUserLimit, async (c) => {
  const { messages } = await parseJson(c, chatRequestSchema);
  const out = await guardedChat(c.env, c.var.deps, messages);
  return c.json(out);
});
