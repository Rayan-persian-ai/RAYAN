/** Task Center, Agent Workspace and Content Studio — all backed by real /api calls (no mock data). */
import { api, can, type Me } from "../api";
import { alertBox, badge, dataTable, date, errorMessage, h, ltrText, num, text, withBusy } from "../ui";

export interface StepView {
  id: string;
  title: string;
  capability: string;
  agent: string | null;
  tools: string[];
  depends_on: string[];
  status: string;
  attempts: number;
  error: string | null;
  output: string | null;
}
export interface ApprovalView {
  id: string;
  agent_slug: string;
  action: string;
  level: "guarded" | "restricted";
  input_preview: string | null;
  reason: string | null;
  goal: string | null;
  status: string;
  approved_by: string | null;
  created_at: number;
  expires_at: number;
}
export interface RunView {
  request_id: string;
  status: string;
  intent: { intent: string; confidence: number; source: string };
  plan: { id: string; source: string; steps: StepView[] } | null;
  output: string;
  evaluation: { score: number; passed: boolean } | null;
  guard_flags: string[];
  errors: string[];
  duration_ms: number;
  approvals: ApprovalView[];
}

const INTENT_FA: Record<string, string> = {
  chat: "گفت‌وگو", code: "برنامه‌نویسی", research: "پژوهش", content: "تولید محتوا",
  image: "تصویر", automation: "اتوماسیون", admin: "مدیریت", analysis: "تحلیل",
};

// ---------------- Task Center ----------------
interface TaskRow {
  id: string;
  type: string;
  status: string;
  payload: { goal?: string } | null;
  result: { status?: string; output?: string; approvals?: { id: string }[] } | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  created_at: number;
  finished_at: number | null;
}

export async function renderTaskCenter(main: HTMLElement, me: Me) {
  const msg = h("div");
  const listEl = h("div", {}, h("p", { class: "muted" }, "در حال بارگذاری…"));
  const goal = h("textarea", { rows: 3, maxlength: 2000, required: true, placeholder: "هدف را بنویسید؛ مثلاً: یک مقالهٔ کوتاه دربارهٔ صرفه‌جویی انرژی در زمستان بنویس" });
  const statusSel = h("select", {}, ...["", "pending", "running", "succeeded", "failed", "cancelled"].map((s) => h("option", { value: s }, s ? s : "همهٔ وضعیت‌ها")));
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, "افزودن به صف");
  const refresh = h("button", { type: "button", class: "btn btn-ghost" }, "به‌روزرسانی");
  const form = h("form", { class: "form card" }, h("label", {}, "هدف وظیفهٔ Cortex (در صف Cron اجرا می‌شود)", goal), h("div", { class: "row" }, submit, refresh, statusSel));

  const load = async () => {
    const qs = statusSel.value ? `&status=${encodeURIComponent(statusSel.value)}` : "";
    const { tasks } = await api<{ tasks: TaskRow[] }>("GET", `/tasks?limit=50${qs}`);
    const rows = tasks.map((t) => {
      const actions: Node[] = [];
      if (t.status === "pending" || t.status === "running") {
        const b = h("button", { type: "button", class: "btn btn-small btn-danger" }, "لغو");
        b.addEventListener("click", () =>
          void withBusy(b, msg, async () => {
            await api("POST", `/tasks/${t.id}/cancel`, {});
            msg.replaceChildren(alertBox("وظیفه لغو شد.", "ok"));
            await load();
          }),
        );
        actions.push(b);
      }
      const res = t.result;
      const summary = res?.status
        ? h("div", {}, badge(res.status), res.approvals?.length ? h("small", { class: "muted" }, ` · ${num(res.approvals.length)} درخواست تأیید`) : null, res.output ? h("div", { class: "clip", title: res.output }, res.output) : null)
        : t.error
          ? h("span", { class: "clip", title: t.error }, t.error)
          : text(null);
      return [
        ltrText(t.type),
        h("span", { class: "clip", title: t.payload?.goal ?? "" }, t.payload?.goal ?? JSON.stringify(t.payload ?? {})),
        badge(t.status),
        text(`${num(t.attempts)}/${num(t.max_attempts)}`),
        summary,
        text(date(t.created_at)),
        h("div", { class: "row" }, ...actions),
      ];
    });
    listEl.replaceChildren(dataTable(["نوع", "هدف/ورودی", "وضعیت", "تلاش", "نتیجه", "ایجاد", ""], rows));
  };

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void withBusy(submit, msg, async () => {
      await api("POST", "/tasks", { type: "cortex.run", payload: { goal: goal.value.trim() } });
      goal.value = "";
      msg.replaceChildren(alertBox("وظیفه در صف قرار گرفت؛ زمان‌بند هر ۱۵ دقیقه آن را اجرا می‌کند.", "ok"));
      await load();
    });
  });
  refresh.addEventListener("click", () => void withBusy(refresh, msg, load));
  statusSel.addEventListener("change", () => void load().catch((e) => msg.replaceChildren(alertBox(errorMessage(e)))));

  main.append(
    h("section", {}, h("h1", {}, "مرکز وظایف"), h("p", { class: "muted" }, "وظایف شما در صف؛ وظایف «cortex.run» با همان خط لولهٔ فضای کاری عامل‌ها اجرا می‌شوند."),
      can(me, "tasks:create") ? form : alertBox("اجازهٔ ایجاد وظیفه ندارید.", "info"), msg, listEl),
  );
  await load().catch((e) => listEl.replaceChildren(alertBox(errorMessage(e))));
}

