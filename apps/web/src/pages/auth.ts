import { api, clearMe } from "../api";
import { navigate } from "../nav";
import { alertBox, h, withBusy } from "../ui";

export function renderAuth(main: HTMLElement, mode: "login" | "signup") {
  const isSignup = mode === "signup";
  const out = h("div");
  const email = h("input", { type: "email", name: "email", required: true, autocomplete: "email", dir: "ltr", maxlength: 254 });
  const password = h("input", {
    type: "password",
    name: "password",
    required: true,
    minlength: isSignup ? 10 : 1,
    maxlength: 128,
    autocomplete: isSignup ? "new-password" : "current-password",
    dir: "ltr",
  });
  const displayName = h("input", { type: "text", name: "display_name", maxlength: 80, autocomplete: "nickname" });
  const submit = h("button", { type: "submit", class: "btn btn-primary btn-block" }, isSignup ? "ثبت‌نام" : "ورود");

  const form = h(
    "form",
    { class: "card form", novalidate: false },
    h("h1", {}, isSignup ? "ساخت حساب کاربری" : "ورود به رایان"),
    isSignup ? h("label", {}, "نام نمایشی (اختیاری)", displayName) : null,
    h("label", {}, "ایمیل", email),
    h("label", {}, "رمز عبور", password),
    isSignup ? h("small", { class: "muted" }, "حداقل ۱۰ کاراکتر.") : null,
    submit,
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
        await api("POST", "/auth/signup", { ...creds, ...(displayName.value.trim() ? { display_name: displayName.value.trim() } : {}) });
        out.replaceChildren(alertBox("حساب ساخته شد. در حال ورود…", "ok"));
      }
      // Signup never creates a session: the API grants access only after a verified login.
      await api("POST", "/auth/login", creds);
      clearMe();
      navigate("#/chat");
    });
  });

  main.append(h("section", { class: "narrow" }, form));
  email.focus();
}
