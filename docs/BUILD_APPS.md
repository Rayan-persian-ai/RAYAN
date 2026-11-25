# ساخت اپلیکیشن‌های اندروید و ویندوز رایان

این راهنما توضیح می‌دهد که پوسته‌های بومی رایان چطور ساخته می‌شوند:

| پلتفرم | پوشه | فناوری | خروجی |
|---|---|---|---|
| اندروید | `apps/mobile` | Capacitor 6 | فایل APK (دیباگ و ریلیز امضاشده) |
| ویندوز | `apps/desktop` | Tauri v2 | نصب‌کنندهٔ `.exe` (NSIS) و `.msi` |

هر دو پوسته **همان خروجی وب** (`apps/web/dist`) را داخل برنامه بسته‌بندی می‌کنند؛ هیچ منطق جداگانه‌ای در پوسته‌ها نیست. همه‌چیز رایگان و متن‌باز است (GitHub Actions، Capacitor، Tauri، ImageMagick).

---

## ۱. ساختار

```
apps/
  web/            ← اپ وب (Vite) — خروجی: apps/web/dist
  mobile/         ← پوستهٔ اندروید
    capacitor.config.ts      (appId: com.rayan.ai، نام: «رایان»، webDir: ../web/dist)
    android/                 (پروژهٔ Gradle؛ باید کامیت شود)
    web-extras/offline.html  (صفحهٔ آفلاین فارسی و راست‌چین)
    resources/               (آیکون و اسپلش منبع)
    scripts/                 (تولید آیکون، بررسی بیلد وب، تزریق تنظیمات)
  desktop/        ← پوستهٔ ویندوز
    src-tauri/tauri.conf.json (productName: Rayan، identifier: com.rayan.ai)
    scripts/stage-web.mjs     (کپی apps/web/dist به apps/desktop/dist + فایل‌های پوسته)
.github/workflows/
  android.yml   windows.yml
```

> پوشه‌های `apps/mobile` و `apps/desktop` عضو workspaceهای npm ریشه **نیستند** و هر کدام `package-lock.json` جداگانه دارند تا وابستگی‌های سنگین بومی وارد بیلد وب نشوند.

---

## ۲. آدرس API (قابل تنظیم)

آدرس API به دو شکل به برنامه می‌رسد:

1. **هنگام بیلد وب:** متغیر `VITE_API_BASE_URL` (در کد وب از `import.meta.env.VITE_API_BASE_URL` خوانده شود).
2. **هنگام بیلد پوسته (قابل بازنویسی بدون بیلد دوبارهٔ وب):** متغیر `RAYAN_API_BASE_URL` → فایل `rayan-config.json` در ریشهٔ برنامه:

```json
{ "apiBaseUrl": "https://rayan-api.example.workers.dev", "platform": "android", "shellVersion": "0.1.0" }
```

پیشنهاد برای کد وب: هنگام شروع، `fetch('/rayan-config.json')` را امتحان کند و اگر `apiBaseUrl` غیرخالی بود، آن را به مقدار بیلد ترجیح دهد.

در GitHub این مقدار را یک‌بار در **Settings → Secrets and variables → Actions → Variables** با نام `RAYAN_API_BASE_URL` بسازید (این یک «Variable» است، نه Secret). هنگام اجرای دستی workflow هم می‌توانید آن را بازنویسی کنید. فقط آدرس `https://` پذیرفته می‌شود.

**مهم برای API (CORS):** درخواست‌های برنامه از این مبداها می‌آیند و باید در CORS سرور API مجاز باشند:

- اندروید: `https://localhost`
- ویندوز (Tauri v2): `http://tauri.localhost`

---

## ۳. دیباگ در برابر ریلیز

| | دیباگ (Debug) | ریلیز (Release) |
|---|---|---|
| امضا | کلید دیباگ خودکار اندروید | کلید خصوصی شما (keystore) |
| نصب روی گوشی | بله (با فعال‌کردن «منابع ناشناس») | بله |
| انتشار در فروشگاه / به‌روزرسانی رسمی | خیر | بله |
| در CI | **همیشه** ساخته می‌شود | فقط وقتی هر ۴ Secret امضا تعریف شده باشند |
| اشکال‌زدایی WebView | با `RAYAN_DEBUG=1` هنگام sync | خاموش |

نکته: نسخهٔ دیباگ و ریلیز هر دو شناسهٔ `com.rayan.ai` دارند، پس چون امضایشان فرق دارد، برای جابه‌جایی بین آن‌ها باید نسخهٔ قبلی را حذف کنید.

---

## ۴. ساخت keystore اندروید (فقط یک‌بار، روی سیستم خودتان)

نیازمند JDK 17 (دستور `keytool`):

```bash
keytool -genkeypair -v \
  -keystore rayan-release.jks \
  -alias rayan \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Rayan, O=RAYAN, C=IR"
```

از شما دو رمز خواسته می‌شود (رمز keystore و رمز کلید). آن‌ها را در یک مدیر رمز امن نگه دارید.

⚠️ **هشدارهای حیاتی**

- فایل `rayan-release.jks` را **هرگز** در گیت کامیت نکنید (`*.jks`، `*.keystore` و `keystore.properties` در `.gitignore` هستند).
- از keystore یک نسخهٔ پشتیبان آفلاین و امن بگیرید. **اگر گم شود، دیگر نمی‌توانید برای همان برنامه به‌روزرسانی منتشر کنید.**

### تبدیل به Base64 برای GitHub

