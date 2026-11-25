<div dir="rtl">

# رایان (RAYAN) — سکوی هوش مصنوعی فارسی

**فاز ۱: زیرساخت (Foundation)** + **فاز ۲: اتصال هستهٔ عامل‌ها (Cortex) و اتوپایلوت (Autopilot) به محصول** — یک مونوریپوی کامل و آزموده‌شده روی لایهٔ رایگان Cloudflare با هزینهٔ صفر.

- رابط کاربری فارسی و راست‌به‌چپ (`lang="fa"`, `dir="rtl"`) با قلم وزیرمتن
- API روی Cloudflare Workers با Hono و پایگاه دادهٔ D1 (SQLite)
- احراز هویت امن (PBKDF2 + کوکی نشست HttpOnly)، کنترل دسترسی نقش‌محور (RBAC)، محدودیت نرخ، گزارش ممیزی
- کنترل‌گر هزینه (Cost Controller) با سقف روزانه برای Workers AI
- رجیستری ۲۰ عامل هوشمند، صف وظایف و زمان‌بند Cron هر ۱۵ دقیقه
- **فاز ۲:** `@rayan/cortex` (هدف → نیت → برنامهٔ DAG → عامل‌های رجیستری → اجرا با تأیید انسانی) و `@rayan/autopilot` (تقویم مناسبت‌های ایرانی به وقت تهران، پیش‌نویس کمپین با بنر SVG راست‌به‌چپ، دروازهٔ تأیید، زمان‌بند D1) در API و وب

> هیچ سرویس پولی، هیچ ارتقای خودکار و هیچ رازی (secret) در کد وجود ندارد.

---

## ۱. معماری

```
 مرورگر (RTL, Vazirmatn)
        │  https://<project>.pages.dev
        ▼
 ┌──────────────────────────────┐        Service Binding (API)        ┌──────────────────────────────────┐
 │ Cloudflare Pages  (apps/web) │ ───── functions/api/[[path]].ts ───▶ │ Cloudflare Worker  (apps/api)     │
 │ Vite + vanilla TS            │        /api/*  (هم‌مبدأ، بدون CORS)   │ Hono · zod · RBAC · rate limit    │
 └──────────────────────────────┘                                      │ Cost Controller · audit log       │
                                                                       │ scheduled(): هر ۱۵ دقیقه           │
                                                                       └──────┬───────────────┬────────────┘
                                                                              │               │
                                                                        D1 (SQLite)     Workers AI (env.AI)
                                                                   users, sessions, …   @cf/meta/llama-3.1-8b-instruct
```

- **چرا پروکسی Pages Function؟** کوکی نشست با پیشوند `__Host-` و `SameSite=Lax` فقط وقتی قابل اعتماد است که وب و API هم‌مبدأ باشند. تابع Pages درخواست‌های `/api/*` را از طریق Service Binding (رایگان و بدون عبور از اینترنت) به Worker می‌فرستد.
- **packages/shared**: کاتالوگ نقش‌ها و مجوزها، طرح‌واره‌های zod، پیام‌های خطای فارسی و مانیفست‌های JSON عامل‌ها؛ بین API و وب مشترک است.

### ساختار پوشه‌ها

