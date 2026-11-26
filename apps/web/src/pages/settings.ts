/** «تنظیمات»: personalisation, theme, offline model, usage, data export/delete (old site: profile.html / settings.js). */
import type { Me } from "../api";
import { api, applyTheme, setTheme, type Prefs } from "../api";
import * as local from "../local-llm";
import { alertBox, date, errorMessage, h, num } from "../ui";
import { makeZip } from "../zip";
import { chatToMarkdown, saveBlob } from "./chat";

export async function renderSettings(main: HTMLElement, me: Me) {
  const out = h("div");
  main.append(h("h1", {}, "تنظیمات"), out);

  // personalisation
  const name = h("input", { maxlength: 40, placeholder: "مثلاً: تایماز" });
  const style = h(
    "select",
    {},
    h("option", { value: "balanced" }, "متعادل"),
    h("option", { value: "short" }, "کوتاه و خلاصه"),
    h("option", { value: "detailed" }, "مفصل و دقیق"),
  );
  const about = h("textarea", { rows: 3, maxlength: 300, placeholder: "دربارهٔ خودتان (اختیاری) — مثلاً شغل یا علاقه‌ها" });
  const saveP = h("button", { type: "button", class: "btn btn-primary" }, "ذخیرهٔ شخصی‌سازی");
  const pOut = h("div");
  let prefs: Prefs = {};
  try {
    prefs = (await api<{ prefs: Prefs }>("GET", "/me/prefs")).prefs;
  } catch (e) {
    out.append(alertBox(errorMessage(e)));
  }
  name.value = prefs.name ?? "";
  style.value = prefs.style ?? "balanced";
  about.value = prefs.about ?? "";
  saveP.onclick = async () => {
    saveP.disabled = true;
    try {
      prefs = { ...prefs, name: name.value.trim() || undefined, style: style.value as Prefs["style"], about: about.value.trim() || undefined };
      await api("PUT", "/me/prefs", prefs);
      pOut.replaceChildren(alertBox("ذخیره شد؛ در همهٔ پاسخ‌های بعدی اعمال می‌شود.", "ok"));
    } catch (e) {
      pOut.replaceChildren(alertBox(errorMessage(e)));
    } finally {
      saveP.disabled = false;
    }
  };
  const persona = h(
    "section",
    { class: "card stack" },
    h("h2", {}, "✨ شخصی‌سازی رایان"),
    h("p", { class: "muted" }, "رایان را متناسب با خودتان تنظیم کنید؛ در همهٔ پاسخ‌ها اعمال می‌شود."),
    h("label", {}, "اسم شما", name),
    h("label", {}, "سبک پاسخ‌ها", style),
    h("label", {}, "دربارهٔ شما", about),
    h("div", { class: "row" }, saveP),
    pOut,
  );

  // theme
  const cur = localStorage.getItem("rayan.theme") ?? prefs.theme ?? "system";
  const themeRow = h("div", { class: "row", role: "group", "aria-label": "پوسته" });
  for (const [v, label] of [
    ["light", "☀️ روشن"],
    ["dark", "🌙 تیره"],
    ["system", "🖥 مطابق سیستم"],
  ] as const) {
    const b = h("button", { type: "button", class: "btn", "aria-pressed": String(cur === v) }, label);
    b.onclick = () => {
      setTheme(v);
      themeRow.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      prefs = { ...prefs, theme: v };
      void api("PUT", "/me/prefs", prefs).catch(() => {});
    };
    themeRow.append(b);
  }
  const theme = h("section", { class: "card stack" }, h("h2", {}, "پوسته"), themeRow);

  // offline model
  const offOut = h("div");
  const meter = h("div", { class: "meter", hidden: true }, h("span", {}));
  const dl = h("button", { type: "button", class: "btn btn-primary" }, "⬇ دانلود برای استفادهٔ آفلاین (~۸۰۶ مگابایت)");
  const cancel = h("button", { type: "button", class: "btn", hidden: true }, "لغو");
  const rm = h("button", { type: "button", class: "btn btn-danger", hidden: true }, "حذف مدل از این دستگاه");
  const test = h("button", { type: "button", class: "btn", hidden: true }, "آزمایش مدل آفلاین");
  const offStatus = h("p", { class: "muted" }, "در حال بررسی…");
  let ac: AbortController | null = null;
  const refreshOff = async () => {
    if (!local.supported()) {
      offStatus.textContent = "این مرورگر از اجرای مدل در مرورگر (WebAssembly + Cache Storage) پشتیبانی نمی‌کند.";
      dl.hidden = true;
      return;
    }
    const s = await local.cacheStatus();
    offStatus.textContent = s.cached
      ? `✅ مدل آفلاین (Gemma 3 1B، ${num(Math.round(s.total / 1e6))} مگابایت) روی این دستگاه ذخیره است. در گفت‌وگو «📴 آفلاین در مرورگر» را انتخاب کنید؛ اگر سرور در دسترس نباشد هم خودکار استفاده می‌شود.`
      : s.bytes
        ? `بخشی از مدل دانلود شده است (${num(Math.round(s.bytes / 1e6))} از ${num(Math.round(s.total / 1e6))} مگابایت). برای ادامه دوباره دانلود کنید.`
        : "مدل آفلاین هنوز دانلود نشده است. پس از دانلود، رایان بدون اینترنت هم (با کیفیت کمتر) در همین مرورگر پاسخ می‌دهد.";
    dl.hidden = s.cached;
    rm.hidden = !s.bytes;
    test.hidden = !s.cached;
  };
  dl.onclick = async () => {
    ac = new AbortController();
    dl.disabled = true;
    cancel.hidden = false;
    meter.hidden = false;
    offOut.replaceChildren();
    try {
      await local.download((p) => {
        (meter.firstChild as HTMLElement).style.width = `${(p.got / p.total) * 100}%`;
        offStatus.textContent = `در حال دانلود: ${num(Math.round(p.got / 1e6))} از ${num(Math.round(p.total / 1e6))} مگابایت`;
      }, ac.signal);
      offOut.replaceChildren(alertBox("مدل آفلاین ذخیره شد.", "ok"));
    } catch (e) {
      offOut.replaceChildren(alertBox(ac.signal.aborted ? "دانلود لغو شد؛ بخش‌های دانلودشده نگه داشته شدند." : "دانلود ناموفق بود: " + errorMessage(e)));
    } finally {
      dl.disabled = false;
      cancel.hidden = true;
      meter.hidden = true;
      await refreshOff();
    }
  };
  cancel.onclick = () => ac?.abort();
  rm.onclick = async () => {
    await local.removeCached();
    offOut.replaceChildren(alertBox("مدل از این دستگاه حذف شد.", "ok"));
    await refreshOff();
  };
  test.onclick = async () => {
    test.disabled = true;
    const ans = h("p", { class: "prose" }, "بارگذاری مدل…");
    offOut.replaceChildren(ans);
    try {
      await local.chat([{ role: "user", content: "در یک جمله خودت را معرفی کن." }], { onText: (t) => (ans.textContent = t), maxTokens: 80 });
    } catch (e) {
      ans.replaceWith(alertBox(errorMessage(e)));
    } finally {
      test.disabled = false;
    }
  };
  const offline = h(
    "section",
    { class: "card stack" },
    h("h2", {}, "📴 مدل آفلاین در مرورگر"),
    offStatus,
    meter,
    h("div", { class: "row" }, dl, cancel, test, rm),
    offOut,
  );
  void refreshOff();

  // usage + data
  const stats = h("div", { class: "grid stats" });
  const dataOut = h("div");
  const exp = h("button", { type: "button", class: "btn" }, "⬇ خروجی همهٔ گفت‌وگوها (zip)");
  const delAll = h("button", { type: "button", class: "btn btn-danger" }, "حذف همهٔ گفت‌وگوها");
  exp.onclick = async () => {
    exp.disabled = true;
    try {
      const list = (await api<{ conversations: { id: string; title: string }[] }>("GET", "/conversations")).conversations;
      const files = [];
      for (const c of list) {
        const r = await api<{ messages: any[] }>("GET", `/conversations/${c.id}`);
        files.push({ name: `${c.title.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 50)}-${c.id.slice(0, 6)}.md`, data: chatToMarkdown(c.title, r.messages) });
      }
      saveBlob("rayan-chats.zip", makeZip(files) as BlobPart, "application/zip");
      dataOut.replaceChildren(alertBox(`${num(files.length)} گفت‌وگو در فایل zip ذخیره شد.`, "ok"));
    } catch (e) {
      dataOut.replaceChildren(alertBox(errorMessage(e)));
    } finally {
      exp.disabled = false;
    }
  };
  delAll.onclick = async () => {
    if (!confirm("همهٔ گفت‌وگوهای شما برای همیشه حذف شود؟")) return;
    try {
      const r = await api<{ deleted: number }>("DELETE", "/conversations");
      dataOut.replaceChildren(alertBox(`${num(r.deleted)} گفت‌وگو حذف شد.`, "ok"));
    } catch (e) {
      dataOut.replaceChildren(alertBox(errorMessage(e)));
    }
  };
  try {
    const s = (await api<{ stats: any }>("GET", "/me/stats")).stats;
    for (const [k, v] of [
      ["گفت‌وگو", num(s.conversations)],
      ["پیام شما", num(s.messages)],
      ["پاسخ رایان", num(s.answers)],
      ["بازخورد", num(s.feedback)],
      ["عضو از", date(s.since)],
    ])
      stats.append(h("div", { class: "card center" }, h("b", {}, v), h("div", { class: "muted small" }, k)));
  } catch {
    /* stats optional */
  }
  const data = h("section", { class: "card stack" }, h("h2", {}, "مصرف و داده‌های من"), h("p", { class: "muted" }, me.user.email), stats, h("div", { class: "row" }, exp, delAll), dataOut);

  out.append(persona, theme, offline, data);
  applyTheme();
}
