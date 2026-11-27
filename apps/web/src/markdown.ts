/**
 * Safe Markdown → HTML for AI answers (GFM subset: headings, bold/italic, inline code, fenced code,
 * nested lists, tables, blockquotes, links, hr) plus RAYAN extras: file names before code blocks
 * (**index.html**) and ```question blocks (clarifying multiple-choice boxes). Everything is escaped
 * first; only http(s) links survive. Pure string functions — unit-tested without a DOM.
 */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface CodeFile {
  name: string;
  lang: string;
  ext: string;
  code: string;
}
export interface Question {
  question: string;
  options: string[];
  multi: boolean;
}

const EXT: Record<string, string> = {
  html: "html", htm: "html", svg: "svg", xml: "xml", markdown: "md", md: "md", json: "json", csv: "csv", tsv: "tsv",
  python: "py", py: "py", javascript: "js", js: "js", jsx: "jsx", typescript: "ts", ts: "ts", tsx: "tsx", css: "css",
  bash: "sh", sh: "sh", shell: "sh", sql: "sql", yaml: "yml", yml: "yml", java: "java", c: "c", cpp: "cpp", "c++": "cpp",
  csharp: "cs", cs: "cs", go: "go", rust: "rs", rs: "rs", php: "php", ruby: "rb", kotlin: "kt", swift: "swift", toml: "toml",
  ini: "ini", text: "txt", txt: "txt", plaintext: "txt", docx: "docx", pdf: "pdf",
};
export const extOf = (lang: string) => EXT[lang.toLowerCase()] ?? (/^[a-z0-9]{1,6}$/i.test(lang) ? lang.toLowerCase() : "txt");
const FILE_RE = /([\w\u0600-\u06FF][\w\u0600-\u06FF.\-]*\.(html?|svg|md|json|csv|tsv|py|js|jsx|ts|tsx|css|txt|sh|sql|ya?ml|java|c|cpp|cs|go|rs|php|rb|kt|swift|xml|toml|ini|docx|pdf))\b/i;

/** Parses a ```question block (one or {questions:[…]}) into at most 3 questions; null when invalid. */
export function parseQuestions(raw: string): Question[] | null {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  const arr: any[] = Array.isArray(j) ? j : Array.isArray((j as any)?.questions) ? (j as any).questions : [j];
  const qs = arr
    .filter((q) => q && typeof q.question === "string" && q.question.trim())
    .slice(0, 3)
    .map((q) => ({
      question: String(q.question).trim().slice(0, 300),
      options: (Array.isArray(q.options) ? q.options : [])
        .map((o: unknown) => String(typeof o === "object" && o ? ((o as any).label ?? (o as any).text ?? "") : o).trim())
        .filter(Boolean)
        .slice(0, 8)
        .map((o: string) => o.slice(0, 120)),
      multi: !!q.multi,
    }));
  return qs.length ? qs : null;
}

