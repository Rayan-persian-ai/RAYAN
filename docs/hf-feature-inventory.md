# موجودی امکانات سایت قدیمی رایان (HF Space) و وضعیت در رایان جدید

منبع: `https://tm13911391-rayan.static.hf.space/` (Space `tm13911391/rayan`، فقط خوانده شد و تغییری نکرد)، بررسی‌شده در ۲۰۲۶-۱۱-۲۶ با خواندن همهٔ فایل‌ها (`chat.js`، `extras.js`، `md.js`، `artifacts.js`، `files.js`، `simorgh.js`، `local-llm.js`، `support.js`، `settings.js`، `admin*.js`، `agents.html`، `pro.html`، …) و باز کردن همهٔ صفحه‌ها در Playwright.

> **یافتهٔ مهم:** صفحهٔ گفت‌وگوی سایت قدیمی الان در عمل از کار افتاده است: `support.js` یک خطای نحوی دارد (رشتهٔ ایتالیایی `l'agente` با آپاستروف بی‌گریز) و چون `chat.js` آن را import می‌کند، کل ماژول بار نمی‌شود و صفحه روی splash می‌ماند (`PAGEERROR Unexpected identifier 'agente'`). طبق دستور، Space قدیمی دست نخورد.

معماری قدیمی: صفحه‌های ایستا + Supabase (Auth، جدول‌ها، Edge Functionهای `rayan-pro` و `rayan-admin-agent` با کلید OpenRouter) + Pollinations از مرورگر + wllama در مرورگر. معماری جدید: Cloudflare Pages + Worker (Hono) + D1 + Workers AI؛ بدون Supabase.

