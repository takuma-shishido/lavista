import { randomUUID } from "node:crypto";
import type { Agents } from "./agents.js";
import type { Emit } from "./events.js";
import type { RunningState, RunState } from "./model.js";
import type { RunStore } from "./store.js";

export async function runLoop(
  store: RunStore,
  agents: Agents,
  signal: AbortSignal,
  emit: Emit,
): Promise<void> {
  let state: RunState = store.load();
  while (true) {
    signal.throwIfAborted();
    switch (state.stage) {
      case "done":
      case "needs_input":
        emit({ type: "notice", message: `${state.stage}: ${state.reason}` });
        return;
      case "plan": {
        emit({ type: "step", agent: "astra", task: "plan", iteration: state.iteration, maxIterations: state.max_iterations });
        const review = await agents.plan(state, store, signal);
        emit({ type: "plan", plan: review.plan });
        state = review.decision === "continue"
          ? { ...state, stage: "claude", plan: review.plan, next_prompt: review.next_prompt }
          : { ...state, stage: review.decision, plan: review.plan, reason: review.reason };
        break;
      }
      case "claude_running":
        throw new Error("Previous Claude execution was interrupted or failed. Inspect logs, then run `lavista retry` or `lavista review`.");
      case "claude": {
        if (state.iteration > state.max_iterations) {
          emit({ type: "notice", message: "Maximum iterations reached. Raise max_iterations in .lavista/config.local.json, then run `lavista resume`." });
          return;
        }
        store.createStep(state.iteration);
        emit({ type: "step", agent: "claude", task: "work", iteration: state.iteration, maxIterations: state.max_iterations });
        const running: RunningState = { ...state, stage: "claude_running", session_id: randomUUID() };
        // Persist intent before launch. A failed worker must never replay automatically.
        store.save(running);
        const approved = await agents.execute(running, store, signal);
        state = { ...state, stage: "review", approved_tools: [...state.approved_tools, ...approved] };
        break;
      }
      case "review": {
        emit({ type: "step", agent: "astra", task: "review", iteration: state.iteration, maxIterations: state.max_iterations });
        const review = await agents.review(state, store, signal);
        emit({ type: "decision", iteration: state.iteration, review });
        emit({ type: "plan", plan: review.plan });
        state = review.decision === "continue"
          ? { ...state, stage: "claude", iteration: state.iteration + 1, plan: review.plan, next_prompt: review.next_prompt }
          : { ...state, stage: review.decision, plan: review.plan, reason: review.reason };
        break;
      }
    }
    store.save(state);
  }
}