```
rayan/
├─ package.json                 npm workspaces: packages/{shared,cortex,autopilot}, apps/{api,web}
├─ .github/workflows/
│  ├─ ci.yml                    install → typecheck → test → build
│  └─ deploy.yml                فقط وقتی CLOUDFLARE_API_TOKEN و CLOUDFLARE_ACCOUNT_ID وجود دارند
├─ packages/shared/
│  ├─ src/                      rbac.ts · schemas.ts · agents.ts · messages.ts
│  ├─ agents/*.json             ۲۰ مانیفست عامل (نام فارسی + مجوزهای محدود)
│  └─ test/
├─ apps/api/
│  ├─ wrangler.toml             پیکربندی تولید (D1 + AI + Cron)
│  ├─ wrangler.dev.toml         توسعهٔ محلی آفلاین (بدون AI، بدون نیاز به حساب Cloudflare)
│  ├─ .dev.vars.example
│  ├─ migrations/               0001_init · 0002_seed_rbac · 0003_seed_agents (تولیدشده) · 0004_cortex_autopilot · 0005_seed_phase2
│  ├─ scripts/gen-agents-sql.mjs
│  ├─ src/
│  │  ├─ app.ts                 createApp(deps) — تزریق وابستگی (AI و هندلرهای وظیفه قابل mock)
│  │  ├─ index.ts               fetch + scheduled
│  │  ├─ middleware/            auth (RBAC, rate limit) · security (headers, CORS, origin guard)
│  │  ├─ routes/                auth · me · chat · agents · tasks · admin · health · cortex · autopilot
│  │  ├─ lib/                   crypto · session · cost · ai · ratelimit · audit · bootstrap · …
│  │  └─ cron/                  processor · scheduled · handlers
│  └─ test/                     auth · rbac · ratelimit · cost · tasks · cron · cortex · autopilot
└─ apps/web/
   ├─ index.html                lang="fa" dir="rtl"
   ├─ functions/api/[[path]].ts پروکسی Pages → Worker
   ├─ public/_headers           CSP سخت‌گیرانه و سرآیندهای امنیتی
   └─ src/                      main · api · ui · pages/{landing, auth, chat, admin, cortex, automation}
packages/cortex, packages/autopilot   ماژول‌های مستقل (README جداگانه)؛ API از خروجی dist آن‌ها استفاده می‌کند
```

---

## ۲. راه‌اندازی محلی

پیش‌نیاز: Node.js ≥ 20 (CI با Node 22).

```bash
npm ci                      # .npmrc مقدار legacy-peer-deps را تنظیم می‌کند (باگ npm 10 در peer های vitest)
cp apps/api/.dev.vars.example apps/api/.dev.vars    # مقدار OWNER_EMAIL محلی را بنویسید
npm run db:migrate:local -w @rayan/api              # ساخت جداول در D1 محلی (.wrangler/)
npm run dev:api             # http://127.0.0.1:8787  (wrangler dev --config wrangler.dev.toml --test-scheduled)
npm run dev:web             # http://localhost:5173  (Vite؛ /api به 8787 پروکسی می‌شود)
```

- اجرای دستی Cron در توسعه: `curl "http://127.0.0.1:8787/__scheduled?cron=*/15+*+*+*+*"`
- توسعهٔ آفلاین **بدون** Workers AI است (AI فقط به‌صورت remote اجرا می‌شود): `/api/chat` خطای فارسی «سرویس هوش مصنوعی موقتاً غیرفعال است» می‌دهد و `/api/health` وضعیت `ai=unconfigured` را گزارش می‌کند. برای آزمودن AI واقعی پس از `npx wrangler login` از `npm run dev:remote-ai -w @rayan/api` استفاده کنید (مصرف از سهمیهٔ رایگان شما کم می‌شود).

### دستورهای اصلی

| دستور | کار |
|---|---|
| `npm run typecheck` | بررسی نوع در هر پنج workspace (پیش از api، cortex و autopilot ساخته می‌شوند) |
| `npm test` | آزمون‌های shared، cortex و autopilot (Node ≥ 22.5 به‌خاطر `node:sqlite`) و api (vitest داخل workerd با D1 محلی) |
| `npm run build` | ساخت dist ماژول‌ها، وب (Vite) و باندل Worker با `wrangler deploy --dry-run` |
| `npm run build:modules` | فقط ساخت `@rayan/cortex` و `@rayan/autopilot` |
| `npm run gen:agents-sql -w @rayan/api` | بازتولید `0003_seed_agents.sql` از مانیفست‌ها |

---

## ۳. پایگاه دادهٔ D1

```bash
cd apps/api
npx wrangler login                                   # یک بار
npx wrangler d1 create rayan-db                      # database_id را در wrangler.toml (محلی) بگذارید
npx wrangler d1 migrations apply rayan-db --local    # محلی  (یا: npm run db:migrate:local)
npx wrangler d1 migrations apply rayan-db --remote   # تولید
npx wrangler d1 migrations list rayan-db --remote
```

در مخزن، `database_id` یک مقدار جایگزین (`00000000-…`) است؛ گردش‌کار deploy شناسهٔ واقعی را با نام `rayan-db` پیدا (یا در اولین اجرا ایجاد) و هنگام استقرار تزریق می‌کند.