// ---------------- Agent Workspace ----------------
export function renderRun(run: RunView, onDecision?: () => void): HTMLElement {
  const steps = run.plan?.steps ?? [];
  const msg = h("div");
  const approvals = run.approvals.map((a) => approvalCard(a, msg, onDecision));
  return h(
    "div",
    { class: "card stack" },
    h("div", { class: "row" }, badge(run.status), h("span", {}, `نیت: ${INTENT_FA[run.intent.intent] ?? run.intent.intent}`),
      h("small", { class: "muted" }, `اطمینان ${num(Math.round(run.intent.confidence * 100))}٪ · ${num(run.duration_ms)} میلی‌ثانیه`),
      run.evaluation ? h("small", { class: "muted" }, `امتیاز ارزیابی ${num(Math.round(run.evaluation.score * 100))}`) : null),
    steps.length
      ? h("ol", { class: "steps" }, ...steps.map((s) =>
          h("li", {}, h("div", { class: "row" }, badge(s.status), h("strong", {}, s.title), h("small", { class: "muted" }, " · "), ltrText(s.capability),
            h("small", { class: "muted" }, ` · عامل: `), ltrText(s.agent ?? "—"), s.tools.length ? h("small", { class: "muted" }, ` · ابزار: ${s.tools.join("، ")}`) : null),
            s.error ? h("div", { class: "alert alert-error" }, s.error) : null,
            s.output ? h("details", {}, h("summary", {}, "خروجی مرحله"), h("div", { class: "prose" }, s.output)) : null)))
      : null,
    approvals.length ? h("div", {}, h("h3", {}, "درخواست‌های تأیید"), ...approvals) : null,
    msg,
    run.output ? h("div", {}, h("h3", {}, "خروجی نهایی"), h("div", { class: "prose" }, run.output)) : null,
    run.errors.length ? h("details", {}, h("summary", {}, `خطاها (${num(run.errors.length)})`), h("ul", {}, ...run.errors.map((e) => h("li", {}, e)))) : null,
    run.guard_flags.length ? alertBox(`هشدار محافظ: ${run.guard_flags.join("، ")}`, "info") : null,
  );
}

function approvalCard(a: ApprovalView, msg: HTMLElement, onDecision?: () => void) {
  const actions = h("div", { class: "row" });
  if (a.status === "pending") {
    const ok = h("button", { type: "button", class: "btn btn-small btn-primary" }, "تأیید");
    const no = h("button", { type: "button", class: "btn btn-small btn-danger" }, "رد");
    const decide = (btn: HTMLButtonElement, kind: "approve" | "reject") =>
      void withBusy(btn, msg, async () => {
        await api("POST", `/cortex/approvals/${a.id}/${kind}`, {});
        msg.replaceChildren(alertBox(kind === "approve" ? "تأیید شد. همان هدف را دوباره اجرا کنید تا اقدام یک بار انجام شود." : "درخواست رد شد.", "ok"));
        onDecision?.();
      });
    ok.addEventListener("click", () => decide(ok, "approve"));
    no.addEventListener("click", () => decide(no, "reject"));
    actions.append(ok, no);
  }
  return h("div", { class: "approval" },
    h("div", { class: "row" }, badge(a.status), badge(a.level), ltrText(a.action), h("small", { class: "muted" }, " · عامل "), ltrText(a.agent_slug)),
    a.reason ? h("small", { class: "muted" }, a.reason) : null,
    a.input_preview ? h("pre", { class: "preview", dir: "ltr" }, a.input_preview) : null,
    actions);
}

