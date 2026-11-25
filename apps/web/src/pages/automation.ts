/** Automation Center: upcoming events (Tehran), campaign drafts with SVG preview + approve/reject, scheduler jobs. */
import { api, can, type Me } from "../api";
import { alertBox, badge, dataTable, date, errorMessage, h, ltrText, num, text, withBusy } from "../ui";

interface EventView {
  id: string;
  instance_id: string;
  title_fa: string;
  date: string;
  jalali: string;
  category: string;
  sensitivity: string;
  promotion_allowed: boolean;
  approximate: boolean;
  duration_days: number;
}
interface CampaignView {
  id: string;
  version: number;
  status: string;
  business_id: string;
  event: { id: string; titleFa: string; date: string; jalaliDate: string; approximate: boolean };
  relevance: { score: number; recommendation: string; reasons: string[] };
  idea: { title: string; summary: string };
  copy: { headline: string; body: string; cta: string; sms: string; hashtags: string[] };
  discount: { type: string; value?: number; code?: string | null };
  schedule: { startDate: string; suggestedSendDate: string; suggestedSendLocalTime: string };
  generator: string;
  warnings: string[];
  banner_svg: string;
}
interface JobView {
  id: string;
  name: string;
  cron: string;
  status: string;
  utc_offset_minutes: number;
  run_count: number;
  failure_count: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  recent_runs: { id: string; status: string; started_at: number; error: string | null; result: unknown }[];
}

const INDUSTRY_FA: Record<string, string> = {
  general: "عمومی", fashion: "پوشاک", food: "مواد غذایی", restaurant: "رستوران", electronics: "الکترونیک", beauty: "زیبایی",
  education: "آموزش", home: "خانه", travel: "سفر", health: "سلامت", kids: "کودک", jewelry: "جواهر", books: "کتاب", services: "خدمات",
};

