/** Public read-only view of a shared conversation (#/share/<id>), no sign-in needed. */
import { api } from "../api";
import { renderMarkdown } from "../markdown";
import { alertBox, errorMessage, h } from "../ui";

export async function renderShare(main: HTMLElement, shareId: string) {
  try {
    const r = await api<{ title: string; messages: { role: string; content: string; meta: any }[] }>("GET", `/share/${encodeURIComponent(shareId)}`);
    const thread = h("div", { class: "thread shared" });
    for (const m of r.messages) {
      if (m.role === "user") thread.append(h("div", { class: "msg user" }, h("div", { class: "bubble", dir: "auto" }, m.content)));
      else {
        const c = h("div", { class: "content", dir: "auto" });
        if (m.meta?.image) c.append(h("img", { src: m.meta.image.url, alt: m.meta.image.prompt, class: "gen-img-static" }));
        else {
          const md = renderMarkdown(m.content);
          c.innerHTML = md.html; // escaped by renderMarkdown
          c.querySelectorAll<HTMLElement>(".code").forEach((s) => {
            const f = md.files[Number(s.dataset.file)];
            if (f) s.replaceWith(h("pre", { dir: "ltr" }, h("code", {}, f.code)));
          });
        }
        thread.append(h("div", { class: "msg bot" }, h("div", { class: "avatar" }, h("img", { src: "/brand/orb-64.png", alt: "" })), h("div", { class: "bot-body" }, c)));
      }
    }
    main.append(
      h("p", { class: "muted" }, "گفت‌وگوی اشتراکی (فقط‌خواندنی)"),
      h("h1", {}, r.title),
      thread,
      h("p", { class: "center" }, h("a", { class: "btn btn-primary", href: "#/chat" }, "گفت‌وگو با رایان")),
    );
  } catch (e) {
    main.append(alertBox(errorMessage(e)));
  }
}