export async function renderWorkspace(main: HTMLElement, _me: Me) {
  const goal = h("textarea", { rows: 3, maxlength: 2000, required: true, placeholder: "مثلاً: دربارهٔ تاریخچهٔ نوروز تحقیق کن · یک پست برای شب یلدا بنویس · گزارش را هر روز خودکار زمان‌بندی کن" });
  const url = h("input", { type: "url", placeholder: "اختیاری: آدرس https برای ابزار web.fetch", dir: "ltr" });
  const send = h("button", { type: "submit", class: "btn btn-primary" }, "اجرا");
  const out = h("div");
  const msg = h("div");
  const pending = h("div");
  const history = h("div");

  const loadSide = async () => {
    const [{ approvals }, { runs }] = await Promise.all([
      api<{ approvals: ApprovalView[] }>("GET", "/cortex/approvals?status=pending"),
      api<{ runs: { id: string; goal: string; intent: string; status: string; created_at: number }[] }>("GET", "/cortex/runs?limit=10"),
    ]);
    pending.replaceChildren(h("h3", {}, "در انتظار تأیید"), approvals.length ? h("div", {}, ...approvals.map((a) => approvalCard(a, msg, () => void loadSide()))) : h("p", { class: "muted" }, "موردی نیست."));
    history.replaceChildren(h("h3", {}, "اجراهای اخیر"), dataTable(["هدف", "نیت", "وضعیت", "زمان"], runs.map((r) => [h("span", { class: "clip", title: r.goal }, r.goal), text(INTENT_FA[r.intent] ?? r.intent), badge(r.status), text(date(r.created_at))])));
  };

  const form = h("form", { class: "form card" }, h("label", {}, "هدف خود را برای عامل‌ها بنویسید", goal), h("label", {}, "ورودی ابزار (اختیاری)", url), h("div", { class: "row" }, send));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void withBusy(send, msg, async () => {
      out.replaceChildren(h("p", { class: "muted" }, "عامل‌ها در حال کار هستند…"));
      const body: Record<string, unknown> = { goal: goal.value.trim() };
      if (url.value.trim()) body.tool_inputs = { "web.fetch": { url: url.value.trim() } };
      try {
        const run = await api<RunView>("POST", "/cortex/run", body);
        out.replaceChildren(renderRun(run, () => void loadSide()));
      } catch (e) {
        out.replaceChildren();
        throw e;
      }
      await loadSide();
    });
  });

  main.append(h("section", {}, h("h1", {}, "فضای کاری عامل‌ها"),
    h("p", { class: "muted" }, "Cortex هدف را دسته‌بندی، برنامه‌ریزی (DAG) و بین عامل‌های فعال تقسیم می‌کند. اقدام‌های حساس فقط پس از تأیید شما (یا مالک) اجرا می‌شوند."),
    form, msg, out, h("div", { class: "grid" }, h("div", { class: "card" }, pending), h("div", { class: "card" }, history))));
  await loadSide().catch((e) => pending.replaceChildren(alertBox(errorMessage(e))));
}

// ---------------- Content Studio ----------------
export function renderContentStudio(main: HTMLElement, _me: Me) {
  const kind = h("select", {}, h("option", { value: "article" }, "مقاله"), h("option", { value: "post" }, "پست شبکهٔ اجتماعی"), h("option", { value: "ad" }, "متن تبلیغاتی"));
  const tone = h("select", {}, h("option", { value: "friendly" }, "صمیمی"), h("option", { value: "formal" }, "رسمی"));
  const topic = h("input", { type: "text", maxlength: 500, required: true, placeholder: "موضوع؛ مثلاً: تخفیف زمستانی کتاب‌فروشی" });
  const audience = h("input", { type: "text", maxlength: 200, placeholder: "مخاطب (اختیاری)" });
  const go = h("button", { type: "submit", class: "btn btn-primary" }, "تولید پیش‌نویس");
  const msg = h("div");
  const out = h("div");
  const form = h("form", { class: "form card" },
    h("div", { class: "row" }, h("label", {}, "نوع", kind), h("label", {}, "لحن", tone)),
    h("label", {}, "موضوع", topic), h("label", {}, "مخاطب", audience), h("div", { class: "row" }, go));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void withBusy(go, msg, async () => {
      out.replaceChildren(h("p", { class: "muted" }, "در حال نگارش (طرح کلی ← پیش‌نویس ← ویرایش)…"));
      const body: Record<string, unknown> = { kind: kind.value, topic: topic.value.trim(), tone: tone.value };
      if (audience.value.trim()) body.audience = audience.value.trim();
      try {
        const r = await api<RunView & { draft: string }>("POST", "/cortex/content", body);
        const copy = h("button", { type: "button", class: "btn btn-small" }, "کپی متن");
        copy.addEventListener("click", () => void navigator.clipboard?.writeText(r.draft).then(() => (copy.textContent = "کپی شد")));
        out.replaceChildren(
          h("div", { class: "card stack" }, h("div", { class: "row" }, badge(r.status), h("small", { class: "muted" }, "پیش‌نویس — منتشر نمی‌شود"), copy),
            r.draft ? h("div", { class: "prose" }, r.draft) : alertBox("خروجی خالی بود.", "info"),
            r.errors.length ? h("details", {}, h("summary", {}, "خطاها"), h("ul", {}, ...r.errors.map((e) => h("li", {}, e)))) : null),
        );
      } catch (e) {
        out.replaceChildren();
        throw e;
      }
    });
  });
  main.append(h("section", {}, h("h1", {}, "استودیو محتوا"), h("p", { class: "muted" }, "تولید پیش‌نویس مقاله، پست یا متن تبلیغاتی با عامل «تولید محتوا». هر پیش‌نویس سه فراخوانی AI از سهمیهٔ روزانه مصرف می‌کند."), form, msg, out));
}