**جداول:** `users`, `sessions`, `roles`, `permissions`, `role_permissions`, `user_roles`, `audit_logs`, `tasks`, `agents`, `usage_counters`, `scheduled_jobs`, `feature_flags` و `rate_limits` (وضعیت محدودکنندهٔ نرخ). همهٔ زمان‌ها میلی‌ثانیهٔ Unix هستند.

**جداول فاز ۲ (مهاجرت 0004):** `cortex_memory` (حافظهٔ جداشده به‌ازای کاربر)، `cortex_audit` (فقط‌افزودنی با زنجیرهٔ هش)، `cortex_tasks` و `cortex_task_steps` (برنامه و نتیجهٔ هر اجرا؛ ستون `task_ref` به `tasks.id` برای اجراهای صف)، `cortex_approvals`، `cortex_quota_usage`، و `autopilot_jobs`, `autopilot_job_runs`, `autopilot_events`, `autopilot_campaigns`, `autopilot_approvals` (فقط‌افزودنی)، `autopilot_snapshots`, `autopilot_site_pointers`, `autopilot_send_log`, `autopilot_send_dedupe`. نام ایندکس‌ها و تریگرها پیشوند `cortex_`/`autopilot_` دارند تا با جداول فاز ۱ تداخل نکنند. مهاجرت 0005 مجوزهای جدید و کار زمان‌بندی‌شدهٔ `autopilot.scan_events` را می‌افزاید.

---

## ۴. رازها و متغیرها (Secrets / Vars)

| نام | نوع | محل تنظیم | توضیح |
|---|---|---|---|
| `OWNER_EMAIL` | Wrangler **secret** | `npx wrangler secret put OWNER_EMAIL` یا رازِ مخزن `OWNER_EMAIL` | ایمیل مالک که پس از **ورود موفق و تأییدشده** به `super_admin` ارتقا می‌یابد. مقدار مورد نظر: `jalilitaymaz@gmail.com` — عمداً در کد/پیکربندی قرار ندارد. |
| `CLOUDFLARE_API_TOKEN` | GitHub secret | Settings → Secrets → Actions | توکن با دسترسی Workers Scripts, D1, Pages (Edit) و Workers AI (Read) |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub secret | همان‌جا | شناسهٔ حساب Cloudflare |
| `ALLOWED_ORIGINS` | var (wrangler.toml) / GitHub **variable** اختیاری | `vars.ALLOWED_ORIGINS` | فهرست دقیق مبدأهای مجاز با کاما؛ باید آدرس واقعی Pages شما باشد (مثلاً `https://rayan-web.pages.dev`). مبدأهای پوستهٔ اپ‌ها (`https://localhost` اندروید و `http://tauri.localhost` ویندوز) همیشه علاوه بر این فهرست مجازند. |
| `VITE_API_BASE_URL` | متغیر زمان ساخت وب (اختیاری) | محیط ساخت | آدرس مطلق API برای ساخت‌هایی که خارج از Pages سرو می‌شوند؛ خالی = هم‌مبدأ (`/api`). پوسته‌ها می‌توانند `apiBaseUrl` را در `/rayan-config.json` بنویسند که اولویت دارد. |
| `PAGES_PROJECT` | GitHub variable اختیاری | `vars.PAGES_PROJECT` | نام پروژهٔ Pages (پیش‌فرض `rayan-web`) |
| `AI_MODEL` | var | wrangler.toml | پیش‌فرض `@cf/meta/llama-3.1-8b-instruct` |
| `AI_DAILY_LIMIT` | var | wrangler.toml | سقف پیش‌فرض روزانهٔ فراخوانی AI (۶۰) — در پنل مدیریت قابل تغییر |
| `RATE_LIMIT_*`, `PBKDF2_ITERATIONS`, `SESSION_TTL_HOURS` | var | wrangler.toml | تنظیمات امنیتی |

هیچ فایل `.dev.vars` یا `.env` در git ثبت نمی‌شود (`.gitignore`).

---

## ۵. امنیت

