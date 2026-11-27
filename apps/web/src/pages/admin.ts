import { api, can, type Me } from "../api";
import { alertBox, date, errorMessage, h, num, statusFa, withBusy } from "../ui";

type Tab = { id: string; label: string; visible: boolean; render: (el: HTMLElement) => Promise<void> };

export async function renderAdmin(main: HTMLElement, me: Me, params = new URLSearchParams()) {
  // Gmail sending is owner-only: the tab exists only when the API confirms this account is the owner.
  let gmail: GmailStatus | null = null;
  if (can(me, "flags:manage")) gmail = await api<GmailStatus>("GET", "/admin/gmail/status").catch(() => null);
  const all: Tab[] = [
    { id: "users", label: "کاربران", visible: can(me, "users:read"), render: (el: HTMLElement) => usersTab(el, me) },
    { id: "agents", label: "عامل‌ها", visible: can(me, "agents:read"), render: (el: HTMLElement) => agentsTab(el, me) },
    { id: "tasks", label: "وظایف", visible: can(me, "tasks:read:all"), render: (el: HTMLElement) => tasksTab(el, me) },
    { id: "audit", label: "گزارش ممیزی", visible: can(me, "audit:read"), render: auditTab },
    { id: "usage", label: "مصرف و زمان‌بند", visible: can(me, "usage:read"), render: (el: HTMLElement) => usageTab(el, me) },
    { id: "support", label: "پشتیبانی", visible: can(me, "users:read"), render: (el: HTMLElement) => supportTab(el, me) },
    { id: "announce", label: "اعلان‌ها", visible: can(me, "flags:manage"), render: announceTab },
    { id: "gmail", label: "ایمیل (Gmail)", visible: !!gmail, render: (el: HTMLElement) => gmailTab(el, params) },
  ];
  const tabs = all.filter((t) => t.visible);

  const panel = h("div", { class: "tab-panel" });
  const bar = h("div", { class: "tabs", role: "tablist" });
  const open = async (tab: Tab) => {
    for (const b of bar.querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.id === tab.id));
    panel.replaceChildren(h("p", { class: "muted" }, "در حال بارگذاری…"));
    try {
      const el = h("div");
      await tab.render(el);
      panel.replaceChildren(el);
    } catch (e) {
      panel.replaceChildren(alertBox(errorMessage(e)));
    }
  };
  for (const t of tabs) {
    const b = h("button", { type: "button", role: "tab", class: "tab" }, t.label);
    b.dataset.id = t.id;
    b.addEventListener("click", () => void open(t));
    bar.append(b);
  }
  main.append(h("section", {}, h("h1", {}, "پنل مدیریت"), h("p", { class: "muted" }, `نقش‌های شما: ${me.roles.join("، ")}`), bar, panel));
  const want = params.get("gmail") ? tabs.find((t) => t.id === "gmail") : undefined;
  if (want ?? tabs[0]) void open((want ?? tabs[0])!);
}

function table(headers: string[], rows: Node[][]) {
  const body = rows.length
    ? rows.map((r) => h("tr", {}, ...r.map((cell) => h("td", {}, cell))))
    : [h("tr", {}, h("td", { colspan: headers.length, class: "muted center" }, "موردی یافت نشد."))];
  const head = h("thead", {}, h("tr", {}, ...headers.map((x) => h("th", {}, x))));
  return h("div", { class: "table-wrap" }, h("table", {}, head, h("tbody", {}, ...body)));
}
const txt = (s: unknown) => document.createTextNode(s === null || s === undefined ? "—" : String(s));
const ltr = (s: unknown) => h("bdi", { dir: "ltr" }, s === null || s === undefined ? "—" : String(s));

// ---------- Users ----------
interface UserRow { id: string; email: string; display_name: string | null; status: string; created_at: number; last_login_at: number | null; roles: string[] }

