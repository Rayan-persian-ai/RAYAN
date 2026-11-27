/**
 * Sign-in / sign-up. Password login is always available; «ورود با گوگل» and the email-code flows
 * (passwordless code, verification code on signup, password reset) appear only when /api/health says
 * they really work (Google client + email provider configured) — no dead buttons.
 */
import { api, ApiError, clearMe } from "../api";
import { navigate } from "../nav";
import { alertBox, h, withBusy } from "../ui";

interface AuthCaps {
  google: boolean;
  email_codes: boolean;
}
let capsCache: Promise<AuthCaps> | null = null;
export function authCaps(): Promise<AuthCaps> {
  capsCache ??= api<{ auth?: AuthCaps }>("GET", "/health")
    .then((r) => ({ google: !!r.auth?.google, email_codes: !!r.auth?.email_codes }))
    .catch(() => ({ google: false, email_codes: false }));
  return capsCache;
}

const OAUTH_ERRORS: Record<string, string> = {
  google_denied:
    "ورود با گوگل فعلاً فقط برای حساب‌های آزمایشیِ تأییدشده باز است (برنامهٔ گوگل رایان هنوز در حالت آزمایشی است). لطفاً با ایمیل و رمز عبور یا کد ایمیل وارد شوید.",
  oauth_failed: "ورود با گوگل ناموفق بود. لطفاً دوباره تلاش کنید یا با ایمیل وارد شوید.",
  google_unavailable: "ورود با گوگل در حال حاضر فعال نیست.",
};

const emailInput = () => h("input", { type: "email", name: "email", required: true, autocomplete: "email", dir: "ltr", maxlength: 254 });
const codeInput = () => h("input", { name: "code", required: true, inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9۰-۹]{6}", maxlength: 6, dir: "ltr", placeholder: "۶ رقم", class: "code-input" });
const pwInput = (isNew: boolean) =>
  h("input", { type: "password", name: "password", required: true, minlength: isNew ? 10 : 1, maxlength: 128, autocomplete: isNew ? "new-password" : "current-password", dir: "ltr" });

async function afterLogin() {
  clearMe();
  navigate("#/chat");
}

/** Code entry step (verify / login / reset). */
function codeStep(box: HTMLElement, email: string, purpose: "verify" | "login" | "reset", note: string) {
  const out = h("div");
  const code = codeInput();
  const pw = pwInput(true);
  const submit = h("button", { type: "submit", class: "btn btn-primary btn-block" }, purpose === "reset" ? "تغییر رمز عبور" : purpose === "verify" ? "تأیید ایمیل و ورود" : "ورود");
  const resend = h("button", { type: "button", class: "btn btn-ghost btn-small" }, "ارسال دوبارهٔ کد");
  const form = h(
    "form",
    { class: "card form" },
    h("h1", {}, purpose === "reset" ? "بازیابی رمز عبور" : purpose === "verify" ? "تأیید ایمیل" : "ورود با کد ایمیل"),
    h("p", { class: "muted" }, note, " ", h("bdi", { dir: "ltr" }, email)),
    h("label", {}, "کد ۶ رقمی", code),
    purpose === "reset" ? h("label", {}, "رمز عبور جدید (حداقل ۱۰ کاراکتر)", pw) : null,
    submit,
    h("div", { class: "row" }, resend),
    out,
  );
  resend.onclick = () =>
    withBusy(resend, out, async () => {
      await api("POST", "/auth/email/send-code", { email, purpose });
      out.replaceChildren(alertBox("کد تازه ارسال شد.", "ok"));
    });
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void withBusy(submit, out, async () => {
      if (purpose === "reset") {
        await api("POST", "/auth/password/reset", { email, code: code.value.trim(), password: pw.value });
        out.replaceChildren(alertBox("رمز عبور تغییر کرد. در حال ورود…", "ok"));
        await api("POST", "/auth/login", { email, password: pw.value });
      } else await api("POST", purpose === "verify" ? "/auth/email/verify" : "/auth/email/login", { email, code: code.value.trim() });
      await afterLogin();
    });
  });
  box.replaceChildren(form);
  code.focus();
}

