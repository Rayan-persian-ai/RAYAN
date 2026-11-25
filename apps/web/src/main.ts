import "@fontsource/vazirmatn/400.css";
import "@fontsource/vazirmatn/500.css";
import "@fontsource/vazirmatn/700.css";
import "./styles.css";
import { api, can, clearMe, getMe, type Me } from "./api";
import { renderAdmin } from "./pages/admin";
import { renderAuth } from "./pages/auth";
import { renderChat } from "./pages/chat";
import { renderLanding } from "./pages/landing";
import { navigate } from "./nav";
import { alertBox, errorMessage, h } from "./ui";

const root = document.getElementById("app")!;

export function isAdmin(me: Me | null) {
  return can(me, "users:read") || can(me, "agents:manage") || can(me, "audit:read");
}

function header(me: Me | null) {
  const links: Node[] = [h("a", { href: "#/" }, "خانه")];
  if (me) {
    links.push(h("a", { href: "#/chat" }, "گفت‌وگو"));
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
    h("a", { href: "#/", class: "brand" }, h("span", { class: "logo" }, "ر"), "رایان"),
    h("nav", {}, ...links),
  );
}

async function render() {
  const route = (location.hash || "#/").replace(/^#/, "");
  let me: Me | null = null;
  try {
    me = await getMe();
  } catch (e) {
    root.replaceChildren(header(null), h("main", { class: "container" }, alertBox(errorMessage(e))));
    return;
  }
  const main = h("main", { class: "container" });
  root.replaceChildren(header(me), main, h("footer", { class: "footer" }, "رایان — فاز ۱: زیرساخت · هزینهٔ صفر بر بستر Cloudflare"));

  if ((route === "/chat" || route === "/admin") && !me) return navigate("#/login");
  if ((route === "/login" || route === "/signup") && me) return navigate("#/chat");

  switch (route) {
    case "/login":
      return renderAuth(main, "login");
    case "/signup":
      return renderAuth(main, "signup");
    case "/chat":
      return renderChat(main, me!);
    case "/admin":
      if (!isAdmin(me)) {
        main.append(alertBox("شما اجازهٔ دسترسی به بخش مدیریت را ندارید."));
        return;
      }
      return renderAdmin(main, me!);
    default:
      return renderLanding(main, me);
  }
}

window.addEventListener("hashchange", () => void render());
void render();
