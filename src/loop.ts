import { randomUUID } from "node:crypto";
import type { Agents } from "./agents.js";
import type { RunningState, RunState } from "./model.js";
import type { RunStore } from "./store.js";

export async function runLoop(
  store: RunStore,
  agents: Agents,
  signal: AbortSignal,
  report: (message: string) => void = console.log,
): Promise<void> {
  let state: RunState = store.load();
  while (true) {
    signal.throwIfAborted();
    switch (state.stage) {
      case "done":
      case "needs_input":
        report(`${state.stage}: ${state.reason}`);
        return;
      case "claude_running":
        throw new Error("Previous Claude execution was interrupted or failed. Inspect logs, then resume with --retry-worker or --review-worker.");
      case "claude": {
        if (state.iteration > state.max_iterations) {
          report("Maximum iterations reached. Increase --max-iterations with resume to continue.");
          return;
        }
        store.createStep(state.iteration);
        report(`[${state.iteration}/${state.max_iterations}] claude`);
        const running: RunningState = { ...state, stage: "claude_running", session_id: randomUUID() };
        // Persist intent before launch. A failed worker must never replay automatically.
        store.save(running);
        await agents.execute(running, store, signal);
        state = { ...state, stage: "review" };
        break;
      }
      case "review": {
        report(`[${state.iteration}/${state.max_iterations}] review`);
        const review = await agents.review(state, store, signal);
        state = review.decision === "continue"
          ? { ...state, stage: "claude", iteration: state.iteration + 1, next_prompt: review.next_prompt }
          : { ...state, stage: review.decision, reason: review.reason };
        break;
      }
    }
    store.save(state);
  }
}
