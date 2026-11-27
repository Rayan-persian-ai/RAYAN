/** Incremental parser for the API's `data: {json}\n\n` event stream. */
export class SseParser {
  private buf = "";
  push(chunk: string): unknown[] {
    this.buf += chunk;
    const out: unknown[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n\n")) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        out.push(JSON.parse(data));
      } catch {
        /* ignore malformed event */
      }
    }
    return out;
  }
}

/** Reads a fetch Response body as SSE events. */
export async function* readSse(res: Response): AsyncGenerator<any> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const p = new SseParser();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const ev of p.push(dec.decode(value, { stream: true }))) yield ev;
  }
}
