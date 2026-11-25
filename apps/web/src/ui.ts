type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;

/** Tiny DOM builder. Text is always inserted via text nodes (no innerHTML), so API/AI content can't inject markup. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const faNum = new Intl.NumberFormat("fa-IR");
const faDate = new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" });

export const num = (n: number | null | undefined) => (n === null || n === undefined ? "—" : faNum.format(n));
export const date = (ms: number | null | undefined) => (ms ? faDate.format(new Date(ms)) : "—");

export function alertBox(message: string, kind: "error" | "ok" | "info" = "error") {
  return h("div", { class: `alert alert-${kind}`, role: kind === "error" ? "alert" : "status" }, message);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "خطای ناشناخته رخ داد.";
}

/** Runs an async action with a disabled button and inline error reporting. */
export async function withBusy(btn: HTMLButtonElement, out: HTMLElement | null, fn: () => Promise<void>) {
  btn.disabled = true;
  out?.replaceChildren();
  try {
    await fn();
  } catch (e) {
    out?.replaceChildren(alertBox(errorMessage(e)));
  } finally {
    btn.disabled = false;
  }
}

export const STATUS_FA: Record<string, string> = {
  pending: "در انتظار",
  running: "در حال اجرا",
  succeeded: "موفق",
  failed: "ناموفق",
  cancelled: "لغوشده",
  ok: "سالم",
  degraded: "ناقص",
  down: "از کار افتاده",
  stale: "متوقف",
  never_run: "هنوز اجرا نشده",
  unconfigured: "پیکربندی نشده",
  disabled: "غیرفعال",
  capped: "سقف روزانه پر شده",
  unknown: "نامشخص",
  error: "خطا",
};
export const statusFa = (s: string | null | undefined) => (s ? (STATUS_FA[s] ?? s) : "—");
