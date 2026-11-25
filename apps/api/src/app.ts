import { Hono } from "hono";
import type { AppDeps } from "./deps";
import type { AppEnv } from "./env";
import { ApiError, errorBody, sendError } from "./lib/errors";
import { apiIpLimit, sessionLoader } from "./middleware/auth";
import { corsMiddleware, noStore, originGuard, securityHeaders } from "./middleware/security";
import { adminRoutes } from "./routes/admin";
import { agentRoutes } from "./routes/agents";
import { authRoutes } from "./routes/auth";
import { chatRoutes } from "./routes/chat";
import { healthRoutes } from "./routes/health";
import { meRoutes } from "./routes/me";
import { taskRoutes } from "./routes/tasks";

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
  app.route("/api/health", healthRoutes); // monitoring: not rate limited, no session needed
  app.use("/api/*", apiIpLimit);
  app.use("/api/*", sessionLoader);

  app.route("/api/auth", authRoutes);
  app.route("/api/me", meRoutes);
  app.route("/api/chat", chatRoutes);
  app.route("/api/agents", agentRoutes);
  app.route("/api/tasks", taskRoutes);
  app.route("/api/admin", adminRoutes);

  app.notFound((c) => c.json(errorBody("not_found"), 404));
  app.onError((err, c) => {
    if (err instanceof ApiError) return sendError(c, err);
    console.error("unhandled error", err);
    return c.json(errorBody("internal"), 500);
  });
  return app;
}