- **رمز عبور:** PBKDF2-SHA256 با WebCrypto، ۱۰۰٬۰۰۰ تکرار (حداکثر مجاز workerd)، نمک ۱۶ بایتی؛ قالب `pbkdf2_sha256$iter$salt$hash`. مقایسه در زمان ثابت؛ برای ایمیل ناموجود هم هش ساختگی محاسبه می‌شود تا زمان پاسخ یکسان بماند.
- **نشست:** توکن تصادفی ۳۲ بایتی در کوکی `__Host-rayan_sid` با `HttpOnly; Secure; SameSite=Lax; Path=/`؛ در پایگاه داده فقط SHA-256 توکن ذخیره می‌شود. خروج، نشست را سمت سرور حذف می‌کند.
- **Super Admin:** هرگز از درخواست استنتاج نمی‌شود. ثبت‌نام همیشه نقش `member` می‌دهد و نشست نمی‌سازد؛ فقط تابع سمت سرور `bootstrapOwner` پس از تأیید رمز در `/api/auth/login` و برابر بودن ایمیل با `OWNER_EMAIL`، نقش `super_admin` را (یک بار، با ثبت ممیزی) اعطا می‌کند. API هیچ راهی برای اعطای `super_admin` ندارد.
- **RBAC:** نقش‌ها `super_admin`, `admin`, `member`؛ مجوزها در D1 (`role_permissions`) و هم‌خوان با `packages/shared/src/rbac.ts` (آزمون این هم‌خوانی را تضمین می‌کند).
- **ورودی:** اعتبارسنجی zod برای همهٔ بدنه‌ها؛ فقط `application/json` پذیرفته می‌شود.
- **محدودیت نرخ (D1):** به‌ازای IP برای کل API، به‌ازای IP برای auth، به‌ازای حساب برای ورود (۱۵ دقیقه)، به‌ازای کاربر برای چت. پاسخ ۴۲۹ با `Retry-After` و پیام فارسی.
- **ممیزی:** ثبت‌نام، ورود موفق/ناموفق، خروج، ارتقای مالک، تغییر نقش، فعال/غیرفعال‌سازی عامل، همگام‌سازی عامل‌ها، تغییر سقف مصرف، تغییر پرچم‌ها، لغو وظیفه.
- **سرآیندها:** CSP (`default-src 'none'` در API و CSP سخت‌گیرانه بدون inline در وب)، HSTS، `X-Frame-Options: DENY`، `nosniff`، `Referrer-Policy`، `Cache-Control: no-store`.
- **CORS و CSRF:** CORS فقط برای مبدأهای `ALLOWED_ORIGINS` (با credentials)؛ هر درخواست تغییردهنده با هدر `Origin` غیرمجاز رد می‌شود (403).

---

## ۶. کنترل‌گر هزینه (Cost Controller)

- شمارنده‌ها در `usage_counters(service, day, count, "limit")` به ازای روز UTC (هم‌زمان با بازنشانی سهمیهٔ Workers AI).
- رزرو سهمیه با **یک upsert اتمی** انجام می‌شود؛ درخواست‌های هم‌زمان نمی‌توانند از سقف عبور کنند (آزموده شده).
- با رسیدن به سقف، پیش از فراخوانی مدل پاسخ ۴۲۹ داده می‌شود:
  «سقف استفادهٔ روزانه از هوش مصنوعی به پایان رسیده است. لطفاً فردا دوباره تلاش کنید.»
- کلید اضطراری `ai_enabled` در `feature_flags`؛ سقف پیش‌فرض قابل تغییر توسط super_admin در پنل.
- **حساب سرانگشتی:** نرخ `llama-3.1-8b-instruct` ≈ ۲۵٬۶۰۸ نورون برای هر میلیون توکن ورودی و ۷۵٬۱۴۷ برای خروجی است. با سقف ۶٬۰۰۰ کاراکتر ورودی در هر درخواست و `max_tokens=512`، بدترین حالت حدود ۱۴۰ نورون در هر فراخوانی است؛ ۶۰ فراخوانی ≈ ۸٬۴۰۰ نورون < سهمیهٔ رایگان ۱۰٬۰۰۰ نورون در روز. مدل `@cf/meta/llama-3.1-8b-instruct-fp8-fast` حدود ۳ تا ۴ برابر ارزان‌تر است.

---

## ۷. API

