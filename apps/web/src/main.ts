import "@fontsource/vazirmatn/400.css";
import "@fontsource/vazirmatn/500.css";
import "@fontsource/vazirmatn/700.css";
import "./styles.css";
import { api, applyTheme, can, clearMe, getMe, type Me } from "./api";
import { renderAdmin } from "./pages/admin";
import { renderAuth } from "./pages/auth";
import { renderAutomation } from "./pages/automation";
import { renderChat } from "./pages/chat";
import { renderContentStudio, renderTaskCenter, renderWorkspace } from "./pages/cortex";
import { renderLanding } from "./pages/landing";
import { renderSettings } from "./pages/settings";
import { renderShare } from "./pages/share";
import { navigate } from "./nav";
import { alertBox, errorMessage, h } from "./ui";

const root = document.getElementById("app")!;

export function isAdmin(me: Me | null) {
  return can(me, "users:read") || can(me, "agents:manage") || can(me, "audit:read");
}

function header(me: Me | null) {
  const links: Node[] = [h("a", { href: "#/" }, "خانه")];
  if (me) {
    links.push(h("a", { href: "#/chat" }, "گفت‌وگو"), h("a", { href: "#/settings" }, "تنظیمات"));
    if (can(me, "cortex:run")) {
      links.push(h("a", { href: "#/workspace" }, "فضای کاری عامل‌ها"), h("a", { href: "#/tasks" }, "مرکز وظایف"), h("a", { href: "#/content" }, "استودیو محتوا"));
    }
    if (can(me, "autopilot:read")) links.push(h("a", { href: "#/automation" }, "مرکز اتوماسیون"));
    if (isAdmin(me)) links.push(h("a", { href: "#/admin" }, "مدیریت"));
    const logout = h("button", { class: "btn btn-ghost", type: "button" }, "خروج");
    logout.addEventListener("click", async () => {
      logout.disabled = true;
      try {
        await api("POST", "/auth/logout", {});
      } finally {
        clearMe();
        navigate("#/");
      }
    });
    links.push(h("span", { class: "who", title: me.user.email }, me.user.display_name ?? me.user.email), logout);
  } else {
    links.push(h("a", { href: "#/login" }, "ورود"), h("a", { href: "#/signup", class: "btn btn-primary" }, "ثبت‌نام"));
  }
  return h(
    "header",
    { class: "topbar" },
    h("a", { href: "#/", class: "brand", "aria-label": "رایان — خانه" }, h("img", { src: "/brand/orb-64.png", alt: "", width: 32, height: 32, class: "logo-orb" }), h("img", { src: "/brand/wordmark.png", alt: "رایان", height: 26, class: "wordmark" })),
    h("nav", {}, ...links),
  );
}

let banner: HTMLElement | null = null;
async function announcements() {
  try {
    const r = await api<{ announcements: { id: string; body: string }[] }>("GET", "/announcements");
    const seen = JSON.parse(localStorage.getItem("rayan.annSeen") ?? "[]") as string[];
    const a = r.announcements.find((x) => !seen.includes(x.id));
    if (!a) return null;
    const close = h("button", { type: "button", class: "icon-btn", "aria-label": "بستن" }, "✕");
    const el = h("div", { class: "announce", role: "status" }, h("span", { dir: "auto" }, "📢 ", a.body), close);
    close.onclick = () => {
      localStorage.setItem("rayan.annSeen", JSON.stringify([...seen, a.id].slice(-50)));
      el.remove();
      banner = null;
    };
    return el;
  } catch {
    return null;
  }
}

async function render() {
  applyTheme();
  const raw = (location.hash || "#/").replace(/^#/, "");
  const [full, query = ""] = raw.split("?") as [string, string?];
  const params = new URLSearchParams(query);
  const route = full.startsWith("/chat/") ? "/chat" : full.startsWith("/share/") ? "/share" : full;
  let me: Me | null = null;
  try {
    me = await getMe();
  } catch (e) {
    root.replaceChildren(header(null), h("main", { class: "container" }, alertBox(errorMessage(e))));
    return;
  }
  const main = h("main", { class: "container" });
  root.replaceChildren(header(me), main, h("footer", { class: "footer" }, "رایان — هوش مصنوعی فارسی · فاز ۴: گفت‌وگوی کامل، جست‌وجو، ساخت تصویر و مدل آفلاین · هزینهٔ صفر بر بستر Cloudflare"));
  banner ??= await announcements();
  if (banner) root.insertBefore(banner, main);

  const PROTECTED = ["/chat", "/settings", "/admin", "/workspace", "/tasks", "/content", "/automation"];
  if (PROTECTED.includes(route) && !me) return navigate("#/login");
  const denied = () => main.append(alertBox("شما اجازهٔ دسترسی به این بخش را ندارید."));
  if ((route === "/login" || route === "/signup") && me) return navigate("#/chat");

  switch (route) {
    case "/login":
      return renderAuth(main, "login", params);
    case "/signup":
      return renderAuth(main, "signup", params);
    case "/chat":
      return renderChat(main, me!);
    case "/settings":
      return renderSettings(main, me!);
    case "/share":
      return renderShare(main, full.slice("/share/".length));
    case "/workspace":
      return can(me, "cortex:run") ? renderWorkspace(main, me!) : denied();
    case "/tasks":
      return can(me, "cortex:run") ? renderTaskCenter(main, me!) : denied();
    case "/content":
      return can(me, "cortex:run") ? renderContentStudio(main, me!) : denied();
    case "/automation":
      return can(me, "autopilot:read") ? renderAutomation(main, me!) : denied();
    case "/admin":
      if (!isAdmin(me)) {
        main.append(alertBox("شما اجازهٔ دسترسی به بخش مدیریت را ندارید."));
        return;
      }
      return renderAdmin(main, me!, params);
    default:
      return renderLanding(main, me);
  }
}

window.addEventListener("hashchange", () => void render());
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme());
if ("serviceWorker" in navigator && location.protocol === "https:") void navigator.serviceWorker.register("/sw.js").catch(() => {});
void render();
