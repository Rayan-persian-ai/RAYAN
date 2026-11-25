<div dir="rtl">

# رایان (RAYAN) — سکوی هوش مصنوعی فارسی

**فاز ۱: زیرساخت (Foundation)** — یک مونوریپوی کامل و آزموده‌شده روی لایهٔ رایگان Cloudflare با هزینهٔ صفر.

- رابط کاربری فارسی و راست‌به‌چپ (`lang="fa"`, `dir="rtl"`) با قلم وزیرمتن
- API روی Cloudflare Workers با Hono و پایگاه دادهٔ D1 (SQLite)
- احراز هویت امن (PBKDF2 + کوکی نشست HttpOnly)، کنترل دسترسی نقش‌محور (RBAC)، محدودیت نرخ، گزارش ممیزی
- کنترل‌گر هزینه (Cost Controller) با سقف روزانه برای Workers AI
- رجیستری ۲۰ عامل هوشمند، صف وظایف و زمان‌بند Cron هر ۱۵ دقیقه

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
├─ package.json                 npm workspaces: packages/shared, apps/api, apps/web
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
│  ├─ migrations/               0001_init · 0002_seed_rbac · 0003_seed_agents (تولیدشده)
│  ├─ scripts/gen-agents-sql.mjs
│  ├─ src/
│  │  ├─ app.ts                 createApp(deps) — تزریق وابستگی (AI و هندلرهای وظیفه قابل mock)
│  │  ├─ index.ts               fetch + scheduled
│  │  ├─ middleware/            auth (RBAC, rate limit) · security (headers, CORS, origin guard)
│  │  ├─ routes/                auth · me · chat · agents · tasks · admin · health
│  │  ├─ lib/                   crypto · session · cost · ai · ratelimit · audit · bootstrap · …
│  │  └─ cron/                  processor · scheduled · handlers
│  └─ test/                     auth · rbac · ratelimit · cost · tasks · cron
└─ apps/web/
   ├─ index.html                lang="fa" dir="rtl"
   ├─ functions/api/[[path]].ts پروکسی Pages → Worker
   ├─ public/_headers           CSP سخت‌گیرانه و سرآیندهای امنیتی
   └─ src/                      main · api · ui · pages/{landing, auth, chat, admin}
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
| `npm run typecheck` | بررسی نوع در هر سه workspace |
| `npm test` | آزمون‌های shared (vitest) و api (vitest داخل workerd با D1 محلی) |
| `npm run build` | ساخت وب (Vite) و باندل Worker با `wrangler deploy --dry-run` |
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

---

## ۴. رازها و متغیرها (Secrets / Vars)

| نام | نوع | محل تنظیم | توضیح |
|---|---|---|---|
| `OWNER_EMAIL` | Wrangler **secret** | `npx wrangler secret put OWNER_EMAIL` یا رازِ مخزن `OWNER_EMAIL` | ایمیل مالک که پس از **ورود موفق و تأییدشده** به `super_admin` ارتقا می‌یابد. مقدار مورد نظر: `jalilitaymaz@gmail.com` — عمداً در کد/پیکربندی قرار ندارد. |
| `CLOUDFLARE_API_TOKEN` | GitHub secret | Settings → Secrets → Actions | توکن با دسترسی Workers Scripts, D1, Pages (Edit) و Workers AI (Read) |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub secret | همان‌جا | شناسهٔ حساب Cloudflare |
| `ALLOWED_ORIGINS` | var (wrangler.toml) / GitHub **variable** اختیاری | `vars.ALLOWED_ORIGINS` | فهرست دقیق مبدأهای مجاز با کاما؛ باید آدرس واقعی Pages شما باشد (مثلاً `https://rayan-web.pages.dev`) |
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

**صف وظایف:** وضعیت‌ها `pending → running → succeeded | failed | cancelled`. پردازشگر Cron در هر اجرا حداکثر ۱۰ وظیفه را برمی‌دارد، هر وظیفه را حداکثر یک بار در هر اجرا تلاش می‌کند، `attempts` را به‌صورت اتمی هنگام برداشتن افزایش می‌دهد و هرگز وظیفه‌ای با `attempts >= max_attempts` را دوباره برنمی‌دارد (بدون حلقهٔ بی‌پایان). وظایفی که lease آن‌ها منقضی شده بازیابی می‌شوند؛ خطاهای غیرقابل‌تکرار (نوع ناشناخته، ورودی نامعتبر) فوراً `failed` می‌شوند. ضربان (heartbeat) در `scheduled_jobs` ثبت و در `/api/health` گزارش می‌شود (بیش از ۳۵ دقیقه = `stale`).

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

## ۱۱. محدودیت‌های شناخته‌شدهٔ فاز ۱

- تأیید ایمیل وجود ندارد؛ اگر کسی پیش از مالک با `OWNER_EMAIL` ثبت‌نام کند، با ورود خود super_admin می‌شود. **بلافاصله پس از استقرار ثبت‌نام و وارد شوید** و در صورت نیاز سپس پرچم `signup_enabled` را از پنل مدیریت خاموش کنید. تأیید ایمیل در فاز ۶.
- PBKDF2 با ۱۰۰ هزار تکرار ممکن است گاهی از سقف ۱۰ms CPU پلن رایگان عبور کند؛ قالب هش شمار تکرار را ذخیره می‌کند، پس می‌توان `PBKDF2_ITERATIONS` را بدون شکستن حساب‌های موجود کاهش داد.
- محدودکنندهٔ نرخ پنجرهٔ ثابت است و برای هر درخواست یک نوشتن D1 مصرف می‌کند.
- کیفیت فارسی مدل ۸ میلیاردی Llama محدود است؛ مدل از طریق `AI_MODEL` قابل تغییر است.
- تاریخچهٔ چت فقط در حافظهٔ صفحه نگه داشته می‌شود.
- انواع وظیفه فعلاً `echo` و `ai.prompt` هستند؛ عامل‌ها در فاز ۱ فقط ثبت و کنترل می‌شوند و هنوز اجرا نمی‌شوند.
- آزمون‌ها AI را mock می‌کنند؛ فراخوانی واقعی Workers AI فقط پس از استقرار یا با `dev:remote-ai` قابل بررسی است.

</div>