| مسیر | دسترسی | توضیح |
|---|---|---|
| `GET /api/health` | عمومی | وضعیت db / ai / scheduler |
| `POST /api/auth/signup` | عمومی (محدودیت نرخ) | ساخت حساب با نقش member |
| `POST /api/auth/login` | عمومی (محدودیت نرخ) | ورود، کوکی نشست، bootstrap مالک |
| `POST /api/auth/logout` | واردشده | حذف نشست |
| `GET /api/me` | واردشده | کاربر، نقش‌ها، مجوزها |
| `POST /api/chat` | `chat:use` | گفت‌وگو با Workers AI (پرامپت سیستمی فارسی + Cost Controller) |
| `GET /api/agents` | `agents:read` | فهرست عامل‌ها |
| `PATCH /api/agents/:slug` | `agents:manage` | فعال/غیرفعال |
| `POST /api/agents/sync` | `agents:manage` | همگام‌سازی با مانیفست‌ها (حفظ وضعیت فعال بودن) |
| `POST /api/tasks` | `tasks:create` | ایجاد وظیفه (`echo`، `ai.prompt`) |
| `GET /api/tasks[?scope=all&status=]` | `tasks:read:own` / `tasks:read:all` | فهرست |
| `GET /api/tasks/:id` | مالک یا `tasks:read:all` | وضعیت |
| `POST /api/tasks/:id/cancel` | مالک یا `tasks:cancel:all` | لغو |
| `GET /api/admin/users` · `POST /api/admin/users/:id/roles` | `users:read` · `users:manage` | کاربران و نقش admin |
| `GET /api/admin/audit` | `audit:read` | گزارش ممیزی |
| `GET /api/admin/usage` · `PUT /api/admin/usage/workers_ai` | `usage:read` · `usage:manage` | مصرف و سقف |
| `GET /api/admin/flags` · `PUT /api/admin/flags/:key` | `usage:read` · `flags:manage` | پرچم‌ها |
| `GET /api/admin/scheduler` | `usage:read` | سلامت کارهای زمان‌بند |
| `POST /api/cortex/run` | `cortex:run` (member+) | اجرای هدف: محافظ → نیت → برنامه → عامل‌ها → اجرا → ارزیابی. بدنه: `{goal, tool_inputs?}` |
| `POST /api/cortex/content` | `cortex:run` | استودیو محتوا: `{kind: article\|post\|ad, topic, audience?, tone?}` → پیش‌نویس (منتشر نمی‌شود) |
| `GET /api/cortex/runs` · `GET /api/cortex/runs/:id` | `cortex:run` (فقط اجراهای خود) | تاریخچه و مراحل |
| `GET /api/cortex/approvals[?status=]` | `cortex:run` | درخواست‌های تأیید خودِ کاربر |
| `POST /api/cortex/approvals/:id/approve` · `/reject` | `cortex:run` + مالکیت؛ سطح restricted فقط super_admin | تأیید یک‌بارمصرف |
| `POST /api/tasks` با `type: "cortex.run"` | `tasks:create` + `cortex:run` | اجرای Cortex در صف Cron (`payload: {goal}`) |
| `GET /api/autopilot/events?days=60` | `autopilot:read` (admin+) | مناسبت‌های پیش رو به وقت تهران (۱ تا ۳۶۶ روز) |
| `POST /api/autopilot/campaigns/draft` | `autopilot:manage` | `{event_id, business, use_llm?}` → پیش‌نویس `pending_approval` با بنر SVG؛ رویداد سوگواری = 409 |
| `GET /api/autopilot/campaigns[?status=]` · `GET /api/autopilot/campaigns/:id` | `autopilot:read` | فهرست/جزئیات (+ سوابق تأیید) |
| `POST /api/autopilot/campaigns/:id/approve` · `/reject` | `autopilot:approve` | تصمیم انسانی، ثبت تأییدکننده و هش محتوا در `autopilot_approvals`؛ **هرگز انتشار خودکار نیست** |
| `GET /api/autopilot/jobs` · `POST /api/autopilot/jobs` | `autopilot:read` · `autopilot:manage` | کارهای زمان‌بندی‌شده (+ ۵ اجرای اخیر) / ساخت کار با کرون معتبر |
| `POST /api/autopilot/jobs/:id` | `autopilot:manage` | `{action: pause\|resume\|run_now\|delete}` |