async function usersTab(el: HTMLElement, me: Me) {
  const { users } = await api<{ users: UserRow[] }>("GET", "/admin/users");
  const msg = h("div");
  const manage = can(me, "users:manage");
  const rows = users.map((u) => {
    const actions: Node[] = [];
    if (manage && u.id !== me.user.id && !u.roles.includes("super_admin")) {
      const isAdmin = u.roles.includes("admin");
      const b = h("button", { type: "button", class: "btn btn-small" }, isAdmin ? "لغو نقش مدیر" : "اعطای نقش مدیر");
      b.addEventListener("click", () =>
        withBusy(b, msg, async () => {
          await api("POST", `/admin/users/${u.id}/roles`, { role: "admin", action: isAdmin ? "revoke" : "grant" });
          await usersTab(el, me);
        }),
      );
      actions.push(b);
    }
    return [ltr(u.email), txt(u.display_name), txt(u.roles.join("، ")), txt(statusFa(u.status === "active" ? "ok" : "disabled")), txt(date(u.created_at)), txt(date(u.last_login_at)), h("span", {}, ...actions)];
  });
  el.replaceChildren(msg, table(["ایمیل", "نام", "نقش‌ها", "وضعیت", "عضویت", "آخرین ورود", ""], rows));
}

// ---------- Agents ----------
interface AgentRow { slug: string; name_fa: string; name_en: string; description: string; permissions: string[]; enabled: boolean; version: string }

async function agentsTab(el: HTMLElement, me: Me) {
  const { agents } = await api<{ agents: AgentRow[] }>("GET", "/agents");
  const msg = h("div");
  const manage = can(me, "agents:manage");
  const rows = agents.map((a) => {
    let control: Node = h("span", { class: `badge badge-${a.enabled ? "ok" : "disabled"}` }, a.enabled ? "فعال" : "غیرفعال");
    if (manage) {
      const cb = h("input", { type: "checkbox", "aria-label": `فعال بودن ${a.name_fa}` });
      cb.checked = a.enabled;
      cb.addEventListener("change", async () => {
        cb.disabled = true;
        msg.replaceChildren();
        try {
          const r = await api<{ agent: AgentRow }>("PATCH", `/agents/${a.slug}`, { enabled: cb.checked });
          cb.checked = r.agent.enabled;
          msg.replaceChildren(alertBox(`${a.name_fa} ${r.agent.enabled ? "فعال" : "غیرفعال"} شد.`, "ok"));
        } catch (e) {
          cb.checked = !cb.checked;
          msg.replaceChildren(alertBox(errorMessage(e)));
        } finally {
          cb.disabled = false;
        }
      });
      control = h("label", { class: "switch" }, cb, h("span", {}, "فعال"));
    }
    return [h("strong", {}, a.name_fa), h("bdi", { dir: "ltr", class: "nowrap" }, a.slug), txt(a.description), h("span", { class: "chips" }, ...a.permissions.map((p) => h("code", {}, p))), control];
  });
  const tools: Node[] = [];
  if (manage) {
    const sync = h("button", { type: "button", class: "btn btn-small" }, "همگام‌سازی با مانیفست‌ها");
    sync.addEventListener("click", () =>
      withBusy(sync, msg, async () => {
        const r = await api<{ synced: number }>("POST", "/agents/sync", {});
        await agentsTab(el, me);
        el.prepend(alertBox(`${num(r.synced)} مانیفست همگام شد.`, "ok"));
      }),
    );
    tools.push(sync);
  }
  el.replaceChildren(h("div", { class: "row" }, ...tools), msg, table(["عامل", "شناسه", "توضیح", "مجوزها", "وضعیت"], rows));
}

// ---------- Tasks ----------
interface TaskRow { id: string; type: string; status: string; attempts: number; max_attempts: number; error: string | null; result: unknown; created_at: number; finished_at: number | null; agent_slug: string | null }

