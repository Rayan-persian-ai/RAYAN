/**
 * RAYAN chat — parity with the old Space's chat.html/chat.js on the Worker + D1 stack:
 * conversation history (search / rename / delete / delete-all), streaming answers with stop,
 * regenerate and edit-message, web search (Persian Wikipedia) with sources, «تفکر عمیق»,
 * image generation (Pollinations), voice input + read-aloud, emoji picker, Markdown with code
 * highlighting / copy / download / live HTML preview / zip / Word / PDF, clarifying question boxes,
 * 👍/👎 feedback, share links, Markdown export, keyboard shortcuts, support inbox, and the in-browser
 * offline model (wllama + Gemma 3 1B) as a manual engine or automatic fallback.
 */
import type { Me } from "../api";
import { api, ApiError, apiStream } from "../api";
import { markdownToDocx } from "../docx";
import * as local from "../local-llm";
import { highlight, plainText, renderMarkdown, type CodeFile, type Question } from "../markdown";
import { readSse } from "../sse";
import { alertBox, errorMessage, h, num } from "../ui";
import { makeZip } from "../zip";

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  meta: Record<string, any> | null;
  rating: number | null;
}
interface Conv {
  id: string;
  title: string;
  share_id: string | null;
  updated_at: number;
}

const LS = "rayan.chat.settings.v1";
const S: { search: boolean; deep: boolean; image: boolean; size: string; engine: "server" | "local"; side: boolean } = Object.assign(
  { search: true, deep: false, image: false, size: "square", engine: "server", side: true },
  JSON.parse(localStorage.getItem(LS) ?? "{}"),
);
const saveS = () => localStorage.setItem(LS, JSON.stringify(S));

const EMOJI = "😊 😂 🥰 😍 🤔 😎 🙏 👍 👏 🎉 ❤️ 🔥 ✨ 🌹 🌙 ☀️ 🌧️ 📚 💡 🧠 💻 📱 🎨 🎵 ⚽ 🍵 🍎 🚀 ✅ ❌ ⚠️ 🇮🇷".split(" ");
const SHORTCUTS: [string, string][] = [
  ["Ctrl + Shift + O", "گفت‌وگوی جدید"],
  ["Ctrl + K", "جست‌وجو در گفت‌وگوها"],
  ["Ctrl + Shift + S", "باز/بسته کردن نوار کناری"],
  ["Ctrl + Shift + C", "کپی آخرین پاسخ"],
  ["Ctrl + Shift + E", "خروجی Markdown گفت‌وگو"],
  ["/", "رفتن به کادر پیام"],
  ["Enter · Shift + Enter", "ارسال · خط جدید"],
  ["Esc", "توقف پاسخ / بستن پنجره"],
  ["?", "نمایش میان‌برها"],
];

