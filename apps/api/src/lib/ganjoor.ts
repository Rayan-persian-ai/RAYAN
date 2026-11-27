/**
 * Real-verse grounding for poetry requests (anti-hallucination): searches Ganjoor (ganjoor.net, the
 * free public archive of Persian poetry) for the poet + topic and hands the model actual couplets with
 * their poem titles and links, so it can quote exactly instead of inventing verses. Never throws.
 */
export const GANJOOR_POETS: [RegExp, number, string][] = [
  [/حافظ|hafez/i, 2, "حافظ"],
  [/سعدی|saadi/i, 7, "سعدی"],
  [/مولوی|مولانا|rumi/i, 5, "مولانا"],
  [/فردوسی|ferdowsi/i, 4, "فردوسی"],
  [/خیام|khayyam/i, 3, "خیام"],
  [/نظامی/, 6, "نظامی"],
  [/عطار/, 9, "عطار"],
  [/پروین/, 8, "پروین اعتصامی"],
  [/شهریار/, 35, "شهریار"],
  [/رودکی/, 12, "رودکی"],
  [/صائب/, 22, "صائب"],
  [/بیدل/, 43, "بیدل"],
  [/جامی/, 24, "جامی"],
  [/ناصرخسرو|ناصر خسرو/, 13, "ناصرخسرو"],
  [/باباطاهر|بابا طاهر/, 28, "باباطاهر"],
];

const DROP = new Set(
  "یک چند دو سه بیت شعر غزل رباعی قصیده مثنوی دوبیتی مصرع از درباره دربارهٔ برای با در به و را که این آن بنویس بگو بیاور بخوان لطفا لطفاً دقیق معروف زیبا کوتاه شمارهٔ شماره منبعش منبع اش اش را هم چیست کدام دیوان"
    .split(" "),
);

export interface Verse {
  title: string;
  url: string;
  couplet: string;
}

export function poetOf(q: string): { id: number; name: string } | null {
  for (const [re, id, name] of GANJOOR_POETS) if (re.test(q)) return { id, name };
  return null;
}

/** Topic words of a poetry request (poet name and request words removed). */
export function topicTerm(q: string): string {
  const words = q
    .replace(/[؟?!.,،:;«»"()]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^(ی|های|ها)$/, ""))
    .filter((w) => w && !DROP.has(w) && !GANJOOR_POETS.some(([re]) => re.test(w)));
  return (words.sort((a, b) => b.length - a.length)[0] ?? "").replace(/[ٔ‌]+$/u, "");
}

/** Couplets (two hemistich lines) of `text` that contain `term`. */
export function coupletsWith(text: string, term: string, max = 2): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < max; i++) {
    if (!lines[i]!.includes(term)) continue;
    const start = i % 2 === 0 ? i : i - 1; // ghazal lines come in pairs
    out.push(`${lines[start]} / ${lines[start + 1] ?? ""}`.trim());
    i = start + 1;
  }
  return out;
}

export async function searchGanjoor(q: string, opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {}): Promise<{ poet: string; term: string; verses: Verse[] } | null> {
  const poet = poetOf(q);
  const term = topicTerm(q);
  if (!poet || term.length < 2) return null;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 4000);
  try {
    const u = `https://api.ganjoor.net/api/ganjoor/poems/search?term=${encodeURIComponent(term)}&poetId=${poet.id}&catId=0&PageNumber=1&PageSize=6`;
    const r = await (opts.fetchFn ?? fetch)(u, { signal: ac.signal, headers: { accept: "application/json", "user-agent": "RAYAN/0.4 (Persian AI assistant)" } });
    if (!r.ok) return { poet: poet.name, term, verses: [] };
    const list = (await r.json()) as { fullTitle?: string; fullUrl?: string; plainText?: string }[];
    const verses: Verse[] = [];
    for (const p of Array.isArray(list) ? list : []) {
      for (const c of coupletsWith(p.plainText ?? "", term, 1)) {
        verses.push({ title: p.fullTitle ?? poet.name, url: `https://ganjoor.net${p.fullUrl ?? ""}`, couplet: c });
      }
      if (verses.length >= 4) break;
    }
    return { poet: poet.name, term, verses };
  } catch {
    return { poet: poet.name, term, verses: [] };
  } finally {
    clearTimeout(t);
  }
}

export function versesPrompt(r: { poet: string; term: string; verses: Verse[] }): string {
  if (!r.verses.length)
    return `در گنجور بیتی از ${r.poet} با واژهٔ «${r.term}» پیدا نشد. هیچ بیتی ننویس و به شاعر نسبت نده؛ صادقانه بگو بیت مطمئنی پیدا نکردی و پیشنهاد کن کاربر در گنجور جست‌وجو کند.`;
  return (
    `بیت‌های واقعی از گنجور (فقط همین‌ها را، کلمه‌به‌کلمه، نقل کن و نام شعر را بگو؛ هیچ بیت یا شمارهٔ دیگری از خودت نساز):\n` +
    r.verses.map((v, i) => `[${i + 1}] ${v.title}: «${v.couplet}»`).join("\n")
  );
}