async function tasksTab(el: HTMLElement, me: Me) {
  const { tasks } = await api<{ tasks: TaskRow[] }>("GET", "/tasks?scope=all&limit=100");
  const msg = h("div");
  const rows = tasks.map((t) => {
    const actions: Node[] = [];
    if ((t.status === "pending" || t.status === "running") && can(me, "tasks:cancel:all")) {
      const b = h("button", { type: "button", class: "btn btn-small btn-danger" }, "لغو");
      b.addEventListener("click", () =>
        withBusy(b, msg, async () => {
          await api("POST", `/tasks/${t.id}/cancel`, {});
          await tasksTab(el, me);
        }),
      );
      actions.push(b);
    }
    const detail = t.error ?? (t.result !== null ? JSON.stringify(t.result) : "");
    return [ltr(t.id.slice(0, 8)), ltr(t.type), h("span", { class: `badge badge-${t.status}` }, statusFa(t.status)), txt(`${num(t.attempts)} / ${num(t.max_attempts)}`), txt(date(t.created_at)), h("bdi", { dir: "auto", class: "clip" }, detail.slice(0, 160)), h("span", {}, ...actions)];
  });

  const create: Node[] = [];
  if (can(me, "tasks:create")) {
    const type = h("select", {}, h("option", { value: "echo" }, "echo (آزمایش صف)"), h("option", { value: "ai.prompt" }, "ai.prompt (پرسش از هوش مصنوعی)"));
    const payload = h("input", { type: "text", placeholder: "متن یا پرسش", maxlength: 4000 });
    const btn = h("button", { type: "submit", class: "btn btn-small btn-primary" }, "ایجاد وظیفه");
    const f = h("form", { class: "row" }, type, payload, btn);
    f.addEventListener("submit", (ev) => {
      ev.preventDefault();
      void withBusy(btn, msg, async () => {
        const p = type.value === "ai.prompt" ? { prompt: payload.value } : { text: payload.value };
        await api("POST", "/tasks", { type: type.value, payload: p });
        await tasksTab(el, me);
        el.prepend(alertBox("وظیفه در صف قرار گرفت و در اجرای بعدی زمان‌بند (هر ۱۵ دقیقه) پردازش می‌شود.", "ok"));
      });
    });
    create.push(f);
  }
  const refresh = h("button", { type: "button", class: "btn btn-small btn-ghost" }, "بازخوانی");
  refresh.addEventListener("click", () => withBusy(refresh, msg, () => tasksTab(el, me)));
  el.replaceChildren(...create, h("div", { class: "row" }, refresh), msg, table(["شناسه", "نوع", "وضعیت", "تلاش‌ها", "ایجاد", "نتیجه / خطا", ""], rows));
}

// ---------- Audit ----------
interface AuditRow { id: number; actor_email: string | null; action: string; target_type: string | null; target_id: string | null; ip: string | null; metadata: string | null; created_at: number }

async function auditTab(el: HTMLElement) {
  const { logs } = await api<{ logs: AuditRow[] }>("GET", "/admin/audit?limit=200");
  el.replaceChildren(
    table(
      ["زمان", "کاربر", "رویداد", "هدف", "IP", "جزئیات"],
      logs.map((l) => [txt(date(l.created_at)), ltr(l.actor_email), ltr(l.action), ltr(l.target_type ? `${l.target_type}:${l.target_id ?? ""}` : null), ltr(l.ip), ltr(l.metadata)]),
    ),
  );
}

// ---------- Usage, flags & scheduler ----------
interface UsageResp { today: { service: string; day: string; count: number; limit: number }; history: { service: string; day: string; count: number; limit: number }[] }
interface Flag { key: string; enabled: boolean; description_fa: string }
interface Job { name: string; last_run_at: number | null; last_status: string | null; last_error: string | null; last_duration_ms: number | null; run_count: number }

