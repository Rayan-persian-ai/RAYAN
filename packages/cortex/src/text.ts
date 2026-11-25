/** Persian/English text helpers. */

const AR_TO_FA: Record<string, string> = { 'ي': 'ی', 'ى': 'ی', 'ك': 'ک', 'ة': 'ه', 'ۀ': 'ه', 'أ': 'ا', 'إ': 'ا', 'ٱ': 'ا' };
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Normalise for matching: Arabic→Persian letters, digits→ASCII, strip diacritics/tatweel, ZWNJ→space, lowercase. */
export function normalizeText(input: string): string {
  let out = '';
  for (const ch of input) {
    const fa = FA_DIGITS.indexOf(ch);
    const ar = AR_DIGITS.indexOf(ch);
    if (fa >= 0) out += String(fa);
    else if (ar >= 0) out += String(ar);
    else out += AR_TO_FA[ch] ?? ch;
  }
  return out
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '') // harakat + tatweel
    .replace(/\u200C/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const PERSIAN_RE = /[\u0600-\u06FF]/g;
const LATIN_RE = /[A-Za-z]/g;

export function persianRatio(text: string): number {
  const fa = text.match(PERSIAN_RE)?.length ?? 0;
  const en = text.match(LATIN_RE)?.length ?? 0;
  return fa + en === 0 ? 0 : fa / (fa + en);
}

export function detectLanguage(text: string): 'fa' | 'en' | 'mixed' | 'unknown' {
  const fa = text.match(PERSIAN_RE)?.length ?? 0;
  const en = text.match(LATIN_RE)?.length ?? 0;
  if (fa + en === 0) return 'unknown';
  const r = fa / (fa + en);
  return r >= 0.7 ? 'fa' : r <= 0.3 ? 'en' : 'mixed';
}
