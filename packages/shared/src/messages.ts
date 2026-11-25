/** Persian user-facing error messages, keyed by stable English error codes. */
export const ERRORS_FA = {
  unauthorized: "برای ادامه ابتدا وارد حساب خود شوید.",
  forbidden: "شما اجازهٔ انجام این کار را ندارید.",
  invalid_input: "اطلاعات ارسال‌شده معتبر نیست.",
  invalid_credentials: "ایمیل یا رمز عبور نادرست است.",
  email_taken: "این ایمیل قبلاً ثبت شده است.",
  signup_disabled: "ثبت‌نام در حال حاضر غیرفعال است.",
  rate_limited: "تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.",
  daily_cap_reached: "سقف استفادهٔ روزانه از هوش مصنوعی به پایان رسیده است. لطفاً فردا دوباره تلاش کنید.",
  ai_disabled: "سرویس هوش مصنوعی موقتاً غیرفعال است.",
  ai_error: "پاسخ‌گویی هوش مصنوعی با خطا مواجه شد. لطفاً دوباره تلاش کنید.",
  not_found: "مورد درخواستی پیدا نشد.",
  conflict: "این عملیات در وضعیت فعلی امکان‌پذیر نیست.",
  origin_not_allowed: "درخواست از مبدأ غیرمجاز ارسال شده است.",
  internal: "خطای داخلی سرور رخ داد.",
} as const;
export type ErrorCode = keyof typeof ERRORS_FA;