const SpeechRec: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
const safeName = (s: string) => (s || "rayan-chat").replace(/[\\/:*?"<>|\n\r]+/g, " ").trim().slice(0, 60) || "rayan-chat";

export function saveBlob(name: string, data: BlobPart, type: string) {
  const a = h("a", { href: URL.createObjectURL(new Blob([data], { type })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}

export function chatToMarkdown(title: string, msgs: Msg[]): string {
  return (
    `# ${title}\n\n` +
    msgs
      .map((m) => `**${m.role === "user" ? "شما" : "رایان"}:**\n\n${m.meta?.image ? `![${m.meta.image.prompt}](${m.meta.image.url})` : m.content}`)
      .join("\n\n---\n\n") +
    "\n"
  );
}

export async function renderChat(main: HTMLElement, me: Me) {
  main.classList.add("chat-main");
  let convs: Conv[] = [];
  let currentId: string | null = null;
  let msgs: Msg[] = [];
  let busy = false;
  let abort: AbortController | null = null;
  let filter = "";
  let localReady = false;

  // ---------- layout ----------
  const status = h("div", { class: "status", role: "status" });
  const setStatus = (s: string, err = false) => {
    status.textContent = s;
    status.classList.toggle("err", err);
  };
  const histSearch = h("input", { type: "search", placeholder: "جست‌وجو در گفت‌وگوها…", "aria-label": "جست‌وجو در گفت‌وگوها" });
  const histList = h("nav", { class: "hist", "aria-label": "گفت‌وگوها" });
  const newBtn = h("button", { type: "button", class: "btn btn-primary btn-block", title: "Ctrl+Shift+O" }, "＋ گفت‌وگوی جدید");
  const imgSideBtn = h("button", { type: "button", class: "btn btn-ghost btn-block" }, "🎨 ساخت تصویر");
  const clearAll = h("button", { type: "button", class: "btn btn-ghost btn-small btn-danger" }, "پاک کردن همه");
  const keysBtn = h("button", { type: "button", class: "btn btn-ghost btn-small" }, "میان‌برها");
  const supBtn = h("button", { type: "button", class: "btn btn-ghost btn-small" }, "پشتیبانی");
  const isMobile = () => matchMedia("(max-width: 860px)").matches;
  const sideClose = h("button", { type: "button", class: "icon-btn side-close", "aria-label": "بستن نوار کناری" }, "✕");
  const side = h(
    "aside",
    { class: "side" },
    sideClose,
    newBtn,
    imgSideBtn,
    histSearch,
    histList,
    h("div", { class: "side-foot" }, supBtn, keysBtn, h("a", { class: "btn btn-ghost btn-small", href: "#/settings" }, "تنظیمات"), clearAll),
  );
  const toggleSide = h("button", { type: "button", class: "btn btn-ghost btn-small", title: "نوار کناری (Ctrl+Shift+S)", "aria-label": "نوار کناری" }, "☰");
  const title = h("h1", { class: "chat-title" }, "گفت‌وگو با رایان");
  const shareBtn = h("button", { type: "button", class: "btn btn-ghost btn-small", hidden: true }, "اشتراک‌گذاری");
  const exportBtn = h("button", { type: "button", class: "btn btn-ghost btn-small", hidden: true, title: "Ctrl+Shift+E" }, "خروجی Markdown");
  const top = h("div", { class: "chat-top" }, toggleSide, title, h("div", { class: "row" }, shareBtn, exportBtn));

  const thread = h("div", { class: "thread", role: "log", "aria-live": "polite" });
  const welcome = h(
    "div",
    { class: "welcome" },
    h("img", { src: "/brand/orb.png", alt: "", width: 96, height: 96, class: "welcome-orb" }),
    h("h2", {}, `سلام ${me.user.display_name ?? ""}! امروز چه کمکی از دستم برمی‌آید؟`),
  );
  const chips = h("div", { class: "chips welcome-chips" });
  for (const [label, q, img] of [
    ["✍️ یک ایمیل اداری بنویس", "یک ایمیل اداری کوتاه و مؤدبانه برای درخواست مرخصی یک‌روزه بنویس.", false],
    ["💻 یک صفحهٔ وب بساز", "یک صفحهٔ فرود ساده و زیبا برای یک کافه به فارسی بساز.", false],
    ["📊 جدول مقایسه", "تفاوت‌های انرژی خورشیدی و بادی را در یک جدول مقایسه کن.", false],
    ["🎨 ساخت تصویر", "منظرهٔ کویر لوت در غروب با شترها", true],
  ] as [string, string, boolean][]) {
    chips.append(
      h("button", {
        type: "button",
        class: "btn btn-ghost btn-small",
        onclick: () => {
          setImageMode(img);
          void ask(q);
        },
      }, label),
    );
  }
  welcome.append(chips);
  const scroll = h("div", { class: "scroll" }, welcome, thread);

  const input = h("textarea", { rows: 1, maxlength: 4000, placeholder: "پیام خود را بنویسید…", "aria-label": "پیام" });
  const send = h("button", { type: "submit", class: "btn btn-primary", disabled: true }, "ارسال");
  const stop = h("button", { type: "button", class: "btn btn-danger", hidden: true }, "■ توقف");
  const tSearch = h("button", { type: "button", class: "toggle", "aria-pressed": String(S.search), title: "جست‌وجو در ویکی‌پدیای فارسی برای پرسش‌های واقعی" }, "🔎 جست‌وجو");
  const tDeep = h("button", { type: "button", class: "toggle", "aria-pressed": String(S.deep), title: "پاسخ دقیق‌تر و مفصل‌تر" }, "🧠 تفکر عمیق");
  const tImage = h("button", { type: "button", class: "toggle", "aria-pressed": String(S.image) }, "🎨 ساخت تصویر");
  const imgSize = h(
    "select",
    { "aria-label": "اندازهٔ تصویر", class: "small-select" },
    h("option", { value: "square" }, "مربع"),
    h("option", { value: "wide" }, "افقی"),
    h("option", { value: "tall" }, "عمودی"),
  );
  imgSize.value = S.size;
  const engineSel = h(
    "select",
    { "aria-label": "موتور پاسخ", class: "small-select", hidden: true },
    h("option", { value: "server" }, "☁️ رایان (سرور)"),
    h("option", { value: "local" }, "📴 آفلاین در مرورگر"),
  );
  const emojiBtn = h("button", { type: "button", class: "icon-btn", "aria-label": "شکلک", title: "شکلک" }, "😊");
  const emojiPanel = h("div", { class: "emoji-panel", hidden: true });
  for (const e of EMOJI) emojiPanel.append(h("button", { type: "button" }, e));
  const micBtn = SpeechRec ? h("button", { type: "button", class: "icon-btn", "aria-label": "ورودی صوتی", title: "گفتن به‌جای نوشتن" }, "🎤") : null;
  const usage = h("small", { class: "muted" });
  const form = h(
    "form",
    { class: "composer" },
    emojiPanel,
    input,
    h("div", { class: "composer-bar" }, h("div", { class: "row" }, tSearch, tDeep, tImage, imgSize, engineSel), h("div", { class: "row" }, emojiBtn, micBtn, send, stop)),
  );
  const disclaimer = h("p", { class: "disclaimer muted" }, "رایان ممکن است اشتباه کند؛ اطلاعات مهم را بررسی کنید.", " ", usage);
  const pane = h("section", { class: "pane" }, top, scroll, status, form, disclaimer);
  const scrim = h("div", { class: "scrim" });
  const shell = h("div", { class: "chat-shell" + (S.side && !isMobile() ? "" : " side-closed") }, side, scrim, pane);
  sideClose.onclick = scrim.onclick = () => shell.classList.add("side-closed");
  main.append(shell);

  const refreshToggles = () => {
    tSearch.setAttribute("aria-pressed", String(S.search));
    tDeep.setAttribute("aria-pressed", String(S.deep));
    tImage.setAttribute("aria-pressed", String(S.image));
    tSearch.hidden = S.image;
    tDeep.hidden = S.image;
    imgSize.hidden = !S.image;
    engineSel.hidden = S.image || !localReady;
    input.placeholder = S.image ? "تصویری که می‌خواهید را توصیف کنید (فارسی یا انگلیسی)…" : "پیام خود را بنویسید…";
  };
  const setImageMode = (v: boolean) => {
    S.image = v;
    saveS();
    refreshToggles();
  };
  tSearch.onclick = () => {
    S.search = !S.search;
    saveS();
    refreshToggles();
  };
  tDeep.onclick = () => {
    S.deep = !S.deep;
    saveS();
    refreshToggles();
  };
  tImage.onclick = () => setImageMode(!S.image);
  imgSideBtn.onclick = () => {
    openChat(null);
    setImageMode(true);
    input.focus();
  };
  imgSize.onchange = () => {
    S.size = imgSize.value;
    saveS();
  };
  engineSel.onchange = () => {
    S.engine = engineSel.value as "server" | "local";
    saveS();
  };
  toggleSide.onclick = () => {
    const open = shell.classList.contains("side-closed");
    shell.classList.toggle("side-closed", !open);
    if (!isMobile()) {
      S.side = open;
      saveS();
    }
  };
  emojiBtn.onclick = () => (emojiPanel.hidden = !emojiPanel.hidden);
  emojiPanel.onclick = (ev) => {
    const b = (ev.target as HTMLElement).closest("button");
    if (!b) return;
    const s = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, s) + b.textContent + input.value.slice(input.selectionEnd ?? s);
    input.dispatchEvent(new Event("input"));
    emojiPanel.hidden = true;
    input.focus();
  };
  if (micBtn) {
    let rec: any = null;
    micBtn.onclick = () => {
      if (rec) {
        rec.stop();
        return;
      }
      rec = new SpeechRec();
      rec.lang = "fa-IR";
      rec.interimResults = true;
      const base = input.value ? input.value + " " : "";
      rec.onresult = (e: any) => {
        let t = "";
        for (const r of e.results) t += r[0].transcript;
        input.value = base + t;
        input.dispatchEvent(new Event("input"));
      };
      rec.onerror = (e: any) => setStatus(e.error === "not-allowed" ? "اجازهٔ دسترسی به میکروفون داده نشد." : "ورودی صوتی متوقف شد.", true);
      rec.onend = () => {
        rec = null;
        micBtn.classList.remove("on");
      };
      micBtn.classList.add("on");
      setStatus("در حال گوش دادن… صحبت کنید.");
      rec.start();
    };
  }
  const grow = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
    send.disabled = !input.value.trim() || busy;
  };
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const q = input.value.trim();
    if (!q || busy) return;
    input.value = "";
    grow();
    void ask(q);
  });
  stop.onclick = () => abort?.abort();
  newBtn.onclick = () => {
    if (!busy) openChat(null);
    if (isMobile()) shell.classList.add("side-closed");
  };
  histSearch.addEventListener("input", () => {
    filter = histSearch.value.trim();
    void loadConvs();
  });

  const setBusy = (v: boolean) => {
    busy = v;
    send.hidden = v;
    stop.hidden = !v;
    grow();
  };

  // ---------- history ----------
  async function loadConvs() {
    try {
      const r = await api<{ conversations: Conv[] }>("GET", "/conversations" + (filter ? "?q=" + encodeURIComponent(filter) : ""));
      convs = r.conversations;
    } catch (e) {
      setStatus(errorMessage(e), true);
    }
    renderHist();
  }
  function renderHist() {
    histList.replaceChildren();
    if (!convs.length) histList.append(h("p", { class: "muted small" }, filter ? "نتیجه‌ای پیدا نشد." : "هنوز گفت‌وگویی ندارید."));
    for (const c of convs) {
      const label = h("span", { class: "hist-title" }, c.title);
      const rn = h("button", { type: "button", class: "icon-btn", title: "تغییر نام", "aria-label": "تغییر نام" }, "✎");
      const del = h("button", { type: "button", class: "icon-btn", title: "حذف", "aria-label": "حذف" }, "🗑");
      const item = h("div", { class: "hist-item" + (c.id === currentId ? " active" : ""), role: "button", tabindex: 0 }, label, rn, del);
      item.onclick = () => {
        if (!busy) void openChat(c.id);
        if (isMobile()) shell.classList.add("side-closed");
      };
      item.onkeydown = (e) => {
        if (e.key === "Enter" && e.target === item) item.click();
      };
      rn.onclick = (e) => {
        e.stopPropagation();
        const inp = h("input", { value: c.title, "aria-label": "نام تازه", maxlength: 120 });
        label.replaceWith(inp);
        inp.focus();
        inp.select();
        const finish = async (save: boolean) => {
          const t = inp.value.trim();
          if (save && t && t !== c.title) {
            await api("PATCH", `/conversations/${c.id}`, { title: t }).catch((er) => setStatus(errorMessage(er), true));
            c.title = t;
            if (c.id === currentId) title.textContent = t;
          }
          renderHist();
        };
        inp.onkeydown = (k) => {
          k.stopPropagation();
          if (k.key === "Enter") void finish(true);
          if (k.key === "Escape") void finish(false);
        };
        inp.onblur = () => void finish(true);
        inp.onclick = (k) => k.stopPropagation();
      };
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`گفت‌وگوی «${c.title}» حذف شود؟`)) return;
        await api("DELETE", `/conversations/${c.id}`).catch((er) => setStatus(errorMessage(er), true));
        if (c.id === currentId) openChat(null);
        await loadConvs();
      };
      histList.append(item);
    }
  }
  clearAll.onclick = async () => {
    if (!confirm("همهٔ گفت‌وگوهای شما برای همیشه حذف شود؟")) return;
    await api("DELETE", "/conversations").catch((er) => setStatus(errorMessage(er), true));
    openChat(null);
    await loadConvs();
  };

  function updateTop() {
    const c = convs.find((x) => x.id === currentId);
    title.textContent = c?.title ?? "گفت‌وگو با رایان";
    shareBtn.hidden = exportBtn.hidden = !(currentId && msgs.length);
    welcome.hidden = !!msgs.length;
  }
  function openChat(id: string | null) {
    abort?.abort();
    currentId = id;
    msgs = [];
    thread.replaceChildren();
    updateTop();
    renderHist();
    if (!id) {
      history.replaceState(null, "", "#/chat");
      input.focus();
      return;
    }
    if (location.hash !== `#/chat/${id}`) history.replaceState(null, "", `#/chat/${id}`);
    return (async () => {
      try {
        const r = await api<{ conversation: Conv; messages: Msg[] }>("GET", `/conversations/${id}`);
        if (currentId !== id) return;
        msgs = r.messages;
        paintAll();
        updateTop();
      } catch (e) {
        setStatus(errorMessage(e), true);
      }
    })();
  }

  // ---------- rendering ----------
  function paintAll() {
    thread.replaceChildren();
    msgs.forEach((m, i) => thread.append(m.role === "user" ? userEl(m) : botEl(m, { isLast: i === msgs.length - 1 })));
    scroll.scrollTop = scroll.scrollHeight;
  }
  function userEl(m: Msg) {
    const bubble = h("div", { class: "bubble", dir: "auto" }, m.content);
    const el = h("div", { class: "msg user" }, bubble);
    if (m.id && !m.id.startsWith("tmp-") && !m.meta?.image_request) {
      const edit = h("button", { type: "button", class: "icon-btn edit-btn", title: "ویرایش پیام", "aria-label": "ویرایش پیام" }, "✎");
      edit.onclick = () => {
        if (busy) return;
        const ta = h("textarea", { rows: 3, maxlength: 4000 });
        ta.value = m.content;
        const ok = h("button", { type: "button", class: "btn btn-primary btn-small" }, "ارسال دوباره");
        const cancel = h("button", { type: "button", class: "btn btn-ghost btn-small" }, "انصراف");
        const box = h("div", { class: "edit-box" }, ta, h("div", { class: "row" }, ok, cancel));
        el.replaceChildren(box);
        ta.focus();
        cancel.onclick = () => el.replaceWith(userEl(m));
        ok.onclick = async () => {
          const t = ta.value.trim();
          if (!t || !currentId) return;
          try {
            await api("POST", `/conversations/${currentId}/truncate`, { from_message_id: m.id });
            const idx = msgs.indexOf(m);
            msgs = msgs.slice(0, idx);
            paintAll();
            void ask(t);
          } catch (e) {
            setStatus(errorMessage(e), true);
          }
        };
      };
      el.append(edit);
    }
    return el;
  }

  function botEl(m: Msg, o: { live?: boolean; pending?: string; isLast?: boolean } = {}) {
    const el = h("div", { class: "msg bot" });
    paintBot(el, m, o);
    return el;
  }
  function paintBot(el: HTMLElement, m: Msg, o: { live?: boolean; pending?: string; isLast?: boolean } = {}) {
    const body = h("div", { class: "bot-body" });
    el.replaceChildren(h("div", { class: "avatar" + (o.live ? " live" : "") }, h("img", { src: "/brand/orb-64.png", alt: "" })), body);
    const img = m.meta?.image;
    if (img) body.append(imageFigure(img));
    else if (o.live && o.pending) body.append(h("div", { class: "content pending" }, o.pending));
    const content = h("div", { class: "content", dir: "auto" });
    if (!img) {
      if (o.live && !m.content && !o.pending) content.classList.add("dots");
      const r = renderMarkdown(m.content);
      content.innerHTML = r.html; // renderMarkdown escapes everything and only keeps http(s) links
      decorateCode(content, r.files);
      if (!o.live) hydrateQuestions(content, r.questions, !!o.isLast);
      if (o.live && m.content) content.classList.add("cursor");
    } else content.textContent = m.content;
    if (m.meta?.error) content.classList.add("error");
    body.append(content);
    const srcs: { title: string; url: string }[] = m.meta?.sources ?? [];
    if (srcs.length) {
      body.append(
        h("div", { class: "sources" }, h("span", { class: "muted" }, "منابع: "), ...srcs.map((s, i) => h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, `[${num(i + 1)}] ${s.title}`))),
      );
    }
    if (o.live || !m.content) return;
    const acts = h("div", { class: "actions" });
    const copy = h("button", { type: "button", class: "icon-btn", title: "کپی", "aria-label": "کپی" }, "⧉");
    copy.onclick = () => void navigator.clipboard?.writeText(m.content).then(() => flash(copy, "✓"));
    acts.append(copy);
    if ("speechSynthesis" in window && !img) {
      const tts = h("button", { type: "button", class: "icon-btn", title: "خواندن پاسخ با صدا", "aria-label": "خواندن با صدا" }, "🔊");
      tts.onclick = () => {
        if (speechSynthesis.speaking) {
          speechSynthesis.cancel();
          tts.textContent = "🔊";
          return;
        }
        const u = new SpeechSynthesisUtterance(plainText(m.content).slice(0, 4000));
        u.lang = /[\u0600-\u06FF]/.test(m.content) ? "fa-IR" : "en-US";
        const v = speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().startsWith(u.lang.slice(0, 2)));
        if (v) u.voice = v;
        u.onend = () => (tts.textContent = "🔊");
        tts.textContent = "🔇";
        speechSynthesis.speak(u);
      };
      acts.append(tts);
    }
    if (!m.meta?.error && !m.id.startsWith("tmp-") && m.meta?.engine !== "local") {
      for (const [v, ic, t] of [
        [1, "👍", "پاسخ خوب"],
        [-1, "👎", "پاسخ بد"],
      ] as [number, string, string][]) {
        const b = h("button", { type: "button", class: "icon-btn", title: t, "aria-label": t, "aria-pressed": String(m.rating === v) }, ic);
        b.onclick = async () => {
          const nv = m.rating === v ? 0 : v;
          try {
            await api("PATCH", `/messages/${m.id}`, { rating: nv });
            m.rating = nv || null;
            paintBot(el, m, o);
            setStatus(nv ? "ممنون از بازخورد شما 🙏" : "");
          } catch (e) {
            setStatus(errorMessage(e), true);
          }
        };
        acts.append(b);
      }
    }
    if (img) {
      const dl = h("button", { type: "button", class: "icon-btn", title: "دانلود تصویر", "aria-label": "دانلود تصویر" }, "⬇");
      dl.onclick = async () => {
        try {
          const r = await fetch(img.url, { mode: "cors" });
          saveBlob(safeName(img.prompt) + ".jpg", await r.blob(), "image/jpeg");
        } catch {
          window.open(img.url, "_blank", "noopener");
        }
      };
      acts.append(dl);
    }
    const files = (content as any)._files as CodeFile[] | undefined;
    if (files && files.length > 1) {
      const z = h("button", { type: "button", class: "icon-btn", title: "دانلود همهٔ فایل‌ها (zip)" }, "🗜 zip");
      z.onclick = () => saveBlob(safeName(title.textContent ?? "") + ".zip", makeZip(files.map((f) => ({ name: f.name, data: f.code }))) as BlobPart, "application/zip");
      acts.append(z);
    }
    if (o.isLast && currentId) {
      const rg = h("button", { type: "button", class: "icon-btn", title: "پاسخ دوباره", "aria-label": "پاسخ دوباره" }, "↻");
      rg.onclick = () => void regenerate();
      acts.append(rg);
    }
    const tag = m.meta?.engine === "local" ? "📴 آفلاین (در مرورگر)" : m.meta?.engine === "pollinations" ? "🎨 Pollinations" : m.meta?.mode === "deep" ? "🧠 تفکر عمیق" : "";
    if (tag) acts.append(h("span", { class: "meta-tag" }, tag));
    if (m.meta?.stopped) acts.append(h("span", { class: "meta-tag" }, "متوقف شد"));
    body.append(acts);
  }
  const flash = (b: HTMLElement, t: string) => {
    const old = b.textContent;
    b.textContent = t;
    setTimeout(() => (b.textContent = old), 1200);
  };

  function imageFigure(img: { url: string; prompt: string; en?: string }) {
    const f = h("figure", { class: "gen-img" });
    const im = h("img", { alt: img.prompt, src: img.url, loading: "lazy", decoding: "async", crossorigin: "anonymous" });
    f.append(h("div", { class: "img-ph" }, "در حال ساخت تصویر…"));
    im.onload = () => f.querySelector(".img-ph")?.remove();
    im.onerror = () => {
      f.replaceChildren(
        h("p", { class: "muted" }, "تصویر بارگذاری نشد (سرویس رایگان شلوغ است)."),
        h("button", {
          type: "button",
          class: "btn btn-ghost btn-small",
          onclick: () => f.replaceWith(imageFigure({ ...img, url: img.url + (img.url.includes("&r=") ? "" : "&r=" + Date.now()) })),
        }, "تلاش دوباره"),
      );
    };
    f.append(im, h("figcaption", { class: "muted" }, "ساخته‌شده با ", h("a", { href: "https://pollinations.ai", target: "_blank", rel: "noopener" }, "Pollinations"), img.en && img.en !== img.prompt ? ` · ${img.en}` : ""));
    return f;
  }

  function decorateCode(container: HTMLElement, files: CodeFile[]) {
    (container as any)._files = files;
    container.querySelectorAll<HTMLElement>(".code").forEach((slot) => {
      const f = files[Number(slot.dataset.file)];
      if (!f) return;
      const pre = h("pre", { dir: "ltr" });
      const code = h("code", {});
      code.innerHTML = highlight(f.code, f.ext); // highlight() escapes all text
      pre.append(code);
      const bar = h("div", { class: "code-bar" }, h("span", { class: "code-name", dir: "ltr" }, f.name));
      const btn = (label: string, fn: () => void) => bar.append(h("button", { type: "button", class: "btn btn-ghost btn-small", onclick: fn }, label));
      if (f.ext === "docx") {
        btn("⬇ Word (.docx)", () => saveBlob(f.name.replace(/\.[^.]+$/, "") + ".docx", markdownToDocx(f.code) as BlobPart, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"));
      } else if (f.ext === "pdf") {
        btn("⬇ PDF (چاپ)", () => printPdf(f.code, f.name));
      } else {
        btn("کپی", () => void navigator.clipboard?.writeText(f.code));
        btn("⬇ دانلود", () => saveBlob(f.name, f.code, f.ext === "html" ? "text/html" : "text/plain;charset=utf-8"));
        if (f.ext === "html" || f.ext === "svg") btn("▶ پیش‌نمایش", () => openPreview(f));
      }
      slot.replaceWith(h("div", { class: "code-block" }, bar, pre));
    });
  }

  function hydrateQuestions(container: HTMLElement, qsets: Question[][], active: boolean) {
    container.querySelectorAll<HTMLElement>(".qbox").forEach((box) => {
      const qs = qsets[Number(box.dataset.q)];
      if (!qs) return;
      const picks = qs.map(() => new Set<string>());
      const others = qs.map(() => "");
      const sendBtn = h("button", { type: "button", class: "btn btn-primary btn-small", disabled: true }, "ارسال پاسخ");
      const ready = () => qs.every((_q, k) => picks[k]!.size || others[k]!.trim());
      qs.forEach((q, k) => {
        const opts = h("div", { class: "qopts" });
        for (const o of [...q.options, "سایر…"]) {
          const isOther = o === "سایر…";
          const b = h("button", { type: "button", class: "qopt", "aria-pressed": "false", disabled: !active }, o);
          b.onclick = () => {
            if (isOther) {
              const inp = h("input", { placeholder: "پاسخ خودتان…", "aria-label": "پاسخ دیگر" });
              inp.oninput = () => {
                others[k] = inp.value;
                sendBtn.disabled = !ready();
              };
              b.replaceWith(inp);
              inp.focus();
              return;
            }
            if (!q.multi) picks[k]!.clear();
            if (picks[k]!.has(o)) picks[k]!.delete(o);
            else picks[k]!.add(o);
            opts.querySelectorAll(".qopt").forEach((x) => x.setAttribute("aria-pressed", String(picks[k]!.has(x.textContent ?? ""))));
            sendBtn.disabled = !ready();
          };
          opts.append(b);
        }
        box.append(h("p", { class: "qtitle", dir: "auto" }, q.question), opts);
      });
      if (active) {
        sendBtn.onclick = () => void ask(qs.map((q, k) => `${q.question} ${[...picks[k]!, others[k]!.trim()].filter(Boolean).join("، ")}`).join("\n"));
        box.append(sendBtn);
      }
    });
  }

  // ---------- preview / print ----------
  const pvFrame = h("iframe", { title: "پیش‌نمایش", sandbox: "allow-scripts allow-forms allow-modals allow-popups", src: "about:blank" });
  const pvName = h("span", { dir: "ltr" });
  const pvClose = h("button", { type: "button", class: "btn btn-small" }, "✕ بستن");
  const pvNew = h("button", { type: "button", class: "btn btn-small" }, "↗ برگهٔ جدید");
  const preview = h("dialog", { class: "preview-dlg" }, h("div", { class: "pv-head" }, pvName, h("div", { class: "row" }, pvNew, pvClose)), pvFrame);
  main.append(preview);
  pvClose.onclick = () => preview.close();
  function openPreview(f: CodeFile) {
    pvName.textContent = f.name;
    const html = f.ext === "svg" ? `<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;min-height:100vh">${f.code}</body>` : f.code;
    pvFrame.onload = () => pvFrame.contentWindow?.postMessage({ type: "rayan-preview", html }, "*");
    pvFrame.src = "/preview?v=" + Date.now();
    pvNew.onclick = () => {
      const w = window.open("/preview", "_blank");
      const t = setInterval(() => w?.postMessage({ type: "rayan-preview", html }, "*"), 300);
      setTimeout(() => clearInterval(t), 3000);
    };
    preview.showModal();
  }
  function printPdf(md: string, name: string) {
    const w = window.open("/print", "_blank");
    const html = renderMarkdown(md).html;
    const t = setInterval(() => w?.postMessage({ type: "rayan-print", html, title: name }, location.origin), 300);
    setTimeout(() => clearInterval(t), 3000);
  }

  // ---------- dialogs: share, keys, support ----------
  const shareOn = h("input", { type: "checkbox" });
  const shareLink = h("input", { readonly: true, dir: "ltr", "aria-label": "پیوند" });
  const shareCopy = h("button", { type: "button", class: "btn btn-small" }, "کپی");
  const shareDlg = h(
    "dialog",
    { class: "dlg" },
    h("h3", {}, "اشتراک‌گذاری گفت‌وگو"),
    h("label", { class: "switch" }, shareOn, "ساخت پیوند فقط‌خواندنی"),
    h("div", { class: "row" }, shareLink, shareCopy),
    h("p", { class: "muted small" }, "هر کسی پیوند را داشته باشد می‌تواند این گفت‌وگو را بخواند. با خاموش کردن، پیوند باطل می‌شود."),
    h("button", { type: "button", class: "btn", onclick: () => shareDlg.close() }, "بستن"),
  );
  const paintShare = (sid: string | null) => {
    shareOn.checked = !!sid;
    shareLink.hidden = shareCopy.hidden = !sid;
    shareLink.value = sid ? `${location.origin}/#/share/${sid}` : "";
  };
  shareBtn.onclick = () => {
    paintShare(convs.find((c) => c.id === currentId)?.share_id ?? null);
    shareDlg.showModal();
  };
  shareOn.onchange = async () => {
    try {
      const r = await api<{ share_id: string | null }>("POST", `/conversations/${currentId}/share`, { enabled: shareOn.checked });
      const c = convs.find((x) => x.id === currentId);
      if (c) c.share_id = r.share_id;
      paintShare(r.share_id);
    } catch (e) {
      setStatus(errorMessage(e), true);
    }
  };
  shareCopy.onclick = () => void navigator.clipboard?.writeText(shareLink.value).then(() => flash(shareCopy, "✓"));
  exportBtn.onclick = () => saveBlob(safeName(title.textContent ?? "") + ".md", chatToMarkdown(title.textContent ?? "", msgs), "text/markdown;charset=utf-8");

  const keysDlg = h(
    "dialog",
    { class: "dlg" },
    h("h3", {}, "میان‌برهای صفحه‌کلید"),
    h("table", {}, h("tbody", {}, ...SHORTCUTS.map(([k, v]) => h("tr", {}, h("td", { dir: "ltr" }, h("kbd", {}, k)), h("td", {}, v))))),
    h("button", { type: "button", class: "btn", onclick: () => keysDlg.close() }, "بستن"),
  );
  keysBtn.onclick = () => keysDlg.showModal();

  const supText = h("textarea", { rows: 4, maxlength: 2000, placeholder: "پیام خود را برای تیم رایان بنویسید…" });
  const supSend = h("button", { type: "button", class: "btn btn-primary" }, "ارسال");
  const supList = h("div", { class: "stack" });
  const supOut = h("div");
  const supDlg = h(
    "dialog",
    { class: "dlg" },
    h("h3", {}, "پشتیبانی"),
    supText,
    h("div", { class: "row" }, supSend, h("button", { type: "button", class: "btn", onclick: () => supDlg.close() }, "بستن")),
    supOut,
    h("h4", {}, "پیام‌های شما"),
    supList,
  );
  const loadTickets = async () => {
    const r = await api<{ tickets: any[] }>("GET", "/support");
    supList.replaceChildren(
      ...(r.tickets.length
        ? r.tickets.map((t) =>
            h("div", { class: "ticket" }, h("p", { dir: "auto" }, t.body), t.reply ? h("p", { class: "reply", dir: "auto" }, "↩ پاسخ تیم: ", t.reply) : h("small", { class: "muted" }, "در انتظار پاسخ")),
          )
        : [h("p", { class: "muted small" }, "هنوز پیامی نفرستاده‌اید.")]),
    );
  };
  supBtn.onclick = () => {
    supOut.replaceChildren();
    supDlg.showModal();
    void loadTickets().catch((e) => supOut.replaceChildren(alertBox(errorMessage(e))));
  };
  supSend.onclick = async () => {
    const body = supText.value.trim();
    if (body.length < 2) return;
    supSend.disabled = true;
    try {
      await api("POST", "/support", { body });
      supText.value = "";
      supOut.replaceChildren(alertBox("پیام شما ثبت شد؛ پاسخ تیم همین‌جا نمایش داده می‌شود.", "ok"));
      await loadTickets();
    } catch (e) {
      supOut.replaceChildren(alertBox(errorMessage(e)));
    } finally {
      supSend.disabled = false;
    }
  };
  main.append(shareDlg, keysDlg, supDlg);
  for (const d of [shareDlg, keysDlg, supDlg, preview]) d.addEventListener("click", (e) => e.target === d && d.close());

  // ---------- asking ----------
  async function ensureConv(firstText: string): Promise<string> {
    if (currentId) return currentId;
    const r = await api<{ conversation: Conv }>("POST", "/conversations", { title: firstText.slice(0, 60) });
    convs.unshift(r.conversation);
    currentId = r.conversation.id;
    history.replaceState(null, "", `#/chat/${currentId}`);
    renderHist();
    return currentId;
  }

  async function ask(q: string) {
    if (busy) return;
    setStatus("");
    setBusy(true);
    abort = new AbortController();
    const um: Msg = { id: "tmp-u", role: "user", content: q, meta: S.image ? { image_request: true } : null, rating: null };
    msgs.push(um);
    // the previous last answer loses its regenerate button
    paintAll();
    updateTop();
    const bm: Msg = { id: "tmp-a", role: "assistant", content: "", meta: null, rating: null };
    const el = botEl(bm, { live: true });
    thread.append(el);
    scroll.scrollTop = scroll.scrollHeight;
    try {
      const id = await ensureConv(q);
      if (S.image) await askImage(id, q, bm, el);
      else if (S.engine === "local" && localReady) await askLocal(id, bm, el, true);
      else await askServer(id, `/conversations/${id}/messages`, { content: q, search: S.search, deep: S.deep }, bm, el);
    } catch (e) {
      if (!abort.signal.aborted) {
        bm.content = "⚠️ " + errorMessage(e);
        bm.meta = { error: true };
      }
    }
    await finish(bm, el);
  }

  async function finish(bm: Msg, el: HTMLElement) {
    setBusy(false);
    abort = null;
    if (!bm.content) bm.content = "…";
    // reload from the server so ids (feedback / edit) are real
    if (currentId && !bm.meta?.error && bm.meta?.engine !== "local-unsaved") {
      try {
        const r = await api<{ conversation: Conv; messages: Msg[] }>("GET", `/conversations/${currentId}`);
        msgs = r.messages;
        const c = convs.find((x) => x.id === currentId);
        if (c) {
          c.title = r.conversation.title;
          convs = [c, ...convs.filter((x) => x !== c)];
        }
        paintAll();
        renderHist();
        updateTop();
        return;
      } catch {
        /* keep the local view */
      }
    }
    paintBot(el, bm, { isLast: true });
  }

  async function askServer(id: string, path: string, body: unknown, bm: Msg, el: HTMLElement) {
    if (S.search) paintBot(el, bm, { live: true, pending: "در حال جست‌وجو…" });
    let res: Response;
    try {
      res = await apiStream(path, body, abort!.signal);
    } catch (e) {
      // central server down / capped / offline: the in-browser model answers when it is on this device
      if (localReady && e instanceof ApiError && (e.status === 0 || e.status === 429 || e.status >= 500)) {
        setStatus("سرور در دسترس نیست؛ مدل آفلاین در مرورگر پاسخ می‌دهد.");
        return askLocal(id, bm, el, true);
      }
      throw e;
    }
    bm.meta = { engine: "server" };
    try {
      for await (const ev of readSse(res)) {
        if (ev.type === "sources") bm.meta.sources = ev.sources;
        else if (ev.type === "delta") {
          bm.content += ev.text;
          paintBot(el, bm, { live: true });
          if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 160) scroll.scrollTop = scroll.scrollHeight;
        } else if (ev.type === "error") {
          bm.content = ev.message;
          bm.meta.error = true;
        }
      }
    } catch (e) {
      if (!abort!.signal.aborted) throw e;
    }
  }

  async function askLocal(id: string, bm: Msg, el: HTMLElement, save: boolean) {
    paintBot(el, bm, { live: true, pending: "بارگذاری مدل آفلاین…" });
    const hist = msgs.filter((m) => m.content && !m.meta?.error && !m.meta?.image && !m.meta?.image_request).map((m) => ({ role: m.role, content: m.content }));
    await local.load((p) => paintBot(el, bm, { live: true, pending: p.phase === "load" ? "بارگذاری مدل در حافظه…" : `دانلود مدل ${num(Math.round((p.got / p.total) * 100))}٪` }), abort!.signal);
    const text = await local.chat(hist, {
      signal: abort!.signal,
      onText: (t) => {
        bm.content = t;
        paintBot(el, bm, { live: true });
      },
    });
    bm.content = text;
    bm.meta = { engine: "local" };
    const lastUser = hist.filter((x) => x.role === "user").at(-1);
    if (save && text && lastUser) {
      try {
        await api("POST", `/conversations/${id}/append`, { messages: [lastUser, { role: "assistant", content: text }] });
      } catch {
        bm.meta = { engine: "local-unsaved" }; // offline: shown now, not stored
      }
    }
  }

  async function askImage(id: string, q: string, bm: Msg, el: HTMLElement) {
    paintBot(el, bm, { live: true, pending: "در حال آماده‌سازی تصویر…" });
    const r = await api<{ url: string; prompt: string; en: string; size: string }>("POST", "/images", { prompt: q, size: S.size, conversation_id: id });
    bm.content = `تصویر «${q}» ساخته شد.`;
    bm.meta = { engine: "pollinations", image: r };
  }

  async function regenerate() {
    if (busy || !currentId) return;
    const last = msgs.at(-1);
    if (last?.role === "assistant") msgs.pop();
    const lastUser = msgs.filter((m) => m.role === "user").at(-1);
    if (!lastUser) return;
    if (lastUser.meta?.image_request) {
      // an image turn: make a new image (new seed) from the same prompt
      msgs.pop();
      await api("POST", `/conversations/${currentId}/truncate`, { from_message_id: lastUser.id }).catch(() => {});
      paintAll();
      setImageMode(true);
      return ask(lastUser.content);
    }
    paintAll();
    setBusy(true);
    abort = new AbortController();
    const bm: Msg = { id: "tmp-a", role: "assistant", content: "", meta: null, rating: null };
    const el = botEl(bm, { live: true });
    thread.append(el);
    try {
      await askServer(currentId, `/conversations/${currentId}/regenerate`, { search: S.search, deep: S.deep }, bm, el);
    } catch (e) {
      bm.content = "⚠️ " + errorMessage(e);
      bm.meta = { error: true };
    }
    await finish(bm, el);
  }

  // ---------- keyboard shortcuts ----------
  const onKey = (e: KeyboardEvent) => {
    if (!document.body.contains(shell)) return document.removeEventListener("keydown", onKey);
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      newBtn.click();
    } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      shell.classList.remove("side-closed");
      histSearch.focus();
    } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      toggleSide.click();
    } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      const a = msgs.filter((m) => m.role === "assistant").at(-1);
      if (a) void navigator.clipboard?.writeText(a.content).then(() => setStatus("آخرین پاسخ کپی شد."));
    } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      if (!exportBtn.hidden) exportBtn.click();
    } else if (e.key === "Escape" && busy) abort?.abort();
    else if (!typing && e.key === "/") {
      e.preventDefault();
      input.focus();
    } else if (!typing && e.key === "?") keysDlg.showModal();
  };
  document.addEventListener("keydown", onKey);

  // ---------- start ----------
  refreshToggles();
  if (local.supported()) {
    void local.cacheStatus().then((s) => {
      localReady = s.cached;
      engineSel.value = localReady ? S.engine : "server";
      refreshToggles();
    });
  }
  void api<{ usage?: unknown }>("GET", "/me/stats")
    .then((r: any) => (usage.textContent = `· ${num(r.stats.conversations)} گفت‌وگو`))
    .catch(() => {});
  // Input is enabled only after history and the routed conversation are loaded (no race with a fast first message).
  input.disabled = true;
  await loadConvs();
  const m = location.hash.match(/^#\/chat\/([\w-]+)/);
  await openChat(m ? m[1]! : null);
  input.disabled = false;
  input.focus();
}
