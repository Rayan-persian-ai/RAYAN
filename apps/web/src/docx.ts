/** Markdown → real Word (.docx) in the browser (headings, paragraphs, lists, tables, bold), RTL-aware. */
import { makeZip } from "./zip";

const x = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const RTL = /[\u0600-\u06FF]/;

function runs(text: string, rtl: boolean): string {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part) => {
      const bold = /^\*\*[^*]+\*\*$/.test(part);
      const t = (bold ? part.slice(2, -2) : part).replace(/`/g, "");
      return `<w:r><w:rPr>${bold ? "<w:b/><w:bCs/>" : ""}${rtl ? "<w:rtl/>" : ""}<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Tahoma"/></w:rPr><w:t xml:space="preserve">${x(t)}</w:t></w:r>`;
    })
    .join("");
}
function para(text: string, style = ""): string {
  const rtl = RTL.test(text);
  return `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${rtl ? '<w:bidi/><w:jc w:val="right"/>' : ""}</w:pPr>${runs(text, rtl)}</w:p>`;
}

export function markdownToDocxXml(md: string): string {
  const body: string[] = [];
  const lines = md.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim() || /^```/.test(l)) continue;
    const h = l.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      body.push(para(h[2]!, `Heading${h[1]!.length}`));
      continue;
    }
    if (l.includes("|") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const rows = [l];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|")) rows.push(lines[i++]!);
      i--;
      const cellsOf = (r: string) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      body.push(
        `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>${RTL.test(l) ? "<w:bidiVisual/>" : ""}<w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${rows
          .map((r) => `<w:tr>${cellsOf(r).map((c) => `<w:tc>${para(c)}</w:tc>`).join("")}</w:tr>`)
          .join("")}</w:tbl>`,
      );
      continue;
    }
    const li = l.match(/^\s*([-*+•]|\d+[.)])\s+(.*)$/);
    if (li) {
      body.push(para(`${/\d/.test(li[1]!) ? li[1] : "•"} ${li[2]}`));
      continue;
    }
    body.push(para(l.replace(/^>\s?/, "")));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr/></w:body></w:document>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${[1, 2, 3]
  .map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="${36 - n * 4}"/><w:szCs w:val="${36 - n * 4}"/></w:rPr></w:style>`)
  .join("")}</w:styles>`;

export function markdownToDocx(md: string): Uint8Array {
  return makeZip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/_rels/document.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "word/document.xml", data: markdownToDocxXml(md) },
    { name: "word/styles.xml", data: STYLES },
  ]);
}