| # | امکان در سایت قدیمی | نحوهٔ کار در قدیم | رایان جدید (فاز ۴) | وضعیت |
|---|---|---|---|---|
| 1 | تاریخچهٔ گفت‌وگوها (فهرست، جست‌وجو، تغییر نام، حذف، پاک کردن همه) | Supabase `conversations/messages` یا localStorage | D1 `conversations`/`messages`، `/api/conversations*`، نوار کناری با جست‌وجو در عنوان و متن | ✅ |
| 2 | پاسخ زنده (streaming) + توقف | SSE از Edge Function / Pollinations | SSE از Worker (Workers AI `stream:true`)، دکمهٔ «■ توقف» و Esc؛ پاسخ نیمه‌کاره با برچسب «متوقف شد» ذخیره می‌شود | ✅ |
| 3 | پاسخ دوباره (regenerate) | حذف آخرین پاسخ و پرسش دوباره | `/regenerate` | ✅ |
| 4 | جست‌وجو (ویکی‌پدیای فارسی) با منبع [n] | `simorgh.js` در مرورگر | سمت Worker (`lib/websearch.ts`)، فقط برای پرسش‌های واقعی، منابع زیر پاسخ | ✅ |
| 5 | تفکر عمیق | `mode: deep` به Edge Function | دستور سیستمی ویژه + بودجهٔ ۱۵۳۶ توکن، برچسب «🧠 تفکر عمیق» | ✅ |
| 6 | ساخت تصویر (Pollinations flux، مربع/افقی/عمودی، ترجمهٔ فارسی→انگلیسی، دانلود، تلاش دوباره) | مستقیم از مرورگر | `/api/images` (ترجمه با زنجیرهٔ AI، نشانی Pollinations، ذخیره در تاریخچه)، دانلود، تلاش دوباره، سقف روزانه ۳۰۰ | ✅ (Pollinations رایگان گاهی تصویر «BUSY» برمی‌گرداند) |
| 7 | ساخت ویدیو | دکمه «به‌زودی» (غیرفعال) | عمداً منتقل نشد (دکمهٔ نمایشی ممنوع) | ⛔ عمداً حذف |
| 8 | ورودی صوتی (Web Speech, fa-IR) | `startVoice` | دکمهٔ 🎤 فقط وقتی مرورگر پشتیبانی کند؛ `Permissions-Policy: microphone=(self)` | ✅ |
| 9 | خواندن پاسخ با صدا (TTS) | `speechSynthesis` | دکمهٔ 🔊 | ✅ |
| 10 | انتخاب شکلک | پنل ایموجی | پنل ایموجی | ✅ |
| 11 | Markdown کامل (جدول، فهرست تودرتو، نقل‌قول، کد) | `md.js` | `src/markdown.ts` (escape کامل، فقط لینک http/https) + برجسته‌سازی کد | ✅ |
| 12 | فایل از پاسخ: کپی/دانلود هر بلوک، نام فایل `**index.html**`، zip همه | `artifacts.js` | نوار ابزار هر بلوک کد + zip | ✅ |
| 13 | پیش‌نمایش زندهٔ وب‌سایت (HTML/SVG) + برگهٔ جدید | iframe srcdoc | iframe sandbox با مبدأ بسته روی `/preview` (CSP جدا) — بدون دسترسی به کوکی/حافظه | ✅ |
| 14 | تبدیل به Word (.docx) و PDF | `files.js` (docx در مرورگر، PDF با html2pdf از CDN) | `src/docx.ts` (docx واقعی RTL) و PDF با پنجرهٔ چاپ `/print` (بدون CDN) | ✅ |
| 15 | جعبهٔ پرسش روشن‌کننده (```question) | `parseQuestions` | همان قالب در prompt و رابط | ✅ |
| 16 | 👍/👎 بازخورد | `cloud.feedback` | `PATCH /api/messages/:id` | ✅ |
| 17 | اشتراک‌گذاری فقط‌خواندنی | `share.html?id=` | `/api/share/:id` و `#/share/<id>` بدون ورود؛ قابل لغو | ✅ |
| 18 | خروجی Markdown گفت‌وگو | `chatToMarkdown` | دکمه + Ctrl+Shift+E؛ zip همهٔ گفت‌وگوها در تنظیمات | ✅ |
| 19 | میان‌برهای صفحه‌کلید (Ctrl+Shift+O، Ctrl+K، …، ?) | `keysDlg` | همان فهرست | ✅ |
| 20 | شخصی‌سازی (اسم، سبک پاسخ، دربارهٔ من) | localStorage `rayan.persona` | D1 `user_prefs`، اعمال در system prompt | ✅ |
| 21 | پوستهٔ روشن/تیره/سیستم | `applyTheme` | `data-theme` + ذخیره در prefs | ✅ |
| 22 | مدل آفلاین در مرورگر (wllama + Gemma 3 1B از `tm13911391/rayan-gguf`) | `local-llm.js` (در v10 از چت حذف شده بود) | `src/local-llm.ts` + `public/vendor/wllama`، دانلود/حذف/آزمایش در تنظیمات، موتور «📴 آفلاین» و جایگزین خودکار هنگام قطعی سرور؛ service worker برای پوستهٔ آفلاین | ✅ |
| 23 | PWA (manifest، service worker، نصب) | `manifest.webmanifest`، `sw.js` | manifest با آیکن‌ها، `sw.js` | ✅ |
| 24 | پشتیبانی (کاربر ↔ مدیر) | Supabase + `support.js` | `/api/support` + تب «پشتیبانی» در مدیریت | ✅ |
| 25 | اعلان سراسری | جدول announcements | `/api/announcements` + تب «اعلان‌ها» (super_admin) | ✅ |
| 26 | مصرف من (آمار) | `my_usage` RPC | `/api/me/stats` در تنظیمات | ✅ |
| 27 | حذف همهٔ گفت‌وگوها | `clearAll` | ✅ (کناری + تنظیمات) | ✅ |
| 28 | برند: اورب، wordmark، favicon، آیکن‌ها، رنگ‌ها (#1E88FF، #050913) | فایل‌های Space | کپی در `apps/web/public/brand/` و متغیرهای CSS | ✅ |
| 29 | ورود با گوگل / کد یک‌بارمصرف ایمیل / تلفن | Supabase Auth | دستهٔ ۲ (Google OAuth + PKCE، کد ایمیل از Gmail API) | ⏳ دستهٔ بعد |
| 30 | استودیو ایجنت (رصد سایت با پراکسی‌های CORS عمومی) | localStorage + allorigins/corsproxy | فضای کاری Cortex/اتوپایلوت موجود؛ ایجنت‌های واقعی ایمیل/محتوا در دستهٔ ۳ | ⏳ دستهٔ بعد |
| 31 | پنل مدیر: ایجنت مدیریت زبان طبیعی، نظرسنجی، قوانین، کمپین ایمیل | Edge Function `rayan-admin-agent` | بخشی موجود (کاربران، عامل‌ها، وظایف، ممیزی، مصرف، پشتیبانی، اعلان‌ها)؛ نظرسنجی/قوانین/ایجنت مدیریت هنوز نه | ⏳ |
| 32 | تزریق CSS/JS سفارشی و کد شبکهٔ تبلیغاتی از پنل | `site_config` | عمداً منتقل نشد (خطر امنیتی XSS؛ CSP سخت‌گیر) | ⛔ عمداً حذف |
| 33 | «سرور AI دلخواه/ملی» و استخر endpointها از پنل | تنظیم در مرورگر با کلید API در کلاینت | زنجیرهٔ ai-router سمت سرور با secretها (کلید هرگز به مرورگر نمی‌رود) | ✅ (شکل امن‌تر) |
| 34 | صفحهٔ «رایان پرو» و دورهٔ آزمایشی ۷ روزه | فقط نمایشی، بدون پرداخت | عمداً منتقل نشد (دکمهٔ نمایشی ممنوع، بودجهٔ صفر) | ⛔ عمداً حذف |
| 35 | i18n چندزبانه (fa/en/…) | `i18n.js` | فقط فارسی RTL | ⏳ |
| 36 | سهم در آموزش (training opt-in، `rayan-knowledge`) | Edge Function | منتقل نشد | ⏳ |
| 37 | محافظ ضد تزریق سمت کاربر و سقف ۲۵ پیام/دقیقه | `secScan` در مرورگر | سقف سمت سرور (D1) + CSP + escape کامل خروجی | ✅ (سمت سرور) |
| 38 | کاهش توهم برای شعر و نقل‌قول | فقط دستور سیستمی | دستور سیستمی + یادآوری آخر پیام + **بیت‌های واقعی از API گنجور** به‌عنوان منبع + پیوند «بررسی متن در گنجور» | ✅ (بهتر از قدیم) |
