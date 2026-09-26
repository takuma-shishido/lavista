import type { Activity } from "../activity.js";
import type { AgentName, LoopEvent, PermissionRequest, Task } from "../events.js";
import type { PlanStage, Review } from "../model.js";

/** Older activity scrolls out of the panes; full logs stay in the run directory. */
const MAX_LINES = 500;

export interface View {
  runId: string;
  runDirectory: string;
  /** Model (and effort) per agent, as shown in the pane title. */
  models: Record<AgentName, string>;
  iteration: number;
  maxIterations: number;
  active?: { agent: AgentName; task: Task; since: number };
  plan: PlanStage[];
  lines: Record<AgentName, Activity[]>;
  decisions: { iteration: number; review: Review }[];
  notice?: string;
  /** The permission request waiting for the user's answer, if any. */
  question?: PermissionRequest;
  status: "running" | "stopping" | "stopped";
}

export function initialView(runId: string, runDirectory: string, models: Record<AgentName, string>, plan: PlanStage[] = []): View {
  return {
    runId, runDirectory, models, iteration: 0, maxIterations: 0, plan,
    lines: { claude: [], astra: [] }, decisions: [], status: "running",
  };
}

function append(view: View, agent: AgentName, activity: Activity): View["lines"] {
  return { ...view.lines, [agent]: [...view.lines[agent], activity].slice(-MAX_LINES) };
}

export function reduce(view: View, event: LoopEvent, now: number): View {
  switch (event.type) {
    case "step":
      return {
        ...view,
        iteration: event.iteration,
        maxIterations: event.maxIterations,
        active: { agent: event.agent, task: event.task, since: now },
        lines: append(view, event.agent, { kind: "info", text: event.task === "plan" ? "── plan ──" : `── iteration ${event.iteration} ──` }),
      };
    case "activity":
      return { ...view, lines: append(view, event.agent, event.activity) };
    case "decision": {
      const { active: _finished, ...idle } = view;
      return { ...idle, decisions: [...view.decisions, { iteration: event.iteration, review: event.review }] };
    }
    case "plan": {
      const { active: _finished, ...idle } = view;
      return { ...idle, plan: event.plan };
    }
    case "notice":
      return { ...view, notice: event.message };
  }
}

/** External store bridging loop events into React (`useSyncExternalStore`). */
export class Feed {
  private view: View;
  private readonly listeners = new Set<() => void>();

  constructor(view: View, private readonly now: () => number = Date.now) {
    this.view = view;
  }

  readonly getSnapshot = (): View => this.view;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispatch(event: LoopEvent): void {
    this.update((view) => reduce(view, event, this.now()));
  }

  update(change: (view: View) => View): void {
    this.view = change(this.view);
    for (const listener of this.listeners) listener();
  }
}