function inline(s: string): string {
  // protect inline code first
  const codes: string[] = [];
  let t = s.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    codes.push(`<code dir="ltr">${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = esc(t);
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre: string, url: string) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]!);
}

const LIST_RE = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;
const SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export interface Rendered {
  html: string;
  files: CodeFile[];
  questions: Question[][];
}

/** Renders Markdown. Code blocks become <div class="code" data-file="i"> placeholders the UI decorates. */
export function renderMarkdown(src: string): Rendered {
  const files: CodeFile[] = [];
  const questions: Question[][] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let pendingName: string | null = null;
  const flush = () => {
    if (para.length) out.push(`<p dir="auto">${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const fence = l.match(/^\s*(`{3,}|~{3,})\s*([\w+#.\-]*)\s*$/);
    if (fence) {
      flush();
      const close = fence[1]!;
      const lang = fence[2] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(close)) body.push(lines[i++]!);
      i++; // closing fence (or EOF while streaming)
      const code = body.join("\n");
      if (lang.toLowerCase() === "question" || lang.toLowerCase() === "questions") {
        const q = parseQuestions(code);
        if (q) {
          questions.push(q);
          out.push(`<div class="qbox" data-q="${questions.length - 1}"></div>`);
          continue;
        }
      }
      const ext = extOf(lang || "txt");
      const name = pendingName ?? `file-${files.length + 1}.${ext}`;
      pendingName = null;
      files.push({ name, lang: lang || "text", ext: pendingNameExt(name) ?? ext, code });
      out.push(`<div class="code" data-file="${files.length - 1}"></div>`);
      continue;
    }
    // a line that is just a file name (**index.html** / `report.csv` / index.html:) names the next code block
    const nameOnly = l.trim().replace(/^[#>*`\s]+|[*`:\s]+$/g, "");
    if (nameOnly && nameOnly.length < 80 && FILE_RE.test(nameOnly) && nameOnly.match(FILE_RE)![0] === nameOnly.split(/\s/).pop()) {
      const next = lines.slice(i + 1).find((x) => x.trim());
      if (next && /^\s*(`{3,}|~{3,})/.test(next)) {
        flush();
        pendingName = nameOnly.match(FILE_RE)![0];
        out.push(`<p class="file-name" dir="ltr"><strong>${esc(pendingName)}</strong></p>`);
        i++;
        continue;
      }
    }
    const hd = l.match(/^(#{1,6})\s+(.*)$/);
    if (hd) {
      flush();
      const n = Math.min(6, hd[1]!.length + 1);
      out.push(`<h${n} dir="auto">${inline(hd[2]!)}</h${n}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(l)) {
      flush();
      out.push("<hr>");
      i++;
      continue;
    }
    if (l.includes("|") && i + 1 < lines.length && SEP_RE.test(lines[i + 1]!)) {
      flush();
      const head = cells(l);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th dir="auto">${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_h, k) => `<td dir="auto">${inline(r[k] ?? "")}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (/^>\s?/.test(l)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^>\s?/, ""));
      const inner = renderMarkdown(q.join("\n"));
      out.push(`<blockquote dir="auto">${inner.html}</blockquote>`);
      continue;
    }
    if (LIST_RE.test(l)) {
      flush();
      const [html, next] = list(lines, i);
      out.push(html);
      i = next;
      continue;
    }
    if (!l.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(l);
    i++;
  }
  flush();
  return { html: out.join(""), files, questions };
}

function pendingNameExt(name: string): string | null {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1]!.toLowerCase().replace(/^htm$/, "html") : null;
}

function list(lines: string[], start: number): [string, number] {
  const first = lines[start]!.match(LIST_RE)!;
  const indent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i]!.match(LIST_RE);
    if (!m) {
      if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length) {
        items[items.length - 1] += "<br>" + inline(lines[i]!.trim());
        i++;
        continue;
      }
      break;
    }
    const ind = m[1]!.length;
    if (ind < indent) break;
    if (ind > indent) {
      const [sub, next] = list(lines, i);
      if (items.length) items[items.length - 1] += sub;
      else items.push(sub);
      i = next;
      continue;
    }
    items.push(inline(m[3]!));
    i++;
  }
  const tag = ordered ? "ol" : "ul";
  return [`<${tag} dir="auto">${items.map((x) => `<li>${x}</li>`).join("")}</${tag}>`, i];
}

/** Plain text for copy / text-to-speech (strips Markdown punctuation). */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*`>|_~]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+\n/g, "\n")
    .trim();
}

const KW = new Set(
  "abstract and as async await break case catch class const continue def default del delete do elif else enum except export extends false final finally for from func function go if import in instanceof interface is lambda let match new nil none not null of or package pass private protected public raise return self static struct super switch this throw true try type typeof var void while with yield True False None".split(" "),
);
/** Minimal, escape-safe syntax highlighting (comments, strings, numbers, keywords). */
export function highlight(code: string, ext: string): string {
  const lineComment = ["py", "sh", "yml", "toml", "rb"].includes(ext) ? "#" : ext === "sql" ? "--" : "//";
  const re = new RegExp(
    `(${lineComment === "#" ? "#[^\\n]*" : lineComment === "--" ? "--[^\\n]*" : "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/"}|<!--[\\s\\S]*?-->)|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|(\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_][A-Za-z0-9_]*)`,
    "g",
  );
  let outStr = "";
  let last = 0;
  for (const m of code.matchAll(re)) {
    outStr += esc(code.slice(last, m.index));
    const [tok, com, str, numb, word] = m;
    if (com) outStr += `<span class="tk-c">${esc(com)}</span>`;
    else if (str) outStr += `<span class="tk-s">${esc(str)}</span>`;
    else if (numb) outStr += `<span class="tk-n">${esc(numb)}</span>`;
    else if (word && KW.has(word)) outStr += `<span class="tk-k">${esc(word)}</span>`;
    else outStr += esc(tok);
    last = m.index! + tok.length;
  }
  return outStr + esc(code.slice(last));
}