**صف وظایف:** وضعیت‌ها `pending → running → succeeded | failed | cancelled`. پردازشگر Cron در هر اجرا حداکثر ۱۰ وظیفه را برمی‌دارد، هر وظیفه را حداکثر یک بار در هر اجرا تلاش می‌کند، `attempts` را به‌صورت اتمی هنگام برداشتن افزایش می‌دهد و هرگز وظیفه‌ای با `attempts >= max_attempts` را دوباره برنمی‌دارد (بدون حلقهٔ بی‌پایان). وظایفی که lease آن‌ها منقضی شده بازیابی می‌شوند؛ خطاهای غیرقابل‌تکرار (نوع ناشناخته، ورودی نامعتبر) فوراً `failed` می‌شوند. ضربان (heartbeat) در `scheduled_jobs` ثبت و در `/api/health` گزارش می‌شود (بیش از ۳۵ دقیقه = `stale`).

### Cortex در API (فاز ۲)

- **LLM:** همان `AiProvider` (Workers AI در تولید، mock در آزمون). هر فراخوانی مدل یک واحد از **همان Cost Controller** (`usage_counters`, `AI_DAILY_LIMIT`) رزرو می‌کند و کلید `ai_enabled` را رعایت می‌کند؛ اگر سهمیهٔ امروز تمام شده باشد پیش از هر کاری ۴۲۹ برمی‌گردد و در میانهٔ اجرا هم از سقف عبور نمی‌شود. نیت با کلیدواژه و برنامه با قالب ساخته می‌شود (بدون فراخوانی اضافهٔ مدل)؛ هر مرحله یک فراخوانی است (مثلاً تولید محتوا = ۳)، بدون retry.
- **عامل‌ها:** از جدول `agents` (وضعیت فعال/غیرفعال و مجوزهای مانیفست). برای هر slug یک پروفایل قابلیت/ابزار بازبینی‌شده در `src/lib/cortex.ts` هست؛ مجوزها هرگز فراتر از مانیفست نمی‌روند.
- **ابزارها:** `web.search` (DuckDuckGo Instant Answer رایگان، بدون کلید)، `web.fetch` (فقط https عمومی، ۲۰۰KB)، `admin.read` (خلاصهٔ وضعیت بدون دادهٔ شخصی)، `scheduler.create` (guarded) و `admin.write` (restricted). این دو ابزار حساس هیچ پیکربندی را تغییر نمی‌دهند و پس از تأیید فقط یک «درخواست» در `audit_logs` ثبت می‌کنند.
- **تأیید:** اقدام guarded/restricted اجرا نمی‌شود و ردیف `pending` در `cortex_approvals` می‌سازد. تأیید فقط توسط صاحب درخواست؛ restricted فقط با نقش super_admin (= owner). پس از تأیید، اجرای دوبارهٔ **همان هدف** آن اقدام را **یک بار** انجام می‌دهد (grant در ابتدای اجرا به‌صورت اتمی `consumed` می‌شود و اگر لازم نشد برمی‌گردد).
- **حافظه:** `D1MemoryAdapter` با `user_id` کاربر واردشده؛ اجراها و مراحل در `cortex_tasks`/`cortex_task_steps`.

### Autopilot در API (فاز ۲)

- `scheduled()` (هر ۱۵ دقیقه) علاوه بر کارهای فاز ۱، `Scheduler.tick()` را با `D1SchedulerStore` اجرا می‌کند (قفل اجاره‌ای + کلید یکتایی هر نوبت) و سلامتش در `scheduled_jobs` با نام `autopilot` ثبت می‌شود.
- **کار واقعی:** `autopilot.scan_events` روزانه ساعت ۹ به وقت تهران (اولین اجرا در اولین Cron پس از استقرار): برای مناسبت‌های مرتبطِ ۱۴ روز آینده پیش‌نویس کمپین می‌سازد (سوگواری و نامرتبط‌ها رد می‌شوند، برای هر مناسبت فقط یک پیش‌نویس). پیش‌فرض بدون LLM (قالب فارسی قطعی)؛ با `useLlm` متن از Workers AI و از همان سقف هزینه.
- هیچ مسیری برای انتشار یا ارسال در این فاز وجود ندارد؛ تأیید فقط وضعیت را `approved` می‌کند و رکورد فقط‌افزودنی می‌سازد.

### وب (فاز ۲)

