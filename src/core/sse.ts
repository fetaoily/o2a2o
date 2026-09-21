// SSE (Server-Sent Events) framing primitives shared by all stream codecs:
// incremental frame reassembly across chunk boundaries and canonical frame
// encoding (TECH-DESIGN section 10).

export interface SseFrame { event?: string; data: string }

// Accumulates decoded text across chunks and emits each frame once its
// terminating blank line arrives. Rules: lines are separated by "\n" (a
// trailing "\r" from "\r\n" is stripped); a blank line ends the current
// frame; lines starting with ":" are comments; "event:"/"data:" fields
// accumulate into the frame (multiple "data:" lines join with "\n");
// unknown field names are ignored. A trailing partial line stays buffered
// until its newline arrives in a later chunk.
export class SseLineReader {
  private buffer = "";

  push(chunkText: string): SseFrame[] {
    this.buffer += chunkText;
    const frames: SseFrame[] = [];
    let acc: { event?: string; data?: string } | undefined;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (line === "") {
        if (acc !== undefined && (acc.event !== undefined || acc.data !== undefined))
          frames.push(completeFrame(acc));
        acc = undefined;
      } else if (line.startsWith(":")) {
        // comment line: ignored
      } else if (line.startsWith("event:")) {
        acc ??= {};
        acc.event = fieldValue(line.slice("event:".length));
      } else if (line.startsWith("data:")) {
        acc ??= {};
        const value = fieldValue(line.slice("data:".length));
        acc.data = acc.data !== undefined ? acc.data + "\n" + value : value;
      }
    }
    return frames;
  }
}

// A field value excludes a single optional leading space after the colon.
function fieldValue(raw: string): string {
  return raw.startsWith(" ") ? raw.slice(1) : raw;
}

function completeFrame(acc: { event?: string; data?: string }): SseFrame {
  return acc.event !== undefined
    ? { event: acc.event, data: acc.data ?? "" }
    : { data: acc.data ?? "" };
}

// Encodes one SSE frame: "event: x\ndata: y\n\n", or "data: y\n\n" without
// an event name (the openai_chat / openai_responses wire style).
export function encodeSse(data: string, event?: string): string {
  return (event !== undefined ? `event: ${event}\n` : "") + `data: ${data}\n\n`;
}
