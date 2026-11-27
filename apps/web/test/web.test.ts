import { describe, expect, it } from "vitest";
import { markdownToDocx, markdownToDocxXml } from "../src/docx";
import { esc, extOf, highlight, parseQuestions, plainText, renderMarkdown } from "../src/markdown";
import { SseParser } from "../src/sse";
import { crc32, makeZip } from "../src/zip";

describe("markdown renderer", () => {
  it("escapes HTML and only links http(s)", () => {
    const r = renderMarkdown('<script>alert(1)</script> [x](javascript:alert(1)) [ok](https://fa.wikipedia.org/wiki/تهران) <img src=x onerror=alert(1)>');
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<img");
    expect(r.html).not.toContain('href="javascript');
    expect(r.html).toContain('<a href="https://fa.wikipedia.org/wiki/تهران" target="_blank" rel="noopener noreferrer">ok</a>');
    expect(esc(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
  });

  it("renders headings, bold, lists (nested), tables, blockquotes", () => {
    const r = renderMarkdown("## عنوان\n**پررنگ** و *کج*\n\n- یک\n  - زیر\n- دو\n\n1. اول\n2. دوم\n\n| نام | سن |\n|---|---|\n| علی | ۳۰ |\n\n> نقل\n");
    expect(r.html).toContain("<h3 dir=\"auto\">عنوان</h3>");
    expect(r.html).toContain("<strong>پررنگ</strong>");
    expect(r.html).toContain("<em>کج</em>");
    expect(r.html).toMatch(/<ul dir="auto"><li>یک<ul dir="auto"><li>زیر<\/li><\/ul><\/li><li>دو<\/li><\/ul>/);
    expect(r.html).toContain("<ol dir=\"auto\"><li>اول</li><li>دوم</li></ol>");
    expect(r.html).toContain("<th dir=\"auto\">نام</th>");
    expect(r.html).toContain("<td dir=\"auto\">۳۰</td>");
    expect(r.html).toContain("<blockquote");
  });

  it("extracts code files with their names and question boxes", () => {
    const md = "این سایت:\n\n**index.html**\n```html\n<h1>سلام</h1>\n```\n\n```python\nprint(1)\n```\n\n```question\n{\"question\":\"سایت برای چیست؟\",\"options\":[\"فروشگاه\",\"شخصی\"]}\n```";
    const r = renderMarkdown(md);
    expect(r.files).toEqual([
      { name: "index.html", lang: "html", ext: "html", code: "<h1>سلام</h1>" },
      { name: "file-2.py", lang: "python", ext: "py", code: "print(1)" },
    ]);
    expect(r.html).toContain('<div class="code" data-file="0"></div>');
    expect(r.html).not.toContain("<h1>سلام</h1>"); // code never rendered as HTML
    expect(r.questions).toEqual([[{ question: "سایت برای چیست؟", options: ["فروشگاه", "شخصی"], multi: false }]]);
    expect(parseQuestions("not json")).toBeNull();
    expect(parseQuestions('{"questions":[{"question":"a","options":[{"label":"x"}],"multi":true}]}')).toEqual([{ question: "a", options: ["x"], multi: true }]);
  });

  it("handles an unterminated code fence while streaming", () => {
    const r = renderMarkdown("```js\nconst a = 1;");
    expect(r.files[0]).toMatchObject({ ext: "js", code: "const a = 1;" });
  });

  it("highlights code safely and maps languages", () => {
    const h = highlight('const s = "<b>"; // note', "js");
    expect(h).toContain('<span class="tk-k">const</span>');
    expect(h).toContain('<span class="tk-s">&quot;&lt;b&gt;&quot;</span>');
    expect(h).toContain('<span class="tk-c">// note</span>');
    expect(highlight("# c\nx = 2", "py")).toContain('<span class="tk-c"># c</span>');
    expect(extOf("python")).toBe("py");
    expect(extOf("")).toBe("txt");
    expect(plainText("## سلام\n**دنیا** [لینک](https://x.y)\n```js\nx\n```")).toBe("سلام\nدنیا لینک");
  });
});

describe("SSE parser", () => {
  it("splits events across chunk boundaries", () => {
    const p = new SseParser();
    expect(p.push('data: {"type":"delta","text":"سل')).toEqual([]);
    expect(p.push('ام"}\n\ndata: {"type":"done"}\n\ndata: [DONE]\n\n')).toEqual([{ type: "delta", text: "سلام" }, { type: "done" }]);
  });
});

describe("zip + docx", () => {
  it("writes a valid stored zip with UTF-8 names", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const z = makeZip([{ name: "سلام.txt", data: "hi" }, { name: "b.md", data: "# x" }]);
    const dv = new DataView(z.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint32(z.length - 22, true)).toBe(0x06054b50);
    expect(dv.getUint16(z.length - 22 + 10, true)).toBe(2);
  });

  it("converts Markdown to a .docx package with RTL paragraphs, headings and tables", () => {
    const xml = markdownToDocxXml("# گزارش\n**مهم**: متن\n\n| a | b |\n|---|---|\n| 1 | 2 |\n- مورد");
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain("<w:bidi/>");
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("• مورد");
    const docx = markdownToDocx("سلام");
    const text = new TextDecoder().decode(docx);
    expect(text).toContain("[Content_Types].xml");
    expect(text).toContain("word/document.xml");
  });
});
