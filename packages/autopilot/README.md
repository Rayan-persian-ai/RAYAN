# رایان اتوپایلوت — `@rayan/autopilot`

ماژول مستقل TypeScript برای «خلبان خودکار بازاریابی» کسب‌وکارهای ایرانی: تقویم مناسبت‌ها (شمسی/قمری/میلادی)، زمان‌بند cron سازگار با Cloudflare Workers، تولید **پیش‌نویس** کمپین (متن فارسی، بنر SVG راست‌به‌چپ، صفحهٔ فرود)، دروازهٔ تأیید انسانی، محافظ ضداسپم، نسخه‌بندی وب‌سایت و محاسبهٔ معیارها.

- بدون وابستگی زمان اجرا (zero runtime deps) و بدون هیچ API پولی.
- سازگار با Cloudflare Workers (فقط `Intl`، `crypto.subtle`، `TextEncoder`؛ کد `src/` هیچ API مخصوص Node ندارد).
- همهٔ خروجی‌های بیرونی (انتشار، ارسال، بازگردانی production، اعمال تم production) **فقط با رکورد تأیید انسانی** انجام می‌شوند.

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # dist/
```

> تست‌ها برای آزمودن جدول‌های D1 از `node:sqlite` استفاده می‌کنند (Node ≥ 22.5).

---

## ۱. تقویم (`EventCalendar`)

| بخش | توضیح |
|---|---|
| `toJalali / toGregorian / isLeapJalaliYear / jalaliMonthLength` | تبدیل شمسی↔میلادی با الگوریتم jalaali-js (MIT، بازنویسی‌شده در `src/calendar/jalali.ts`). در تست‌ها رفت‌وبرگشت همهٔ روزهای ۱۳۹۰ تا ۱۴۱۴ و مقایسه با `Intl` تقویم persian (هر هفت روز یک نمونه، بیش از ۱۰۰۰ تاریخ) بررسی می‌شود. |
| `formatJalali(d, { persianDigits, monthName })` | مثلاً `۳۰ آذر ۱۴۰۵` |
| `jdnToHijri / hijriOccurrencesInGregorianYear` | قمری: تخمین جدولی (islamic-civil) و سپس اصلاح با `Intl` تقویم `islamic-umalqura`. همهٔ تاریخ‌های قمری `approximate: true` دارند. |
| `new EventCalendar({ custom, disabled, hijriOffsetDays, timeZone })` | تقویم با رویدادهای ثابت و محاسبه‌شده + رویدادهای سفارشی مدیر |
| `calendar.upcoming(fromDate, days)` | رویدادهای بازهٔ `[from, from+days]` (شامل رویدادهای چندروزهٔ در جریان)، مرتب بر اساس تاریخ. `Date` بر اساس منطقهٔ زمانی `Asia/Tehran` به تاریخ تبدیل می‌شود. |
| `calendar.next(id, fromDate)` · `occurrencesInYear(gy)` · `addCustomEvent` · `removeCustomEvent` | |

**رویدادهای داخلی:** نوروز (۴ روز)، سیزده‌بدر، چهارشنبه‌سوری (سه‌شنبه‌شبِ پیش از آخرین چهارشنبهٔ سال)، شب یلدا، تیرگان، مهرگان، سپندارمذگان، روز جمهوری اسلامی، ۱۴ و ۱۵ خرداد، ۲۲ بهمن، ملی‌شدن نفت، روز معلم، روز فردوسی، روز پزشک، بازگشایی مدارس، روز دانشجو، روز مهندس، روز مادر (۲۰ جمادی‌الثانی)، روز پدر (۱۳ رجب)، عید فطر، عید غدیر، تاسوعا و عاشورا (حساسیت `mourning`)، سال نو میلادی، ولنتاین، بلک‌فرایدی (روز بعد از چهارمین پنجشنبهٔ نوامبر) و سایبر ماندی.

قواعد رویداد سفارشی (`EventRule`):
`{type:"jalali",month,day}` · `{type:"gregorian",month,day}` · `{type:"hijri",month,day}` · `{type:"nth_weekday",month,weekday,n,offsetDays?}` · `{type:"once",date}`

```ts
const cal = new EventCalendar({
  hijriOffsetDays: 0, // برای هم‌ترازی با تقویم رسمی ایران قابل تنظیم است
  custom: [{ id: "shop_anniversary", title: "Anniversary", titleFa: "سالگرد فروشگاه",
             category: "custom", rule: { type: "jalali", month: 8, day: 10 }, tags: ["sale"] }],
});
cal.upcoming("2026-11-25", 30); // black_friday, cyber_monday, mothers_day_ir (≈), students_day, yalda ...
```

## ۲. زمان‌بند (`Scheduler`)

- `parseCron / nextRun / nextRuns / isValidCron`: کرون ۵ بخشی با `*`، لیست، بازه، گام، نام ماه/روز، `7=یکشنبه`، ماکروهای `@daily` و…؛ معناشناسی Vixie (وقتی هر دو فیلد روز محدود باشند «یا» است). پارامتر `utcOffsetMinutes` (تهران = `210`؛ ایران از ۱۴۰۱ ساعت تابستانی ندارد).
- `new Scheduler({ store, handlers, lockTtlMs, maxJobsPerTick, owner, defaultUtcOffsetMinutes })`
  - `createJob({ id, name, cron, handler, payload, maxRuns, utcOffsetMinutes, paused })`
  - `tick(now)` ← از `scheduled()` در Cron Trigger صدا بزنید.
  - `runNow(jobId, idempotencyKey)` · `pauseJob` · `resumeJob` · `deleteJob`
- **ضد اجرای دوباره:** قفل اجاره‌ای اتمیک برای هر job + کلید یکتایی `jobId@<ISO زمانِ نوبت>` (در D1 با `UNIQUE`). اجرای دستی: `jobId@manual:<key>`.
- `maxRuns` فقط اجراهای موفق را می‌شمارد؛ پس از رسیدن به سقف وضعیت `completed`.
- سیاست نوبت‌های جامانده: یک بار اجرا و پرش به نوبت آیندهٔ بعدی.
- انبارها: `MemorySchedulerStore` و `D1SchedulerStore` (رابط `SchedulerStore` قابل تزریق).

نمونهٔ Worker کامل: `examples/worker.ts` (هر دقیقه tick؛ job روزانهٔ ساعت ۹ تهران پیش‌نویس کمپین‌های ۳۰ روز آینده را می‌سازد؛ Workers AI اختیاری است).

```toml
[triggers]
crons = ["* * * * *"]
```

## ۳. برنامه‌ریز کمپین (`CampaignPlanner`)

`await new CampaignPlanner({ llm?, llmTimeoutMs? }).plan(event, businessProfile, { contacts, channel, audience, now })`

خروجی `CampaignDraft` همیشه با `status: "pending_approval"`:

| فیلد | محتوا |
|---|---|
| `relevance` | امتیاز ۰–۱۰۰، `recommended / optional / skip`، دلایل فارسی (تناسب صنعت×برچسب رویداد، زمان‌بندی، تقریبی بودن، سوگواری=۰) |
| `idea` · `copy` | ایده، تیتر، متن، CTA، پیامک، هشتگ — فارسی |
| `discount` | `percent / gift / free_shipping / none`، گرد به ۵٪، محدود به `maxDiscountPercent`، کد قطعی مثل `YALDA0520` |
| `audience` | **فقط مخاطبان دارای رضایت صریح** (`consent.marketing === true`، لغونشده، کانال مجاز) + شمارش حذف‌شده‌ها |
| `banner` · `poster` | مشخصات بنر (۱۲۰۰×۶۲۸) و پوستر استوری (۱۰۸۰×۱۹۲۰) |
| `assets.bannerSvg/posterSvg` | SVG واقعی RTL (`xml:lang="fa"`، `direction="rtl"`، متن داخل RLE/PDF برای رندررهایی که `direction` را نادیده می‌گیرند) |
| `assets.landingHtml` | صفحهٔ فرود مستقل `dir="rtl"`، `noindex` تا زمان انتشار، لینک CTA با UTM |
| `schedule` · `warnings` · `generator` | `"llm"` یا `"template"` |

**LLM تزریقی:** `type LlmFn = (req: { system, prompt, temperature?, maxTokens? }) => Promise<string>`. خروجی باید JSON باشد؛ اعتبارسنجی می‌شود (فارسی بودن، طول، حذف HTML، ممنوعیت URL، و **رد هر درصد تخفیفی غیر از تخفیف تأییدشده**). در صورت خطا/timeout/خروجی نامعتبر، قالب قطعی فارسی جایگزین می‌شود. برای رویدادهای سوگواری LLM اصلاً صدا زده نمی‌شود.

خروجی‌های نمونه (تولیدشده توسط تست): `examples/output/*.svg|*.html|*-draft.json` و پیش‌نمایش PNG در `examples/output/previews/`.

## ۴. تأیید و انتشار (`ApprovalGate`, `CampaignPublisher`)

- سطح `guarded` (پیش‌فرض): یک تأیید **انسانی**؛ `strict`: دو تأییدکنندهٔ متمایز. سطح «خودکار» وجود ندارد.
- تأیید به **هش SHA-256 محتوا** گره خورده: هر ویرایش (`reviseDraft` نسخه را بالا می‌برد) تأیید قبلی را باطل می‌کند. تأیید برای هر `action` جداست (`publish`، `send`، `promote`، `rollback`، `apply`)، انقضا دارد (پیش‌فرض ۳۰ روز) و ردِ جدیدتر غالب است. تأییدکنندهٔ `kind: "agent"` پذیرفته نمی‌شود؛ `allowedRoles` اختیاری.
- `CampaignPublisher.publish(draft, publishFn)` و `send(draft, contacts, sender)` پیش از هر کاری `gate.assert` می‌کنند؛ ارسال برای رویداد سوگواری مسدود است؛ رضایت هنگام ارسال دوباره بررسی می‌شود.
- انبارها: `MemoryApprovalStore`، `D1ApprovalStore` (جدول فقط‌افزودنی با تریگر)، `MemoryCampaignStore`، `D1CampaignStore`.

## ۵. محافظ ضداسپم (`AntiSpamGuard`)

`guard.send(contact, channel, { body, subject? }, sender, { campaignId, now })`

- بدون رضایت ← `no_consent` (فرستنده هرگز صدا زده نمی‌شود).
- جلوگیری از تکرار به ازای `(campaign, contact, channel)` با claim اتمیک؛ ردشدن به‌دلیل ساعت سکوت کلید را مصرف نمی‌کند.
- سقف‌ها (پیش‌فرض): هر گیرنده ۱ در روز و ۳ در هفته؛ کل ۶۰ در دقیقه و ۲۰۰۰ در ساعت برای هر کانال.
- ساعت سکوت پیش‌فرض ۲۱:۰۰ تا ۰۹:۰۰ به وقت تهران؛ افزودن خودکار پانویس لغو (`لغو۱۱`) به پیامک.
- انبار: `MemorySendLogStore`، `D1SendLogStore`.

## ۶. وب‌سایت (`WebsiteVersioning`, تم)

- `snapshot / active / history / diff` — اسنپ‌شات‌ها تغییرناپذیرند.
- `promote(siteId, stagingSnapshotId)` و `rollback(siteId, "production", targetId)` نیازمند تأیید؛ بازگردانی staging آزاد است. بازگردانی تاریخچه را پاک نمی‌کند و اسنپ‌شات جدید می‌سازد.
- `proposeThemeChange({ siteId, current, changes? , event? })` ← پیشنهاد با `pending_approval`، اعتبارسنجی رنگ hex، بررسی کنتراست WCAG AA؛ `applyThemeProposal(..., "staging"|"production")` (production نیازمند تأیید و کنتراست قابل‌قبول؛ در صورت تغییر توکن‌ها از زمان پیشنهاد، `StaleProposalError`). `tokensToCss` برای تولید متغیرهای CSS.

## ۷. معیارها

`computeMetrics` (CTR، نرخ تبدیل، CPC، CPA، ROAS، بازهٔ Wilson) و `compareCampaigns(a, b)` (آزمون z دونسبتی، p-value، lift، برنده فقط در صورت معناداری، خلاصهٔ فارسی).

## ۸. پایگاه دادهٔ D1

`sql/schema.sql`: جدول‌های `autopilot_jobs`، `autopilot_job_runs`، `autopilot_events`، `autopilot_campaigns`، `autopilot_approvals` (append-only)، `autopilot_snapshots` (immutable)، `autopilot_site_pointers`، `autopilot_send_log`، `autopilot_send_dedupe`.

```bash
wrangler d1 execute <DB_NAME> --file=sql/schema.sql
```

## محدودیت‌ها

- تاریخ‌های قمری (روز مادر/پدر، اعیاد، تاسوعا/عاشورا) بر پایهٔ ام‌القری و **تقریبی** (±۱–۲ روز) هستند؛ تقویم رسمی ایران رؤیتی است. با `hijriOffsetDays` تنظیم کنید یا تاریخ را دستی تأیید کنید.
- کرون با آفست ثابت کار می‌کند (نه منطقهٔ زمانی IANA با DST).
- سقف‌های نرخ در `AntiSpamGuard` بررسی‌سپس‌ثبت است؛ در اجرای هم‌زمان چندین isolate حالت best-effort دارد (برای سقف سراسری دقیق از Durable Object استفاده کنید). claim تکراری اتمیک است.
- شکست ارسال‌کننده دوباره تلاش نمی‌شود (حداکثر یک‌بار).
- اندازه‌گیری عرض متن در SVG تخمینی است (۰٫۵em برای هر نویسه)؛ بهترین نتیجه با فونت Vazirmatn. انتخاب صنعت/برچسب و ضرایب تخفیف قواعد سادهٔ قابل تنظیم‌اند، نه مدل آماری.
- `autopilot_events` در schema هست ولی انبار D1 آماده برای رویدادهای سفارشی ندارد؛ ردیف‌ها را بخوانید و به `addCustomEvent` بدهید.
