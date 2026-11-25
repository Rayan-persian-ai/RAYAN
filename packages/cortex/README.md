# RAYAN CORTEX — `@rayan/cortex`

هستهٔ هماهنگ‌سازی عامل‌های هوشمند رایان: فارسی‌محور، بدون وابستگی زمان اجرا (zero runtime dependencies)، سازگار با **Cloudflare Workers** (فقط Web APIها: `fetch`/`crypto.subtle`/`AbortController`/`structuredClone` — بدون هیچ API مخصوص Node).

```
request ──► PromptGuard ──► IntentEngine ──► TaskPlanner (DAG) ──► AgentRouter
                                                              │
   report ◄── EvaluationEngine ◄── ExecutionEngine ◄──────────┘
                                      │  ToolRegistry ─► PermissionManager ─► CostController
                                      │  ModelRouter (free-only, fallback)
                                      └► EventBus ─► AuditLogger (hash-chained)   MemoryManager (per-user)
```

## نصب و اجرا

```bash
npm install
npm test          # vitest
npm run typecheck # src با lib=WebWorker و بدون @types/node + تست‌ها
npm run build     # خروجی ESM در dist/
```

## شروع سریع (Worker)

```ts
import { createCortex, AgentRegistry, ToolRegistry, PermissionManager, CostController,
         ModelRouter, MemoryManager, D1MemoryAdapter, D1QuotaStore, AuditLogger, D1AuditStore, s } from '@rayan/cortex';

export default {
  async fetch(req: Request, env: { DB: D1Database; AI: Ai }) {
    const cost = new CostController({ 'workers-ai': { daily: 9000 } }, { store: new D1QuotaStore(env.DB), resetOffsetMinutes: 210 });
    const permissions = new PermissionManager();
    const agents = new AgentRegistry();
    agents.load(MANIFESTS); // آرایه یا NDJSON (loadJson)
    const tools = new ToolRegistry({ permissions, cost });
    tools.register({ name: 'web.search', description: 'جستجو', input: s.object({ query: s.string().min(1) }),
                     permissions: ['net:read'], risk: 'low', handler: async ({ query }) => search(query) });
    const models = new ModelRouter({ cost }).register({ id: '@cf/meta/llama-3.1-8b-instruct', provider: 'workers-ai',
                     free: true, quotaService: 'workers-ai', capabilities: { persian: 0.6, reasoning: 0.6, speed: 0.8 } });
    const llm = async ({ system, prompt, model }) =>
      (await env.AI.run(model ?? '@cf/meta/llama-3.1-8b-instruct', { messages: [{ role: 'system', content: system ?? '' }, { role: 'user', content: prompt }] })).response;

    const cortex = createCortex({ agents, tools, permissions, cost, models, llm,
      memory: new MemoryManager(new D1MemoryAdapter(env.DB)), audit: new AuditLogger(new D1AuditStore(env.DB)) });
    const { text } = await req.json<{ text: string }>();
    const report = await cortex.handle({ text, expectedLanguage: 'fa' }, { userId: 'u1', sessionId: 's1', roles: ['owner'] }, { signal: req.signal });
    return Response.json(report);
  },
};
```

> نکته: در Workers، نمونه‌سازی هر درخواست ارزان است، ولی رجیستری ۱۰۰هزار عاملی را در سطح ماژول (global scope) بسازید تا بین درخواست‌ها در همان isolate بازاستفاده شود. `PermissionManager` و آمار `AgentRouter`/`ModelRouter` در حافظهٔ isolate هستند (بخش محدودیت‌ها).

## ماژول‌ها (شناسه‌ها انگلیسی)

