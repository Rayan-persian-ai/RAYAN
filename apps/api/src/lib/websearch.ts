/**
 * «جست‌وجو» — free web grounding from Persian Wikipedia (no key, no cost), ported from the old
 * Space's simorgh.js, but done server-side in the Worker so the browser CSP stays strict.
 * Only factual-looking questions trigger a search; greetings and small talk never do.
 */
export interface Source {
  title: string;
  url: string;
  text: string;
}

const QWORDS = ["چیست", "کیست", "چیه", "کیه", "چند", "کجا", "کجاست", "کی ", "چه زمانی", "چه سالی", "چطور", "چگونه", "چرا", "کدام", "معنی", "تاریخچه", "زندگی‌نامه", "درباره", "who ", "what ", "when ", "where ", "why ", "how "];
const SMALL_TALK = ["سلام", "خوبی", "ممنون", "مرسی", "خداحافظ", "اسمت", "تو کی", "حالت", "hello", "thanks"];
const STRIP = new Set(["چیست", "کیست", "چیه", "کیه", "چند", "تا", "کجا", "کجاست", "کی", "چه", "چی", "چطور", "چگونه", "چرا", "است", "هست", "بود", "را", "در", "به", "از", "که", "این", "آن", "یک", "و", "درباره", "دربارهٔ", "بگو", "توضیح", "بده", "لطفا", "لطفاً", "؟", "?"]);

/** Heuristic: does this message look like a factual question worth grounding? */
export function needsSearch(q: string): boolean {
  const s = ` ${q.trim().toLowerCase()} `;
  if (s.trim().length < 4) return false;
  if (s.trim().length < 25 && SMALL_TALK.some((w) => s.includes(w))) return false;
  return QWORDS.some((w) => s.includes(w)) || /[؟?]\s*$/.test(q.trim());
}

/** Keyword query for the Wikipedia search API (question words removed). */
export function simplify(q: string): string {
  const words = q
    .replace(/[؟?!.,،:;«»"()]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STRIP.has(w));
  return (words.length ? words : q.split(/\s+/)).join(" ").slice(0, 120);
}

const API = "https://fa.wikipedia.org/w/api.php";

async function getJson(params: Record<string, string>, fetchFn: typeof fetch, signal: AbortSignal): Promise<any> {
  const u = new URL(API);
  for (const [k, v] of Object.entries({ ...params, format: "json", formatversion: "2", origin: "*" })) u.searchParams.set(k, v);
  const r = await fetchFn(u.toString(), {
    signal,
    headers: { "user-agent": "RAYAN/0.4 (https://rayan-c1o.pages.dev; Persian AI assistant)", accept: "application/json" },
  });
  if (!r.ok) throw new Error(`wikipedia ${r.status}`);
  return r.json();
}

/**
 * Top Persian Wikipedia pages for the question, with a plain-text intro of each (≤ 1200 chars).
 * Never throws: any failure or timeout returns [] so chat keeps working without grounding.
 */
export async function searchWikipedia(q: string, opts: { fetchFn?: typeof fetch; n?: number; timeoutMs?: number } = {}): Promise<Source[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 4000);
  try {
    const s = await getJson({ action: "query", list: "search", srsearch: simplify(q), srlimit: String(opts.n ?? 3), srprop: "" }, fetchFn, ac.signal);
    const titles: string[] = (s?.query?.search ?? []).map((x: { title: string }) => x.title).filter(Boolean);
    if (!titles.length) return [];
    const e = await getJson(
      { action: "query", prop: "extracts", exintro: "1", explaintext: "1", exchars: "1200", redirects: "1", titles: titles.join("|") },
      fetchFn,
      ac.signal,
    );
    const pages: { title: string; extract?: string }[] = e?.query?.pages ?? [];
    const byTitle = new Map(pages.map((p) => [p.title, p.extract ?? ""]));
    return titles
      .map((t) => ({ title: t, url: `https://fa.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, "_"))}`, text: (byTitle.get(t) ?? "").trim() }))
      .filter((x) => x.text.length > 20);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** System message that hands the sources to the model and asks for [n] citations. */
export function sourcesPrompt(sources: Source[]): string {
  return (
    "نتایج جست‌وجو در ویکی‌پدیای فارسی (فقط اگر مرتبط بودند استفاده کن و با [n] به آن‌ها ارجاع بده؛ اگر مرتبط نبودند نادیده بگیر و چیزی از خودت نساز):\n" +
    sources.map((x, i) => `[${i + 1}] ${x.title} — ${x.url}\n${x.text.slice(0, 900)}`).join("\n\n")
  );
}

const POETS = /(حافظ|سعدی|مولوی|مولانا|فردوسی|خیام|نظامی|عطار|پروین|شهریار|سهراب|اخوان|نیما|فروغ|شاملو|رودکی|صائب|بیدل|جامی|ناصرخسرو|باباطاهر|قیصر امین‌پور|hafez|rumi|saadi|ferdowsi|khayyam)/i;
const QUOTE = /(شعر|بیت|غزل|رباعی|قصیده|مثنوی|دوبیتی|مصرع|نقل[‌ ]?قول|سخن|جمله‌ای از|گفته|حدیث|poem|verse|quote)/i;

/** True when the user asks for verses / quotes of a real poet or person (high hallucination risk). */
export function isQuoteRequest(q: string): boolean {
  return QUOTE.test(q) && (POETS.test(q) || /(از|by)\s+\S+/.test(q));
}

/** Extra, last-position instruction for quote requests + a real place to verify the text (Ganjoor). */
export function quoteGuard(q: string): { system: string; source: { title: string; url: string } } {
  return {
    system:
      "هشدار مهم: کاربر شعر یا نقل‌قولِ واقعی از یک شاعر یا شخص خواسته است. فقط اگر متن را کلمه‌به‌کلمه و با اطمینان کامل از حفظ می‌دانی بیاور، و شمارهٔ غزل/صفحه را فقط وقتی مطمئنی بگو. اگر کوچک‌ترین تردیدی داری، هیچ بیتی ننویس و صریحاً بگو «متن دقیق را با اطمینان به یاد ندارم» و کاربر را به جست‌وجو در گنجور (ganjoor.net) راهنمایی کن. هرگز بیت نساز و به شاعر نسبت نده.",
    source: { title: "بررسی متن در گنجور", url: `https://ganjoor.net/search?s=${encodeURIComponent(simplify(q)).slice(0, 300)}` },
  };
}