```bash
# لینوکس
base64 -w0 rayan-release.jks > rayan-release.jks.b64
# مک
base64 -i rayan-release.jks | tr -d '\n' > rayan-release.jks.b64
# ویندوز (PowerShell)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("rayan-release.jks")) | Set-Content rayan-release.jks.b64
```

محتوای فایل `.b64` را کپی کنید و سپس آن فایل را پاک کنید.

---

## ۵. افزودن Secretها در GitHub

مسیر: **Repository → Settings → Secrets and variables → Actions → New repository secret**

| نام Secret | مقدار |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | محتوای فایل `.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | رمز keystore |
| `ANDROID_KEY_ALIAS` | نام مستعار کلید (مثلاً `rayan`) |
| `ANDROID_KEY_PASSWORD` | رمز کلید |

اگر حتی یکی از این چهار مورد نباشد، workflow فقط APK دیباگ را می‌سازد و پیام اطلاع‌رسانی می‌دهد (خطا نمی‌دهد). keystore فقط در پوشهٔ موقت اجراکننده (`$RUNNER_TEMP`) باز می‌شود و در پایان کار حذف می‌شود.

### امضای ویندوز (اختیاری)

| نام Secret | مقدار |
|---|---|
| `WINDOWS_CERTIFICATE` | Base64 فایل `.pfx` گواهی امضای کد |
| `WINDOWS_CERTIFICATE_PASSWORD` | رمز فایل `.pfx` |

بدون این‌ها نصب‌کننده‌ها **بدون امضا** ساخته می‌شوند؛ کار می‌کنند ولی ویندوز (SmartScreen) هنگام نصب هشدار «ناشر ناشناس» می‌دهد. گواهی امضای کد معمولاً پولی است؛ برای پروژه‌های متن‌باز، برنامهٔ رایگان SignPath Foundation گزینهٔ قابل بررسی است. تا آن زمان نصب بدون امضا کافی است.

---

## ۶. اجرای Workflowها

- **دستی:** تب **Actions** → «Android APK» یا «Windows desktop» → **Run workflow**.
- **خودکار:** با push یک تگ نسخه:

```bash
git tag v0.1.0
git push origin v0.1.0
```

خروجی‌ها در بخش **Artifacts** همان اجرا قرار می‌گیرند:

- `rayan-android-debug-…` ← فایل `app-debug.apk`
- `rayan-android-release-…` ← فایل `app-release.apk` (فقط با Secretها)
- `rayan-windows-…` ← فایل‌های `Rayan_x.y.z_x64-setup.exe` و `Rayan_x.y.z_x64_en-US.msi`

هیچ workflowی چیزی را به‌صورت عمومی (GitHub Release یا فروشگاه) منتشر **نمی‌کند**؛ انتشار عمومی تصمیم دستی مالک پروژه است.

نسخه‌گذاری: `versionCode` اندروید = شمارهٔ اجرای workflow (همیشه افزایشی)؛ `versionName` = نام تگ بدون `v`. برای MSI ویندوز نسخه باید عددی `X.Y.Z` باشد (پسوندهایی مثل `-beta` حذف می‌شوند).

---

## ۷. ساخت محلی

### اندروید (نیازمند Node 20، JDK 17 و Android SDK 34)

```bash
# از ریشهٔ مخزن
npm ci && npm run build -w @rayan/web
cd apps/mobile
npm ci
RAYAN_API_BASE_URL=https://… npm run sync      # cap sync + offline.html + rayan-config.json
cd android && ./gradlew assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk
```

برای ریلیز امضاشدهٔ محلی، `android/keystore.properties.example` را به `android/keystore.properties` کپی و مسیر و رمزها را وارد کنید (این فایل git-ignore شده است)، سپس `./gradlew assembleRelease`. بدون آن، خروجی `app-release-unsigned.apk` خواهد بود.

### ویندوز (روی ویندوز، نیازمند Node 20، Rust stable و Visual Studio Build Tools)

```bash
npm ci && npm run build -w @rayan/web
cd apps/desktop
npm ci
npx tauri build --bundles nsis,msi
```

خروجی: `apps/desktop/src-tauri/target/release/bundle/{nsis,msi}/`

---

## ۸. آیکون و اسپلش

آیکون‌ها از قبل ساخته و کامیت شده‌اند. برای ساخت دوباره (مثلاً با تغییر رنگ):

```bash
cd apps/mobile
bash scripts/generate-assets.sh            # ImageMagick؛ هم اندروید و هم ویندوز را به‌روز می‌کند
python3 scripts/render-wordmark.py <فونت وزیرمتن>   # فقط اگر نوشتهٔ «رایان» تغییر کند
```

طرح آیکون متقارن و وسط‌چین است تا در چیدمان راست‌چین و چپ‌چین یکسان دیده شود.

---

## ۹. عیب‌یابی

| مشکل | راه‌حل |
|---|---|
| `Web build not found` | ابتدا `npm run build -w @rayan/web` را اجرا کنید. |
| صفحهٔ «اتصال برقرار نیست» | WebView نتوانسته صفحه را بارگذاری کند؛ اینترنت یا آدرس API را بررسی کنید. |
| خطای CORS در برنامه | مبداهای بخش ۲ را در API مجاز کنید. |
| APK ریلیز ساخته نشد | هر چهار Secret اندروید را با نام دقیق بررسی کنید. |
| خطای نسخه در MSI | تگ باید به شکل `vX.Y.Z` باشد. |