async function usageTab(el: HTMLElement, me: Me) {
  const [usage, flags, jobs] = await Promise.all([
    api<UsageResp>("GET", "/admin/usage"),
    api<{ flags: Flag[] }>("GET", "/admin/flags"),
    api<{ jobs: Job[] }>("GET", "/admin/scheduler"),
  ]);
  const msg = h("div");
  const t = usage.today;
  const pct = t.limit > 0 ? Math.min(100, Math.round((t.count / t.limit) * 100)) : 100;
  const fill = h("span");
  fill.style.width = `${pct}%`; // CSSOM, not an inline style attribute, so the strict CSP (style-src 'self') allows it
  const meter = h("div", { class: "meter", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": t.limit, "aria-valuenow": t.count }, fill);

  const limitControls: Node[] = [];
  if (can(me, "usage:manage")) {
    const inp = h("input", { type: "number", min: 0, max: 1000000, value: t.limit, dir: "ltr", class: "small-input" });
    const b = h("button", { type: "submit", class: "btn btn-small" }, "ذخیرهٔ سقف روزانه");
    const f = h("form", { class: "row" }, h("label", {}, "سقف روزانهٔ درخواست‌های هوش مصنوعی ", inp), b);
    f.addEventListener("submit", (ev) => {
      ev.preventDefault();
      void withBusy(b, msg, async () => {
        await api("PUT", `/admin/usage/${t.service}`, { limit: Number(inp.value) });
        await usageTab(el, me);
        el.prepend(alertBox("سقف مصرف به‌روزرسانی شد.", "ok"));
      });
    });
    limitControls.push(f);
  }

  const flagRows = flags.flags.map((f) => {
    let control: Node = h("span", { class: `badge badge-${f.enabled ? "ok" : "disabled"}` }, f.enabled ? "روشن" : "خاموش");
    if (can(me, "flags:manage")) {
      const cb = h("input", { type: "checkbox", "aria-label": f.description_fa });
      cb.checked = f.enabled;
      cb.addEventListener("change", async () => {
        cb.disabled = true;
        msg.replaceChildren();
        try {
          await api("PUT", `/admin/flags/${f.key}`, { enabled: cb.checked });
        } catch (e) {
          cb.checked = !cb.checked;
          msg.replaceChildren(alertBox(errorMessage(e)));
        } finally {
          cb.disabled = false;
        }
      });
      control = h("label", { class: "switch" }, cb, h("span", {}, "روشن"));
    }
    return [ltr(f.key), txt(f.description_fa), control];
  });

  el.replaceChildren(
    msg,
    h("div", { class: "card" }, h("h3", {}, "مصرف امروز (UTC ", ltr(t.day), ")"), h("p", {}, `${num(t.count)} از ${num(t.limit)} درخواست Workers AI`), meter, ...limitControls),
    h("h3", {}, "تاریخچهٔ مصرف"),
    table(["سرویس", "روز", "مصرف", "سقف"], usage.history.map((r) => [ltr(r.service), ltr(r.day), txt(num(r.count)), txt(num(r.limit))])),
    h("h3", {}, "پرچم‌های قابلیت"),
    table(["کلید", "توضیح", "وضعیت"], flagRows),
    h("h3", {}, "زمان‌بند (Cron هر ۱۵ دقیقه)"),
    table(
      ["کار", "آخرین اجرا", "وضعیت", "مدت (ms)", "تعداد اجرا", "خطا"],
      jobs.jobs.map((j) => [ltr(j.name), txt(date(j.last_run_at)), h("span", { class: `badge badge-${j.last_status ?? "unknown"}` }, statusFa(j.last_status ?? "never_run")), txt(num(j.last_duration_ms)), txt(num(j.run_count)), ltr(j.last_error)]),
    ),
  );
}

async function supportTab(el: HTMLElement, me: Me) {
  const r = await api<{ tickets: { id: string; body: string; reply: string | null; status: string; created_at: number; email: string }[] }>("GET", "/admin/support");
  const canReply = can(me, "users:manage");
  const list = h("div", { class: "stack" });
  if (!r.tickets.length) list.append(h("p", { class: "muted" }, "پیامی در صندوق پشتیبانی نیست."));
  for (const t of r.tickets) {
    const out = h("div");
    const card = h(
      "div",
      { class: "card stack" },
      h("div", { class: "row" }, h("bdi", { dir: "ltr" }, t.email), h("span", { class: `badge badge-${t.status === "open" ? "pending" : "ok"}` }, t.status === "open" ? "باز" : t.status === "answered" ? "پاسخ داده شد" : "بسته"), h("small", { class: "muted" }, date(t.created_at))),
      h("p", { class: "prose", dir: "auto" }, t.body),
      t.reply ? h("p", { class: "muted", dir: "auto" }, "↩ ", t.reply) : null,
      out,
    );
    if (canReply) {
      const ta = h("textarea", { rows: 2, maxlength: 2000, placeholder: "پاسخ به کاربر…" });
      const send = h("button", { type: "button", class: "btn btn-primary btn-small" }, "ارسال پاسخ");
      const close = h("label", { class: "switch" }, h("input", { type: "checkbox" }), "بستن تیکت");
      send.onclick = () =>
        withBusy(send, out, async () => {
          if (!ta.value.trim()) return;
          await api("POST", `/admin/support/${t.id}/reply`, { reply: ta.value.trim(), close: (close.firstChild as HTMLInputElement).checked });
          out.replaceChildren(alertBox("پاسخ ثبت شد؛ کاربر آن را در «پشتیبانی» می‌بیند.", "ok"));
        });
      card.append(ta, h("div", { class: "row" }, send, close));
    }
    list.append(card);
  }
  el.append(h("h2", {}, "صندوق پشتیبانی"), list);
}

async function announceTab(el: HTMLElement) {
  const out = h("div");
  const list = h("div", { class: "stack" });
  const ta = h("textarea", { rows: 2, maxlength: 500, placeholder: "متن اعلان برای همهٔ کاربران…" });
  const add = h("button", { type: "button", class: "btn btn-primary" }, "انتشار اعلان");
  const load = async () => {
    const r = await api<{ announcements: { id: string; body: string; active: number; created_at: number }[] }>("GET", "/admin/announcements");
    list.replaceChildren(
      ...(r.announcements.length
        ? r.announcements.map((a) => {
            const tg = h("button", { type: "button", class: "btn btn-small" }, a.active ? "غیرفعال کن" : "فعال کن");
            tg.onclick = () =>
              withBusy(tg, out, async () => {
                await api("PATCH", `/admin/announcements/${a.id}`, { active: !a.active });
                await load();
              });
            return h("div", { class: "row card" }, h("span", { class: `badge badge-${a.active ? "active" : "archived"}` }, a.active ? "فعال" : "غیرفعال"), h("span", { dir: "auto" }, a.body), h("small", { class: "muted" }, date(a.created_at)), tg);
          })
        : [h("p", { class: "muted" }, "اعلانی ثبت نشده است.")]),
    );
  };
  add.onclick = () =>
    withBusy(add, out, async () => {
      if (ta.value.trim().length < 2) return;
      await api("POST", "/admin/announcements", { body: ta.value.trim() });
      ta.value = "";
      out.replaceChildren(alertBox("اعلان منتشر شد و بالای همهٔ صفحه‌ها نمایش داده می‌شود.", "ok"));
      await load();
    });
  el.append(h("h2", {}, "اعلان‌های سایت"), ta, h("div", { class: "row" }, add), out, list);
  await load();
}

interface GmailStatus {
  provider: string;
  configured: boolean;
  gmail_connected: boolean;
  sender: string | null;
  google_client: boolean;
}
const GMAIL_RESULT: Record<string, [string, "ok" | "error"]> = {
  connected: ["Gmail وصل شد؛ ایمیل‌های رایان از این حساب ارسال می‌شود.", "ok"],
  wrong_account: ["فقط حساب گوگلِ مالک (OWNER_EMAIL) می‌تواند Gmail را وصل کند.", "error"],
  no_refresh_token: ["گوگل توکن دسترسی آفلاین نداد؛ دوباره «اتصال» را بزنید و همهٔ دسترسی‌ها را تأیید کنید.", "error"],
};

async function gmailTab(el: HTMLElement, params: URLSearchParams) {
  const out = h("div");
  const r = params.get("gmail");
  if (r && GMAIL_RESULT[r]) out.append(alertBox(GMAIL_RESULT[r]![0], GMAIL_RESULT[r]![1]));
  const s = await api<GmailStatus>("GET", "/admin/gmail/status");
  const rows: [string, string][] = [
    ["سرویس ارسال", s.provider === "gmail" ? "Gmail API" : s.provider],
    ["وضعیت", s.configured ? "✅ آمادهٔ ارسال" : "⛔ هنوز وصل نشده"],
    ["فرستنده", s.sender ?? "—"],
    ["کلاینت OAuth گوگل", s.google_client ? "پیکربندی شده" : "پیکربندی نشده"],
  ];
  const actions = h("div", { class: "row" });
  if (s.google_client)
    actions.append(h("a", { class: "btn btn-primary", href: "/api/admin/gmail/connect" }, s.gmail_connected ? "اتصال دوباره به Gmail" : "اتصال Gmail (ارسال به‌نام مالک)"));
  if (s.gmail_connected) {
    const dis = h("button", { type: "button", class: "btn btn-danger" }, "قطع اتصال");
    dis.onclick = () =>
      withBusy(dis, out, async () => {
        await api("POST", "/admin/gmail/disconnect", {});
        out.replaceChildren(alertBox("اتصال Gmail حذف شد.", "ok"));
      });
    actions.append(dis);
  }
  el.append(
    h("h2", {}, "ارسال ایمیل با Gmail"),
    h("p", { class: "muted" }, "کدهای تأیید و ایمیل‌های ایجنت‌ها از حساب Gmail مالک فرستاده می‌شوند (سقف روزانهٔ ۴۵۰ ایمیل). توکن به‌صورت رمزنگاری‌شده در D1 نگه‌داری می‌شود و هرگز نمایش داده نمی‌شود."),
    h("div", { class: "table-wrap" }, h("table", {}, h("tbody", {}, ...rows.map(([k, v]) => h("tr", {}, h("th", {}, k), h("td", {}, v)))))),
    actions,
    out,
  );
}
