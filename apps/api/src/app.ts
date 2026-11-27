import { Hono } from "hono";
import type { AppDeps } from "./deps";
import type { AppEnv } from "./env";
import { ApiError, errorBody, sendError } from "./lib/errors";
import { apiIpLimit, sessionLoader } from "./middleware/auth";
import { corsMiddleware, noStore, originGuard, securityHeaders } from "./middleware/security";
import { adminRoutes } from "./routes/admin";
import { agentRoutes } from "./routes/agents";
import { authRoutes } from "./routes/auth";
import { autopilotRoutes } from "./routes/autopilot";
import { chatRoutes } from "./routes/chat";
import { conversationRoutes, messageRoutes } from "./routes/conversations";
import { emailAuthRoutes } from "./routes/email-auth";
import { gmailAdminRoutes, googleRoutes } from "./routes/google";
import { withGoogleCreds } from "./lib/google-creds";
import { provisionRoutes } from "./routes/provision";
import { imageRoutes } from "./routes/images";
import { shareRoutes } from "./routes/share";
import { adminSupportRoutes, announcementRoutes, supportRoutes } from "./routes/support";
import { cortexRoutes } from "./routes/cortex";
import { healthRoutes } from "./routes/health";
import { meRoutes } from "./routes/me";
import { taskRoutes } from "./routes/tasks";
import { agentBotRoutes } from "./routes/agent-bots";
import { adminDashRoutes } from "./routes/admin-dash";
import { attachmentRoutes, memoryRoutes, modelRoutes, projectRoutes } from "./routes/parity";
import { geminiKey } from "./lib/gemini";

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("auth", null);
    await next();
  });
  app.use("*", securityHeaders);
  app.use("/api/*", corsMiddleware);
  app.use("/api/*", noStore);
  app.use("/api/*", originGuard);
  app.use("/api/*", async (c, next) => {
    c.env = await withGoogleCreds(c.env);
    // free Gemini key (encrypted in D1) → env, so the non-streaming chain (@rayan/ai-router) can use it too
    if (!c.env.GEMINI_API_KEY) {
      const k = await geminiKey(c.env).catch(() => null);
      if (k) c.env = { ...c.env, GEMINI_API_KEY: k };
    }
    await next();
  });
  app.route("/api/health", healthRoutes); // monitoring: not rate limited, no session needed
  app.use("/api/*", apiIpLimit);
  app.use("/api/*", sessionLoader);

  app.route("/api/auth", authRoutes);
  app.route("/api/auth", emailAuthRoutes);
  app.route("/api/auth/google", googleRoutes);
  app.route("/api/admin/gmail", gmailAdminRoutes);
  app.route("/api/admin/provision", provisionRoutes);
  app.route("/api/me", meRoutes);
  app.route("/api/chat", chatRoutes);
  app.route("/api/agents", agentRoutes);
  app.route("/api/tasks", taskRoutes);
  app.route("/api/conversations", conversationRoutes);
  app.route("/api/messages", messageRoutes);
  app.route("/api/images", imageRoutes);
  app.route("/api/share", shareRoutes);
  app.route("/api/support", supportRoutes);
  app.route("/api/announcements", announcementRoutes);
  app.route("/api/models", modelRoutes);
  app.route("/api/projects", projectRoutes);
  app.route("/api/memories", memoryRoutes);
  app.route("/api/attachments", attachmentRoutes);
  app.route("/api/admin", adminDashRoutes);
  app.route("/api/admin", agentBotRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/api/admin", adminSupportRoutes);
  app.route("/api/cortex", cortexRoutes);
  app.route("/api/autopilot", autopilotRoutes);

  app.notFound((c) => c.json(errorBody("not_found"), 404));
  app.onError((err, c) => {
    if (err instanceof ApiError) return sendError(c, err);
    console.error("unhandled error", err);
    return c.json(errorBody("internal"), 500);
  });
  return app;
}
