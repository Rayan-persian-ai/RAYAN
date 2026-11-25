import { api, type Me } from "../api";
import { alertBox, errorMessage, h, num, statusFa } from "../ui";

interface Health {
  status: string;
  db: { status: string };
  ai: { status: string; used_today?: number; daily_limit?: number };
  scheduler: { status: string; age_seconds?: number };
}

export function renderLanding(main: HTMLElement, me: Me | null) {
  const cta = me
    ? h("a", { href: "#/chat", class: "btn btn-primary btn-lg" }, "شروع گفت‌وگو")
    : h("a", { href: "#/signup", class: "btn btn-primary btn-lg" }, "ساخت حساب رایگان");

  const features: [string, string][] = [
    ["فارسی از پایه", "رابط راست‌به‌چپ، قلم وزیرمتن و پاسخ‌های هوش مصنوعی به زبان فارسی."],
    ["۲۰ عامل تخصصی", "از مدیرعامل هوش مصنوعی تا پشتیبانی مشتری؛ هر عامل با مجوزهای محدود و قابل کنترل."],
    ["امنیت جدی", "رمزنگاری PBKDF2، نشست‌های HttpOnly، کنترل دسترسی نقش‌محور و گزارش ممیزی."],
    ["هزینهٔ صفر", "اجرا روی لایهٔ رایگان Cloudflare با سقف مصرف روزانه برای جلوگیری از هر هزینهٔ ناخواسته."],
  ];

  const healthBox = h("div", { class: "card health" }, h("p", { class: "muted" }, "در حال بررسی وضعیت سامانه…"));

  main.append(
    h(
      "section",
      { class: "hero" },
      h("h1", {}, "رایان؛ سکوی هوش مصنوعی فارسی"),
      h("p", { class: "lead" }, "دستیار و تیم عامل‌های هوشمند برای کار و کسب‌وکار شما — امن، شفاف و بدون هزینه."),
      h("div", { class: "hero-actions" }, cta),
    ),
    h("section", { class: "grid features" }, ...features.map(([t, d]) => h("article", { class: "card" }, h("h3", {}, t), h("p", {}, d)))),
    h("section", {}, h("h2", {}, "وضعیت سامانه"), healthBox),
  );

  api<Health>("GET", "/health")
    .then((hl) => {
      const row = (label: string, status: string, extra?: string) =>
        h("li", {}, h("span", {}, label), h("span", { class: `badge badge-${status}` }, statusFa(status)), extra ? h("small", { class: "muted" }, extra) : null);
      healthBox.replaceChildren(
        h(
          "ul",
          { class: "health-list" },
          row("وضعیت کلی", hl.status),
          row("پایگاه داده", hl.db.status),
          row("هوش مصنوعی", hl.ai.status, hl.ai.daily_limit !== undefined ? `مصرف امروز: ${num(hl.ai.used_today)} از ${num(hl.ai.daily_limit)}` : undefined),
          row("زمان‌بند", hl.scheduler.status, hl.scheduler.age_seconds !== undefined ? `آخرین ضربان: ${num(Math.round(hl.scheduler.age_seconds / 60))} دقیقه پیش` : undefined),
        ),
      );
    })
    .catch((e) => healthBox.replaceChildren(alertBox(errorMessage(e))));
}