| ماژول | کار | نکات کلیدی |
|---|---|---|
| `IntentEngine` | دسته‌بندی درخواست فارسی/انگلیسی به `chat, code, research, content, image, automation, admin, analysis` | `llm` تزریقی با timeout؛ هر خطا/خروجی نامعتبر/اطمینان پایین → fallback قطعی کلیدواژه‌ای. نرمال‌سازی ی/ک عربی، ارقام فارسی، نیم‌فاصله |
| `TaskPlanner` + `validatePlan` | هدف → DAG از `PlanStep {id, agentSlug, toolNames, dependsOn, capability}` | قالب برای هر intent، شکستن اهداف ترکیبی («… و سپس …»، «then»)، برنامهٔ LLM اعتبارسنجی و در صورت خطا fallback؛ بررسی چرخه (Kahn)، سقف `maxSteps/maxDepth/maxSegments` |
| `AgentRegistry` + `AgentRouter` | بارگذاری manifest (`slug, name_fa, capabilities, allowedTools, permissions, enabled`) و انتخاب بهترین عامل فعال | ایندکس `capability→slugs` و `tool→slugs`، wildcard دامنه (`research.*`)، شروع از کوچک‌ترین مجموعه، `maxScan`؛ امتیاز = تخصص + قابلیت اطمینان (Laplace) + priority. عامل = داده، نه process |
| `ToolRegistry` | ثبت ابزار با اسکیما + برچسب مجوز | ترتیب کنترل: وجود → allow-list عامل → برچسب‌های مجوز → اعتبارسنجی ورودی → سطح خودمختاری → سهمیه → اجرا با timeout → پاک‌سازی خروجی غیرقابل‌اعتماد. بدون PermissionManager فقط ابزار low-risk (fail-closed) |
| `s` (validator) | اعتبارسنج کوچک شبیه zod | `string/number/boolean/enum/literal/array/object/record/any`, `optional/default/refine/strict` |
| `PermissionManager` | سه سطح `automatic / guarded / restricted` | سخت‌گیرانه‌ترین سطح از (risk، سطح ابزار، کف عامل، override) برنده است؛ override فقط سخت‌تر می‌کند. guarded/restricted ⇒ `ApprovalRequest`. تأیید = مجوز **یک‌بارمصرف** و وابسته به اثرانگشت دقیق (user+agent+tool+input)، با انقضا؛ restricted فقط با نقش `owner` |
| `CostController` | سهمیهٔ روزانه برای هر سرویس | `QuotaStore` تزریقی (`InMemoryQuotaStore`, `D1QuotaStore` با UPSERT…RETURNING)؛ رزرو و rollback ⇒ عبور از سقف ممکن نیست؛ سرویس ناشناخته = رد (بودجه صفر)؛ ریست روزانه با offset (مثلاً +۲۱۰ دقیقه تهران) |
| `ModelRouter` | انتخاب مدل بر اساس `persian/coding/reasoning/speed/...` | پیش‌فرض فقط مدل‌های رایگان؛ ثبت موفقیت/تأخیر (EWMA)/خطا؛ circuit breaker با cooldown نمایی؛ رد مدل‌های بی‌سهمیه؛ `run()` با fallback به مدل رایگان بعدی |
| `MemoryManager` | حافظه با scopeهای `short-term, long-term, user, project, agent` | فقط از طریق `forUser(ctx)` — userId ثابت در handle؛ هر کوئری SQL با `user_id = ?`؛ short-term به sessionId و TTL، project به projectId، agent به agentSlug بسته است. آداپتورها: `InMemoryMemoryAdapter`, `D1MemoryAdapter` (+ `MEMORY_SQL`) |
| `ExecutionEngine` | اجرای plan | زمان‌بند DAG با `maxConcurrency`، retry محدود (سقف سخت ۵) با backoff، timeout مرحله و کل plan، لغو با `AbortSignal`، بودجهٔ کل تلاش‌ها (ضد حلقهٔ بی‌نهایت)، رد plan چرخه‌ای، `failFast`، رویدادها |
| `EvaluationEngine` | امتیازدهی خروجی | بررسی‌ها: خالی‌نبودن، طول، زبان (نسبت فارسی)، JSON، کلیدواژه‌های لازم، نشت کلید/توکن، تکرار؛ داور LLM اختیاری (خروجی به‌عنوان untrusted پیچیده می‌شود) |
| `EventBus` / `AuditLogger` | رویداد و ممیزی | wildcard (`step.*`, `*`)، جداسازی خطای handler؛ لاگ append-only با زنجیرهٔ SHA-256، redact کلیدهای حساس، `verify()`؛ `D1AuditStore` با trigger ضد UPDATE/DELETE |
| `PromptGuard` | محافظ prompt injection | محتوای ابزار/وب = داده. قواعد انگلیسی و فارسی (نادیده گرفتن دستورات، تغییر نقش، افشای prompt، ارتقای مجوز، توکن‌های ChatML، exfil تصویری)، حذف کاراکترهای پنهان (نیم‌فاصله حفظ می‌شود)، `wrap()` در `<untrusted_data>`. هیچ مسیری از محتوا به مجوز وجود ندارد |
| `Cortex` / `createCortex` | `handle(request, userCtx)` | guard → intent → plan → route → execute → evaluate → حافظهٔ کوتاه‌مدت → `CortexReport`؛ `approve()/reject()` |

## API عمومی (خلاصه)

