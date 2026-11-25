import type { Me } from "../api";
import { api } from "../api";
import { alertBox, errorMessage, h, num } from "../ui";

const MAX_TOTAL_CHARS = 6000; // mirrors CHAT_MAX_TOTAL_CHARS in @rayan/shared

/** Most recent turns that fit the server-side budget, always starting with a user turn. */
function contextWindow(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0 && out.length < 20; i--) {
    const t = turns[i]!;
    if (total + t.content.length > MAX_TOTAL_CHARS) break;
    total += t.content.length;
    out.unshift(t);
  }
  while (out.length && out[0]!.role !== "user") out.shift();
  return out;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
}
interface ChatResponse {
  reply: string;
  usage: { used: number; limit: number; day: string };
}

const history: Turn[] = []; // kept for the page session only

export function renderChat(main: HTMLElement, me: Me) {
  const log = h("div", { class: "chat-log", role: "log", "aria-live": "polite" });
  const usage = h("small", { class: "muted" });
  const err = h("div");
  const input = h("textarea", { rows: 3, maxlength: 4000, placeholder: "پیام خود را بنویسید… (Enter برای ارسال، Shift+Enter برای خط جدید)", required: true });
  const send = h("button", { type: "submit", class: "btn btn-primary" }, "ارسال");
  const clear = h("button", { type: "button", class: "btn btn-ghost" }, "گفت‌وگوی تازه");

  const bubble = (t: Turn) => h("div", { class: `bubble bubble-${t.role}` }, h("div", { class: "bubble-role" }, t.role === "user" ? "شما" : "رایان"), h("div", { class: "bubble-text" }, t.content));
  const redraw = () => {
    log.replaceChildren(...(history.length ? history.map(bubble) : [h("p", { class: "muted center" }, `سلام ${me.user.display_name ?? ""}! هر سؤالی دارید بپرسید.`)]));
    log.scrollTop = log.scrollHeight;
  };

  const form = h("form", { class: "chat-form" }, input, h("div", { class: "row" }, send, clear, usage));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    err.replaceChildren();
    history.push({ role: "user", content: text });
    input.value = "";
    redraw();
    const pending = h("div", { class: "bubble bubble-assistant typing" }, "در حال نوشتن…");
    log.append(pending);
    send.disabled = true;
    try {
      const res = await api<ChatResponse>("POST", "/chat", { messages: contextWindow(history) });
      history.push({ role: "assistant", content: res.reply });
      usage.textContent = `مصرف امروز سامانه: ${num(res.usage.used)} از ${num(res.usage.limit)}`;
    } catch (e) {
      history.pop(); // let the user retry the same message
      input.value = text;
      err.replaceChildren(alertBox(errorMessage(e)));
    } finally {
      send.disabled = false;
      redraw();
      input.focus();
    }
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });
  clear.addEventListener("click", () => {
    history.length = 0;
    redraw();
  });

  main.append(h("section", { class: "chat card" }, h("h1", {}, "گفت‌وگو با رایان"), log, err, form));
  redraw();
  input.focus();
}
