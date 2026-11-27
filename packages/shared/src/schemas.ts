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

export const TASK_TYPES = ["echo", "ai.prompt", "cortex.run"] as const;
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

/** Upper bound on a Cortex goal — every plan step re-sends it to the model, so it bounds neuron cost. */
export const CORTEX_GOAL_MAX_CHARS = 2000;
export const CONTENT_KINDS = ["article", "post", "ad"] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];
export const cortexRunSchema = z.object({
  goal: z.string().trim().min(2).max(CORTEX_GOAL_MAX_CHARS),
  /** Optional per-tool inputs (e.g. {"web.fetch": {"url": "https://..."}}). */
  tool_inputs: z.record(z.string().max(80), z.record(z.string(), z.unknown())).optional(),
});
export type CortexRunInput = z.infer<typeof cortexRunSchema>;

export const contentDraftSchema = z.object({
  kind: z.enum(CONTENT_KINDS),
  topic: z.string().trim().min(2).max(500),
  audience: z.string().trim().max(200).optional(),
  tone: z.enum(["formal", "friendly"]).default("friendly"),
});
export type ContentDraftInput = z.infer<typeof contentDraftSchema>;

export const INDUSTRIES = [
  "fashion", "food", "restaurant", "electronics", "beauty", "education", "home", "travel",
  "health", "kids", "jewelry", "books", "services", "general",
] as const;
export const businessProfileSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9_-]{1,64}$/).default("default"),
  name: z.string().trim().min(1).max(80),
  industry: z.enum(INDUSTRIES).default("general"),
  city: z.string().trim().max(80).optional(),
  tone: z.enum(["formal", "friendly"]).optional(),
  maxDiscountPercent: z.number().int().min(0).max(90).optional(),
  allowDiscounts: z.boolean().optional(),
  websiteUrl: z.string().url().max(300).refine((u) => u.startsWith("https://"), { message: "فقط آدرس https" }).optional(),
  brandColors: z.object({ primary: z.string().regex(/^#[0-9a-fA-F]{6}$/), secondary: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).optional(),
});
export type BusinessProfileInput = z.infer<typeof businessProfileSchema>;

export const campaignDraftSchema = z.object({
  /** Built-in or custom event id (e.g. "yalda"); the next occurrence within 366 days is used. */
  event_id: z.string().trim().regex(/^[a-z0-9_-]{1,64}$/),
  business: businessProfileSchema,
  use_llm: z.boolean().default(false),
});
export const campaignDecisionSchema = z.object({ note: z.string().trim().max(500).optional() });

export const autopilotJobSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9_.:-]{1,64}$/).optional(),
  name: z.string().trim().min(1).max(120),
  cron: z.string().trim().min(1).max(100),
  handler: z.literal("autopilot.scan_events"),
  payload: z
    .object({ horizonDays: z.number().int().min(1).max(60).default(14), business: businessProfileSchema, useLlm: z.boolean().default(false) })
    .optional(),
  utc_offset_minutes: z.number().int().min(-720).max(840).default(210),
  paused: z.boolean().default(false),
});
export const autopilotJobActionSchema = z.object({ action: z.enum(["pause", "resume", "run_now", "delete"]) });

// ---------- Phase 4: chat parity with the old Space ----------
export const conversationCreateSchema = z.object({ title: z.string().trim().min(1).max(120).optional(), project_id: z.string().trim().min(1).max(64).optional() });
export const conversationRenameSchema = z.object({ title: z.string().trim().min(1).max(120) });
export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  /** Ground the answer on Persian Wikipedia when the message looks like a factual question. */
  search: z.boolean().default(false),
  /** «تفکر عمیق»: more careful, longer answer (bigger token budget). */
  deep: z.boolean().default(false),
  /** Model picker id (see GET /api/models); "auto" = strongest available with fallback. */
  model: z.string().trim().max(40).optional(),
  /** Files/images uploaded with POST /api/attachments, attached to this message. */
  attachment_ids: z.array(z.string().trim().min(1).max(64)).max(4).default([]),
});
export const regenerateSchema = z.object({ search: z.boolean().default(false), deep: z.boolean().default(false), model: z.string().trim().max(40).optional() });
/** PATCH /api/conversations/:id — any subset of title / pinned / project. */
export const conversationPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    pinned: z.boolean().optional(),
    project_id: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .refine((v) => v.title !== undefined || v.pinned !== undefined || v.project_id !== undefined, { message: "empty patch" });
