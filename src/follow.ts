import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

const POLL_MS = 100;

/**
 * Report lines appended to a file that another process writes, like `tail -f`.
 * `close()` drains whatever is left, so no line written before it is missed.
 */
export class LineFollower {
  private position = 0;
  private partial = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly buffer = Buffer.alloc(64 * 1024);
  private reading: Promise<void> = Promise.resolve();
  private readonly timer: NodeJS.Timeout;

  private constructor(private readonly file: FileHandle, private readonly onLine: (line: string) => void) {
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  static async open(path: string, onLine: (line: string) => void): Promise<LineFollower> {
    return new LineFollower(await open(path, "r"), onLine);
  }

  /** Reads are chained so they never overlap. */
  private poll(): Promise<void> {
    this.reading = this.reading.then(() => this.readAppended());
    return this.reading;
  }

  private async readAppended(): Promise<void> {
    for (;;) {
      const { bytesRead } = await this.file.read(this.buffer, 0, this.buffer.length, this.position);
      if (bytesRead === 0) return;
      this.position += bytesRead;
      this.emitLines(this.decoder.write(this.buffer.subarray(0, bytesRead)));
    }
  }

  /** Complete lines keep their newline; an unterminated tail waits for more text. */
  private emitLines(text: string): void {
    const lines = (this.partial + text).split(/(?<=\n)/);
    this.partial = lines.at(-1)?.endsWith("\n") ? "" : (lines.pop() ?? "");
    for (const line of lines) this.onLine(line);
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    try {
      await this.poll();
      const rest = this.partial + this.decoder.end();
      if (rest) this.onLine(rest);
    } finally {
      await this.file.close();
    }
  }
}
