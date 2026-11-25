import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .email({ message: "ایمیل معتبر نیست." });

export const passwordSchema = z
  .string()
  .min(10, { message: "رمز عبور باید حداقل ۱۰ کاراکتر باشد." })
  .max(128, { message: "رمز عبور حداکثر ۱۲۸ کاراکتر است." });

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  display_name: z.string().trim().min(1).max(80).optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(4000),
});
/** Upper bound on total characters per chat request — keeps each Workers AI call's neuron cost bounded (see README). */
export const CHAT_MAX_TOTAL_CHARS = 6000;
export const chatRequestSchema = z.object({
  messages: z
    .array(chatMessageSchema)
    .min(1)
    .max(20)
    .refine((m) => m.reduce((n, x) => n + x.content.length, 0) <= CHAT_MAX_TOTAL_CHARS, {
      message: "طول کل گفت‌وگو بیش از حد مجاز است؛ یک گفت‌وگوی تازه شروع کنید.",
    })
    .refine((m) => m.at(-1)?.role === "user", { message: "آخرین پیام باید از طرف کاربر باشد." }),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const TASK_TYPES = ["echo", "ai.prompt"] as const;
export const taskCreateSchema = z.object({
  type: z.string().trim().min(1).max(64).regex(/^[a-z0-9._-]+$/),
  payload: z.record(z.string(), z.unknown()).default({}),
  agent_slug: z.string().trim().max(64).optional(),
  max_attempts: z.number().int().min(1).max(5).default(3),
});
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

export const TASK_STATUSES = ["pending", "running", "succeeded", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const agentToggleSchema = z.object({ enabled: z.boolean() });
export const roleChangeSchema = z.object({
  role: z.enum(["admin", "member"]),
  action: z.enum(["grant", "revoke"]),
});
export const usageLimitSchema = z.object({ limit: z.number().int().min(0).max(1_000_000) });
export const featureFlagSchema = z.object({ enabled: z.boolean() });
