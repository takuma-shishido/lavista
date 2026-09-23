// Keep persisted field names compatible with the original Python runs.
export interface RunConfig {
  goal: string;
  project: string;
  astra_model: string;
  claude_model: string;
  allowed_tools: string;
  max_iterations: number;
  timeout: number;
  max_history_bytes: number;
  iteration: number;
  next_prompt: string;
}

export type RunState = RunConfig & (
  | { stage: "claude" }
  | { stage: "claude_running"; session_id: string }
  | { stage: "review" }
  | { stage: "done" | "needs_input"; reason: string }
);

export type Review = {
  decision: "continue" | "done" | "needs_input";
  reason: string;
  next_prompt: string;
};

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

export function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function textField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Invalid field: ${key}`);
  return value;
}

export function parseState(value: unknown): RunState {
  const state = object(value);
  const config: RunConfig = {
    goal: textField(state, "goal"),
    project: textField(state, "project"),
    astra_model: textField(state, "astra_model"),
    claude_model: textField(state, "claude_model"),
    allowed_tools: textField(state, "allowed_tools"),
    next_prompt: textField(state, "next_prompt"),
    max_iterations: positiveInteger(state.max_iterations, "max_iterations"),
    max_history_bytes: positiveInteger(state.max_history_bytes, "max_history_bytes"),
    timeout: positiveInteger(state.timeout, "timeout"),
    iteration: positiveInteger(state.iteration, "iteration"),
  };
  if (config.timeout > 2147483) throw new Error("Timeout exceeds timer limit");
  switch (state.stage) {
    case "claude":
    case "review":
      return { ...config, stage: state.stage };
    case "claude_running":
      return { ...config, stage: state.stage, session_id: textField(state, "session_id") };
    case "done":
    case "needs_input":
      return { ...config, stage: state.stage, reason: textField(state, "reason") };
    default:
      throw new Error("Unknown run stage");
  }
}

export function parseReview(value: unknown): Review {
  const review = object(value);
  if (Object.keys(review).sort().join(",") !== "decision,next_prompt,reason" ||
      typeof review.reason !== "string" || !review.reason.trim() ||
      typeof review.next_prompt !== "string") {
    throw new Error("Invalid Astra response fields");
  }
  if (review.decision !== "continue" && review.decision !== "done" && review.decision !== "needs_input") {
    throw new Error("Invalid Astra decision");
  }
  if (review.decision === "continue" && !review.next_prompt.trim()) {
    throw new Error("Astra returned continue without a next prompt");
  }
  return { decision: review.decision, reason: review.reason, next_prompt: review.next_prompt };
}