```ts
createCortex(opts?): Cortex
cortex.handle({ text, toolInputs?, expectedLanguage? }, { userId, projectId?, sessionId?, roles?, locale? }, { signal? })
  → { requestId, status: 'completed'|'partial'|'awaiting_approval'|'failed'|'cancelled', intent, plan, execution,
      evaluation, output, approvals, guardFlags, errors, durationMs }
cortex.approve(approvalId, approverCtx) / cortex.reject(...)

new IntentEngine({ llm?, llmTimeoutMs?, minLlmConfidence?, keywords? }).classify(text) | .classifyByKeywords(text)
new TaskPlanner({ llm?, limits?, classifySegment?, templates? }).plan(goal, intent) ; validatePlan(steps, limits)
new AgentRegistry().upsert(m) | .load(iter) | .loadJson(text) | .remove | .setEnabled | .get
new AgentRouter(registry, { maxScan? }).pick({ capability, toolNames?, preferredSlug?, exclude? }) | .recordOutcome
new ToolRegistry({ permissions?, cost?, guard?, bus?, audit? }).register(def) | .execute(name, input, ctx) | .canUse
new PermissionManager(policy?, clock?).decide(user, agent, action) | .approve | .reject | .pending | .levelFor
new CostController(quotas, { store?, resetOffsetMinutes?, allowUnknown? }).consume | .canSpend | .status | .refund | .report
new ModelRouter({ cost?, freeOnly?, breakerThreshold?, cooldownMs? }).register | .rank | .choose | .run | .record
new MemoryManager(adapter?, opts?).forUser(ctx) → put | get | list | delete | search | forgetEverything
new ExecutionEngine(bus?, defaults?).run(plan, executor, { user, signal? }, options?)
new EvaluationEngine({ judge?, judgeWeight?, passThreshold?, extraChecks? }).evaluate(input)
new EventBus().on | once | emit | emitAsync ; new AuditLogger(store?).log | attach | list | verify
new PromptGuard().inspect | untrusted | wrap ; PromptGuard.SYSTEM_NOTICE
```

## پایگاه داده (D1)

`sql/schema.sql` شامل جدول‌های `cortex_memory`، `cortex_audit` (append-only با trigger)، `cortex_tasks`، `cortex_task_steps`، `cortex_approvals` و `cortex_quota_usage` است:

```bash
wrangler d1 execute <DB_NAME> --file=./sql/schema.sql
```

تست‌ها همین SQL را واقعاً روی SQLite (از طریق `node:sqlite` و یک shim سازگار با D1 فقط در `test/helpers`) اجرا می‌کنند.

## محدودیت‌ها (صادقانه)

- **وضعیت in-isolate:** درخواست‌های تأیید (`PermissionManager`)، آمار قابلیت اطمینان عامل‌ها و سلامت مدل‌ها در حافظه‌اند و بین isolateهای Workers مشترک نیستند. جدول `cortex_approvals` در schema آماده است ولی آداپتور D1 آن هنوز نوشته نشده؛ برای تولید، approvals را در D1 یا Durable Object نگه دارید.
- جدول‌های `cortex_tasks`/`cortex_task_steps` تعریف شده‌اند اما Cortex خودش در آن‌ها نمی‌نویسد (از رویدادهای `plan.*`/`step.*` برای ذخیره استفاده کنید).
- دسته‌بندی کلیدواژه‌ای ابتکاری است: تطبیق زیررشته‌ای فارسی ممکن است مثبت کاذب بدهد (مثلاً «کد» درون کلمات دیگر). برای دقت بالا LLM را تزریق کنید.
- `PromptGuard` مبتنی بر regex است و دفاع لایه‌ای محسوب می‌شود، نه تضمین کامل؛ امنیت واقعی از این می‌آید که مجوزها فقط از manifest و policy خوانده می‌شوند.
- جستجوی حافظه کلیدواژه‌ای (`LIKE`) است، نه معنایی؛ برای جستجوی برداری Vectorize را اضافه کنید. متن ذخیره‌شده در D1 نرمال‌سازی نمی‌شود (فقط عبارت جستجو).
- مسیریابی ۱۰۰هزار manifest در حافظه انجام می‌شود (بارگذاری ~۰٫۵ ثانیه در Node در تست)؛ در Workers محدودیت ۱۲۸MB حافظه و زمان CPU شروع سرد را در نظر بگیرید — برای مقیاس بالاتر، ایندکس را در D1/KV نگه دارید و فقط shard لازم را بارگذاری کنید.
- اعتبارسنج داخلی زیرمجموعهٔ کوچکی از zod است (بدون union/transform).
- اجرای مرحله‌ای پیش‌فرض، ورودی ابزار را از `request.toolInputs[toolName]` یا `{ query: goal }` می‌سازد؛ برای ابزارهای پیچیده `stepExecutor` سفارشی بدهید.
