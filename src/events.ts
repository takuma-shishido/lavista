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

const ICONS: Record<Activity["kind"], string> = {
  info: "·", text: "●", thinking: "∴", tool: "⏺", output: "⎿", error: "✗",
};

export function formatActivity(activity: Activity): string {
  return `${ICONS[activity.kind]} ${activity.text}`;
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