صفحه‌های جدید (فقط فراخوانی واقعی API، نمایش بر اساس مجوز): **فضای کاری عامل‌ها** (`#/workspace`: ارسال هدف، برنامه/مراحل/خروجی، تأیید/رد)، **مرکز وظایف** (`#/tasks`: ایجاد وظیفهٔ cortex.run، فهرست، وضعیت، لغو)، **استودیو محتوا** (`#/content`) و **مرکز اتوماسیون** (`#/automation`، مدیران: مناسبت‌ها، پیش‌نویس‌ها با پیش‌نمایش بنر SVG از طریق `<img>` امن، تأیید/رد، کارها). آدرس API از `/rayan-config.json` (کلید `apiBaseUrl`) یا `VITE_API_BASE_URL` خوانده می‌شود و در غیر این صورت هم‌مبدأ است.

---

## ۸. استقرار (Deploy)

1. در GitHub رازهای `CLOUDFLARE_API_TOKEN` و `CLOUDFLARE_ACCOUNT_ID` (و ترجیحاً `OWNER_EMAIL`) را اضافه کنید.
2. در صورت نیاز متغیر مخزن `ALLOWED_ORIGINS` را به آدرس دقیق Pages خود تنظیم کنید.
3. با push به `main` یا اجرای دستی «Deploy to Cloudflare»: آزمون‌ها → یافتن/ساخت D1 → اعمال مهاجرت‌ها → استقرار Worker → تنظیم `OWNER_EMAIL` → ساخت و استقرار Pages.
4. **بلافاصله پس از اولین استقرار** با ایمیل مالک ثبت‌نام و وارد شوید تا نقش super_admin اعطا شود.

بدون این دو راز، گردش‌کار deploy فقط یک اعلان «Deploy skipped» می‌دهد و چیزی مستقر نمی‌کند.

---

## ۹. محدودیت‌های لایهٔ رایگان (بررسی‌شده در مستندات Cloudflare، نوامبر ۲۰۲۶)

| سرویس | محدودیت رایگان | پیامد برای رایان |
|---|---|---|
| Workers | ۱۰۰٬۰۰۰ درخواست در روز؛ ۱۰ms CPU در هر درخواست و هر اجرای Cron؛ ۵۰ زیردرخواست؛ ۵ Cron Trigger در هر حساب | PBKDF2 با ۱۰۰ هزار تکرار به این سقف CPU نزدیک است (ر.ک. محدودیت‌ها). توابع Pages هم از سهمیهٔ درخواست Workers استفاده می‌کنند. |
| D1 | ۵ میلیون ردیف خوانده‌شده و ۱۰۰٬۰۰۰ ردیف نوشته‌شده در روز؛ ۵۰۰MB برای هر پایگاه، ۵GB کل، ۱۰ پایگاه؛ ۵۰ کوئری در هر فراخوانی | هر درخواست API حداقل یک نوشتن (محدودکنندهٔ نرخ) دارد؛ پاک‌سازی دوره‌ای در Cron انجام می‌شود. |
| Workers AI | ۱۰٬۰۰۰ نورون در روز | Cost Controller با سقف ۶۰ فراخوانی پیش‌فرض |
| Pages | فایل‌های ایستا رایگان؛ درخواست‌های Functions جزو سهمیهٔ Workers | — |

منابع: <https://developers.cloudflare.com/workers/platform/limits/> · <https://developers.cloudflare.com/d1/platform/limits/> · <https://developers.cloudflare.com/d1/platform/pricing/> · <https://developers.cloudflare.com/workers-ai/platform/pricing/>

---

## ۱۰. نقشهٔ راه (پیشنهادی — فازهای ۲ تا ۹)

| فاز | عنوان | محتوا |
|---|---|---|
| ۲ | اجرای عامل‌ها (Agent Runtime) | اجرای واقعی عامل‌ها با مجوزهای محدود مانیفست، فراخوانی ابزار، واگذاری کار بین عامل‌ها، بودجهٔ مصرف برای هر عامل |
| ۳ | دانش و حافظه | RAG فارسی با Vectorize و R2 (لایهٔ رایگان)، بارگذاری اسناد، تاریخچهٔ گفت‌وگو |
| ۴ | یکپارچه‌سازی‌ها | GitHub برای عامل‌های مهندسی، ایمیل، وب‌هوک‌ها |
| ۵ | گردش‌کارهای خودکار | Queues/Workflows، تأیید انسانی برای تغییرات تولید، انتشار عمومی و ارسال انبوه |
| ۶ | حاکمیت و مشاهده‌پذیری | داشبورد هزینه و سلامت، هشدارها، تأیید ایمیل، کلید عبور/2FA، Turnstile |
| ۷ | اپ اندروید | Capacitor (APK) روی همین API |
| ۸ | اپ دسکتاپ | Tauri (EXE) |
| ۹ | مقیاس و عرضه | چندمستأجری، API عمومی، مستندات، آماده‌سازی انتشار |

