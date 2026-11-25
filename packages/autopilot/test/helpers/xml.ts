/** Minimal XML well-formedness check (tags balanced, attributes quoted, no raw '<' in text). */
export function assertWellFormedXml(xml: string): void {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, "");
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|<!--[\s\S]*?-->|<|&(?!(?:amp|lt|gt|quot|apos|#\d+);)/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  let roots = 0;
  while ((m = re.exec(body))) {
    if (m[0] === "<") throw new Error(`Malformed tag near: ${body.slice(m.index, m.index + 60)}`);
    if (m[0].startsWith("&")) throw new Error(`Unescaped & near: ${body.slice(m.index, m.index + 30)}`);
    if (m[0].startsWith("<!--")) continue;
    const [, close, name, , selfClose] = m;
    if (close) {
      const open = stack.pop();
      if (open !== name) throw new Error(`Mismatched </${name}> (open: ${open})`);
    } else if (!selfClose) {
      if (stack.length === 0) roots += 1;
      stack.push(name!);
    } else if (stack.length === 0) roots += 1;
  }
  if (stack.length) throw new Error(`Unclosed tags: ${stack.join(",")}`);
  if (roots !== 1) throw new Error(`Expected exactly one root element, got ${roots}`);
}
