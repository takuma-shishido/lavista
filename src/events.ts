import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import type { Activity } from "./activity.js";
import { formatPlan } from "./model.js";
import type { PlanStage, Review } from "./model.js";

export type AgentName = "claude" | "astra";

/** Astra plans once at the start; after that Claude works and Astra reviews, once per iteration. */
export type Task = "plan" | "work" | "review";

/** Everything the loop and agents tell the user about, independent of how it is displayed. */
export type LoopEvent =
  | { type: "step"; agent: AgentName; task: Task; iteration: number; maxIterations: number }
  | { type: "plan"; plan: PlanStage[] }
  | { type: "activity"; agent: AgentName; activity: Activity }
  | { type: "decision"; iteration: number; review: Review }
  | { type: "notice"; message: string };

export type Emit = (event: LoopEvent) => void;

/** A tool call Claude may make only with the user's approval. */
export interface PermissionRequest {
  tool: string;
  /** The call's most telling argument, e.g. the command for Bash. */
  detail: string;
  reason?: string | undefined;
  /** Rules that would approve calls like this one for the rest of the run, e.g. `Bash(npm test *)`. */
  rules: string[];
}

/** `once`: this call only. `run`: also every matching call for the rest of the run. */
export type PermissionAnswer = "once" | "run" | "deny";

/** Put a request to the user; answered `deny` when nobody can answer or the signal aborts. */
export type AskPermission = (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionAnswer>;

export interface Reporter {
  emit: Emit;
  ask: AskPermission;
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
          write(event.task === "plan" ? "plan" : `[${event.iteration}/${event.maxIterations}] ${event.task === "work" ? "claude" : "review"}`);
          break;
        case "plan":
          write(formatPlan(event.plan));
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
    async ask(request) {
      write(`  claude │ ${formatActivity({ kind: "error", text: `denied (no terminal to ask): ${request.tool} ${request.detail}` })}`);
      return "deny";
    },
    async close() {},
  };
}