---

## ۱۱. وضعیت فاز ۲ و محدودیت‌های آن

- ✅ Cortex و Autopilot به API، Cron و وب وصل شده‌اند؛ ۱۸ آزمون جدید (RBAC، سقف هزینه، کلید خاموشی، تأیید guarded/restricted و یک‌بارمصرف بودن، صف cortex.run، CORS پوسته‌ها، رویدادها، پیش‌نویس/تأیید/رد کمپین، اجرای کار زمان‌بندی‌شده و API کارها).
- اپ‌های اندروید/ویندوز مبدأ متفاوت دارند؛ CORS مجاز است، اما کوکی نشست `SameSite=Lax` در درخواست‌های بین‌مبدأ ارسال نمی‌شود. ورود از داخل پوسته‌ها به احراز هویت مبتنی بر توکن یا `SameSite=None` نیاز دارد (فاز بعد). همچنین CSP صفحات Pages فقط `connect-src 'self'` را مجاز می‌کند؛ `VITE_API_BASE_URL` برای ساخت‌های پوسته است، نه Pages.
- اجرای `/api/cortex/run` هم‌زمان (sync) است و محدود به ~۲۵ ثانیه؛ اهداف طولانی را با وظیفهٔ `cortex.run` در صف بگذارید. در پلن رایگان، سقف ۱۰ms CPU در هر درخواست ممکن است برای برنامه‌های چندمرحله‌ای تنگ باشد (زمان انتظار برای AI جزو CPU نیست).
- تأیید Cortex فقط برای «تکرار همان هدف» است (اثرانگشت = کاربر + عامل + ابزار + ورودی)؛ تأیید یک درخواست برای کاربر دیگر ممکن نیست.
- `image.generate` ثبت نشده است و عامل «طراحی گرافیک» فقط `image.prompt` دارد؛ نیت تصویر فعلاً با خطای «ابزار ناشناخته» ناقص تمام می‌شود.
- بیشتر عامل‌ها به‌صورت پیش‌فرض غیرفعال‌اند؛ نیت‌های کد/تحلیل فقط با عامل‌های فعال اجرا می‌شوند (مدیر‌عامل هوش مصنوعی به‌عنوان عمومی تحلیل/اتوماسیون/مدیریت را پوشش می‌دهد).
- تاریخ‌های قمری اتوپایلوت تقریبی‌اند (±۱–۲ روز)؛ مخاطب/ارسال پیامک و ایمیل هنوز وصل نیست (پیش‌نویس‌ها `contacts` خالی دارند).

## ۱۲. محدودیت‌های شناخته‌شدهٔ فاز ۱

- تأیید ایمیل وجود ندارد؛ اگر کسی پیش از مالک با `OWNER_EMAIL` ثبت‌نام کند، با ورود خود super_admin می‌شود. **بلافاصله پس از استقرار ثبت‌نام و وارد شوید** و در صورت نیاز سپس پرچم `signup_enabled` را از پنل مدیریت خاموش کنید. تأیید ایمیل در فاز ۶.
- PBKDF2 با ۱۰۰ هزار تکرار ممکن است گاهی از سقف ۱۰ms CPU پلن رایگان عبور کند؛ قالب هش شمار تکرار را ذخیره می‌کند، پس می‌توان `PBKDF2_ITERATIONS` را بدون شکستن حساب‌های موجود کاهش داد.
- محدودکنندهٔ نرخ پنجرهٔ ثابت است و برای هر درخواست یک نوشتن D1 مصرف می‌کند.
- کیفیت فارسی مدل ۸ میلیاردی Llama محدود است؛ مدل از طریق `AI_MODEL` قابل تغییر است.
- تاریخچهٔ چت فقط در حافظهٔ صفحه نگه داشته می‌شود.
- انواع وظیفه: `echo`، `ai.prompt` و (از فاز ۲) `cortex.run`.
- آزمون‌ها AI را mock می‌کنند؛ فراخوانی واقعی Workers AI فقط پس از استقرار یا با `dev:remote-ai` قابل بررسی است.

</div>