/** Ask for an email, send a code, then show the code step. */
function sendCodeStep(box: HTMLElement, purpose: "login" | "reset", prefill = "") {
  const out = h("div");
  const email = emailInput();
  email.value = prefill;
  const submit = h("button", { type: "submit", class: "btn btn-primary btn-block" }, "ارسال کد به ایمیل");
  const form = h(
    "form",
    { class: "card form" },
    h("h1", {}, purpose === "reset" ? "فراموشی رمز عبور" : "ورود با کد ایمیل"),
    h("p", { class: "muted" }, purpose === "reset" ? "کدی برای ساخت رمز جدید به ایمیلتان می‌فرستیم." : "بدون رمز عبور وارد شوید: یک کد ۶ رقمی به ایمیلتان می‌فرستیم."),
    h("label", {}, "ایمیل", email),
    submit,
    out,
    h("p", { class: "center" }, h("a", { href: "#/login" }, "بازگشت به ورود با رمز")),
  );
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void withBusy(submit, out, async () => {
      const e = email.value.trim();
      await api("POST", "/auth/email/send-code", { email: e, purpose });
      codeStep(box, e, purpose, "اگر حسابی با این ایمیل وجود داشته باشد، کد به آن ارسال شد:");
    });
  });
  box.replaceChildren(form);
  email.focus();
}

export async function renderAuth(main: HTMLElement, mode: "login" | "signup", params = new URLSearchParams()) {
  const isSignup = mode === "signup";
  const box = h("section", { class: "narrow" });
  main.append(box);
  const caps = await authCaps();
  const out = h("div");
  const err = params.get("err");
  if (err && OAUTH_ERRORS[err]) out.append(alertBox(OAUTH_ERRORS[err]!, err === "google_denied" ? "info" : "error"));
  const email = emailInput();
  const password = pwInput(isSignup);
  const displayName = h("input", { type: "text", name: "display_name", maxlength: 80, autocomplete: "nickname" });
  const submit = h("button", { type: "submit", class: "btn btn-primary btn-block" }, isSignup ? "ثبت‌نام" : "ورود");

  const google = caps.google
    ? h(
        "a",
        { class: "btn btn-google btn-block", href: "/api/auth/google/start" },
        h("span", { class: "g-logo", "aria-hidden": "true" }, "G"),
        isSignup ? " ثبت‌نام با گوگل" : " ورود با گوگل",
      )
    : null;
  const codeLinks = caps.email_codes && !isSignup
    ? h(
        "div",
        { class: "row center-row" },
        h("button", { type: "button", class: "btn btn-ghost btn-small", onclick: () => sendCodeStep(box, "login", email.value.trim()) }, "✉️ ورود با کد ایمیل"),
        h("button", { type: "button", class: "btn btn-ghost btn-small", onclick: () => sendCodeStep(box, "reset", email.value.trim()) }, "فراموشی رمز عبور"),
      )
    : null;

  const form = h(
    "form",
    { class: "card form" },
    h("h1", {}, isSignup ? "ساخت حساب کاربری" : "ورود به رایان"),
    google,
    google ? h("div", { class: "or" }, "یا") : null,
    isSignup ? h("label", {}, "نام نمایشی (اختیاری)", displayName) : null,
    h("label", {}, "ایمیل", email),
    h("label", {}, "رمز عبور", password),
    isSignup ? h("small", { class: "muted" }, "حداقل ۱۰ کاراکتر.") : null,
    submit,
    codeLinks,
    out,
    h(
      "p",
      { class: "muted center" },
      isSignup ? "حساب دارید؟ " : "حساب ندارید؟ ",
      h("a", { href: isSignup ? "#/login" : "#/signup" }, isSignup ? "وارد شوید" : "ثبت‌نام کنید"),
    ),
  );

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void withBusy(submit, out, async () => {
      const creds = { email: email.value.trim(), password: password.value };
      if (isSignup) {
        const r = await api<{ verification_required?: boolean }>("POST", "/auth/signup", { ...creds, ...(displayName.value.trim() ? { display_name: displayName.value.trim() } : {}) });
        if (r.verification_required) {
          codeStep(box, creds.email, "verify", "حساب ساخته شد. کد تأیید به این ایمیل فرستاده شد:");
          return;
        }
        out.replaceChildren(alertBox("حساب ساخته شد. در حال ورود…", "ok"));
      }
      try {
        // Signup never creates a session: the API grants access only after a verified login.
        await api("POST", "/auth/login", creds);
      } catch (e) {
        if (e instanceof ApiError && e.code === "email_unverified") {
          await api("POST", "/auth/email/send-code", { email: creds.email, purpose: "verify" }).catch(() => {});
          codeStep(box, creds.email, "verify", "ایمیل شما هنوز تأیید نشده است. کد تأیید به این ایمیل فرستاده شد:");
          return;
        }
        throw e;
      }
      await afterLogin();
    });
  });

  box.replaceChildren(form);
  email.focus();
}
