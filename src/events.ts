import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import type { Activity } from "./activity.js";
import type { Review } from "./model.js";

export type AgentName = "claude" | "astra";

/** Everything the loop and agents tell the user about, independent of how it is displayed. */
export type LoopEvent =
  | { type: "step"; agent: AgentName; iteration: number; maxIterations: number }
  | { type: "activity"; agent: AgentName; activity: Activity }
  | { type: "decision"; iteration: number; review: Review }
  | { type: "notice"; message: string };

export type Emit = (event: LoopEvent) => void;

export interface Reporter {
  emit: Emit;
  /** Called once the loop has stopped. */
  close(): Promise<void>;
}

// One column in every terminal: no emoji-capable symbols (e.g. ⏺ or ‼, which many terminals draw two wide).
export const ICONS: Record<Activity["kind"], string> = {
  info: "·", text: "●", thinking: "∴", tool: "▸", output: "⎿", error: "✗", limit: "⊘",
};

/**
 * Text for a single terminal row whose width the layout can measure exactly: no escape sequences,
 * no tabs, newlines or other control characters, and symbols that may render as emoji marked as
 * emoji (VS16) so they are measured two wide like terminals draw them.
 */
export function displayText(text: string): string {
  return stripAnsi(text)
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\p{Extended_Pictographic}(?!\uFE0F)/gu, (symbol) => (stringWidth(symbol) === 1 ? `${symbol}\uFE0F` : symbol));
}

export function formatActivity(activity: Activity): string {
  return `${ICONS[activity.kind]} ${displayText(activity.text)}`;
}

/** Line-oriented output for pipes, CI and other non-interactive terminals. */
export function consoleReporter(write: (line: string) => void = console.log): Reporter {
  return {
    emit(event) {
      switch (event.type) {
        case "step":
          write(`[${event.iteration}/${event.maxIterations}] ${event.agent === "claude" ? "claude" : "review"}`);
          break;
        case "activity":
          write(`  ${event.agent.padEnd(6)} │ ${formatActivity(event.activity)}`);
          break;
        case "decision":
          write(`decision: ${event.review.decision} — ${event.review.reason}`);
          break;
        case "notice":
          write(event.message);
          break;
      }
    },
    async close() {},
  };
}