/** SVG is rendered through <img src="data:…"> so any script inside it can never execute. */
function svgPreview(svg: string, alt: string) {
  return h("img", { class: "banner-preview", alt, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
}

export async function renderAutomation(main: HTMLElement, me: Me) {
  const canManage = can(me, "autopilot:manage");
  const canApprove = can(me, "autopilot:approve");
  const msg = h("div");
  const eventsEl = h("div", {}, h("p", { class: "muted" }, "در حال بارگذاری…"));
  const campaignsEl = h("div", {}, h("p", { class: "muted" }, "در حال بارگذاری…"));
  const jobsEl = h("div", {}, h("p", { class: "muted" }, "در حال بارگذاری…"));

  // Business profile used for manual drafts.
  const bizName = h("input", { type: "text", maxlength: 80, value: "رایان", required: true });
  const bizIndustry = h("select", {}, ...Object.entries(INDUSTRY_FA).map(([v, l]) => h("option", { value: v }, l)));
  const useLlm = h("input", { type: "checkbox" });
  const days = h("select", {}, ...[14, 30, 60, 120].map((d) => h("option", { value: String(d), selected: d === 60 }, `${num(d)} روز آینده`)));

  const loadEvents = async () => {
    const r = await api<{ events: EventView[] }>("GET", `/autopilot/events?days=${days.value}`);
    eventsEl.replaceChildren(
      dataTable(
        ["مناسبت", "تاریخ", "دسته", "وضعیت", ""],
        r.events.map((e) => {
          const actions: Node[] = [];
          if (canManage && e.promotion_allowed) {
            const b = h("button", { type: "button", class: "btn btn-small" }, "ساخت پیش‌نویس");
            b.addEventListener("click", () =>
              void withBusy(b, msg, async () => {
                await api("POST", "/autopilot/campaigns/draft", {
                  event_id: e.id,
                  business: { id: "default", name: bizName.value.trim() || "رایان", industry: bizIndustry.value },
                  use_llm: useLlm.checked,
                });
                msg.replaceChildren(alertBox(`پیش‌نویس کمپین «${e.title_fa}» ساخته شد و منتظر تأیید است.`, "ok"));
                await loadCampaigns();
              }),
            );
            actions.push(b);
          }
          return [
            h("strong", {}, e.title_fa),
            h("span", {}, e.jalali, h("br"), h("small", { class: "muted" }, ltrText(e.date)), e.approximate ? h("small", { class: "muted" }, " (تقریبی)") : null),
            text(e.category),
            e.promotion_allowed ? h("span", { class: "badge badge-ok" }, "مجاز برای کمپین") : h("span", { class: "badge badge-cancelled" }, "سوگواری — بدون تبلیغ"),
            h("div", { class: "row" }, ...actions),
          ];
        }),
      ),
    );
  };

  const loadCampaigns = async () => {
    const { campaigns } = await api<{ campaigns: CampaignView[] }>("GET", "/autopilot/campaigns");
    if (!campaigns.length) {
      campaignsEl.replaceChildren(h("p", { class: "muted" }, "هنوز پیش‌نویسی ساخته نشده است."));
      return;
    }
    campaignsEl.replaceChildren(
      h("div", { class: "campaigns" }, ...campaigns.map((c) => {
        const actions = h("div", { class: "row" });
        if (canApprove && c.status === "pending_approval") {
          const note = h("input", { type: "text", maxlength: 500, placeholder: "یادداشت (اختیاری)" });
          const ok = h("button", { type: "button", class: "btn btn-small btn-primary" }, "تأیید");
          const no = h("button", { type: "button", class: "btn btn-small btn-danger" }, "رد");
          const decide = (btn: HTMLButtonElement, kind: "approve" | "reject") =>
            void withBusy(btn, msg, async () => {
              await api("POST", `/autopilot/campaigns/${encodeURIComponent(c.id)}/${kind}`, note.value.trim() ? { note: note.value.trim() } : {});
              msg.replaceChildren(alertBox(kind === "approve" ? "تأیید ثبت شد. انتشار خودکار انجام نمی‌شود." : "پیش‌نویس رد شد.", "ok"));
              await loadCampaigns();
            });
          ok.addEventListener("click", () => decide(ok, "approve"));
          no.addEventListener("click", () => decide(no, "reject"));
          actions.append(note, ok, no);
        }
        return h("article", { class: "card stack" },
          svgPreview(c.banner_svg, `بنر ${c.event.titleFa}`),
          h("div", { class: "row" }, badge(c.status), h("strong", {}, c.event.titleFa), h("small", { class: "muted" }, c.event.jalaliDate),
            h("small", { class: "muted" }, `· ارتباط ${num(c.relevance.score)} · ${c.generator === "llm" ? "هوش مصنوعی" : "قالب"} · نسخهٔ ${num(c.version)}`)),
          h("h3", {}, c.copy.headline),
          h("p", {}, c.copy.body),
          h("p", { class: "muted" }, `دعوت به اقدام: ${c.copy.cta} · ${c.copy.hashtags.join(" ")}`),
          h("details", {}, h("summary", {}, "جزئیات"), h("p", {}, `پیامک: ${c.copy.sms}`),
            h("p", {}, `شروع: ${c.schedule.startDate} · ارسال پیشنهادی: ${c.schedule.suggestedSendDate} ${c.schedule.suggestedSendLocalTime}`),
            h("ul", {}, ...c.relevance.reasons.map((r) => h("li", {}, r)), ...c.warnings.map((w) => h("li", { class: "muted" }, w)))),
          actions);
      })),
    );
  };

  const loadJobs = async () => {
    const { jobs } = await api<{ jobs: JobView[] }>("GET", "/autopilot/jobs");
    jobsEl.replaceChildren(
      dataTable(
        ["کار", "کرون (تهران)", "وضعیت", "اجرا/خطا", "اجرای بعدی", "آخرین اجرا", ""],
        jobs.map((j) => {
          const actions: Node[] = [];
          if (canManage) {
            const mk = (label: string, action: string, cls = "btn btn-small") => {
              const b = h("button", { type: "button", class: cls }, label);
              b.addEventListener("click", () =>
                void withBusy(b, msg, async () => {
                  await api("POST", `/autopilot/jobs/${encodeURIComponent(j.id)}`, { action });
                  msg.replaceChildren(alertBox("انجام شد.", "ok"));
                  await Promise.all([loadJobs(), loadCampaigns()]);
                }),
              );
              return b;
            };
            actions.push(mk("اجرای اکنون", "run_now"), j.status === "active" ? mk("توقف", "pause") : mk("ادامه", "resume"));
          }
          const last = j.recent_runs[0];
          return [
            h("span", {}, h("strong", {}, j.name), h("br"), h("small", { class: "muted" }, ltrText(j.id))),
            ltrText(j.cron),
            badge(j.status),
            text(`${num(j.run_count)} / ${num(j.failure_count)}`),
            text(date(j.next_run_at)),
            last ? h("span", {}, badge(last.status), " ", text(date(last.started_at))) : text(null),
            h("div", { class: "row" }, ...actions),
          ];
        }),
      ),
    );
  };

  days.addEventListener("change", () => void loadEvents().catch((e) => eventsEl.replaceChildren(alertBox(errorMessage(e)))));

  main.append(
    h("section", {},
      h("h1", {}, "مرکز اتوماسیون"),
      h("p", { class: "muted" }, "مناسبت‌ها به وقت تهران محاسبه می‌شوند. پیش‌نویس‌ها همیشه «در انتظار تأیید» هستند و هیچ انتشار یا ارسالی خودکار انجام نمی‌شود."),
      msg,
      h("h2", {}, "مناسبت‌های پیش رو"),
      canManage
        ? h("div", { class: "row card" }, h("label", {}, "نام کسب‌وکار", bizName), h("label", {}, "حوزه", bizIndustry), h("label", { class: "switch" }, useLlm, "متن با هوش مصنوعی (از سهمیه)"), days)
        : h("div", { class: "row" }, days),
      eventsEl,
      h("h2", {}, "پیش‌نویس کمپین‌ها"),
      campaignsEl,
      h("h2", {}, "کارهای زمان‌بندی‌شده"),
      jobsEl,
    ),
  );
  const fail = (el: HTMLElement) => (e: unknown) => el.replaceChildren(alertBox(errorMessage(e)));
  await Promise.all([loadEvents().catch(fail(eventsEl)), loadCampaigns().catch(fail(campaignsEl)), loadJobs().catch(fail(jobsEl))]);
}