export const projectSchema = z.object({ name: z.string().trim().min(1).max(80), instructions: z.string().trim().max(2000).default("") });
export const projectPatchSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), instructions: z.string().trim().max(2000).optional() });
export const memorySchema = z.object({ content: z.string().trim().min(2).max(500) });
export const attachmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), name: z.string().trim().min(1).max(200), mime: z.string().trim().max(100), text: z.string().min(1).max(120_000) }),
  z.object({
    kind: z.literal("image"),
    name: z.string().trim().min(1).max(200),
    mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
    /** base64 without the data: prefix; ≤ ~400 KB decoded (the browser downscales first). */
    data: z.string().min(16).max(560_000).regex(/^[A-Za-z0-9+/=]+$/),
  }),
]);
/** Saves turns answered by the in-browser offline model (wllama) into the server history. */
export const appendMessagesSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(8000) }))
    .min(1)
    .max(2),
  engine: z.enum(["local"]).default("local"),
});
export const shareSchema = z.object({ enabled: z.boolean() });
export const feedbackSchema = z.object({ rating: z.union([z.literal(-1), z.literal(0), z.literal(1)]) });
export const ANSWER_STYLES = ["balanced", "short", "detailed"] as const;
export const THEMES = ["light", "dark", "system"] as const;
export const prefsSchema = z.object({
  name: z.string().trim().max(40).optional(),
  style: z.enum(ANSWER_STYLES).optional(),
  about: z.string().trim().max(300).optional(),
  theme: z.enum(THEMES).optional(),
  autoPreview: z.boolean().optional(),
  /** Use saved memories in answers (default on). */
  memory: z.boolean().optional(),
  /** Default model picker id. */
  model: z.string().trim().max(40).optional(),
});
export type Prefs = z.infer<typeof prefsSchema>;
export const IMAGE_SIZE_NAMES = ["square", "wide", "tall", "landscape", "portrait"] as const;
export const imageRequestSchema = z.object({
  prompt: z.string().trim().min(2).max(1000),
  size: z.enum(IMAGE_SIZE_NAMES).default("square"),
  conversation_id: z.string().trim().min(1).max(64).optional(),
  /** 1-4 variations (seed, seed+1, …). */
  n: z.number().int().min(1).max(4).default(1),
  /** hq = FLUX.2 [dev] first (slower, uses 2 units). */
  quality: z.enum(["standard", "hq"]).default("standard"),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  /** Rewrite the request into a rich English prompt with the text model (default on). */
  enhance: z.boolean().default(true),
  /** Things to avoid (sent as negative_prompt where the model supports it, else folded into the prompt). */
  negative: z.string().trim().max(300).optional(),
});
export const supportCreateSchema = z.object({ body: z.string().trim().min(2).max(2000) });
export const supportReplySchema = z.object({ reply: z.string().trim().min(1).max(2000), close: z.boolean().default(false) });
export const announcementCreateSchema = z.object({ body: z.string().trim().min(2).max(500) });
export const announcementToggleSchema = z.object({ active: z.boolean() });
export const truncateSchema = z.object({ from_message_id: z.string().trim().min(1).max(64) });
export const CODE_PURPOSES = ["verify", "login", "reset"] as const;
export const sendCodeSchema = z.object({ email: emailSchema, purpose: z.enum(CODE_PURPOSES) });
export const codeSchema = z.string().trim().regex(/^[0-9۰-۹]{6}$/, { message: "کد باید ۶ رقم باشد." });
export const verifyCodeSchema = z.object({ email: emailSchema, code: codeSchema });
export const resetPasswordSchema = z.object({ email: emailSchema, code: codeSchema, password: passwordSchema });
