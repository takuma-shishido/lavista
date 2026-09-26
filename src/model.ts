import * as z from "zod";

// Node timers cannot represent delays above a signed 32-bit millisecond value.
export const MAX_TIMEOUT_SECONDS = 2147483;

export const count = z.int().positive();
export const timeoutSeconds = count.max(MAX_TIMEOUT_SECONDS);

// Keep persisted field names compatible with the original Python runs.
/** Levels accepted by `claude --effort`. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/** Chosen once at start and fixed for the run. An empty string means the CLI's own default. */
export const modelSettings = z.object({
  claude_model: z.string(),
  claude_effort: z.enum(["", ...CLAUDE_EFFORTS]),
  astra_model: z.string(),
  // Codex's levels differ per model, so any value its catalog offers is accepted.
  astra_effort: z.string(),
});

/** Re-read from config on every start and resume. */
export const limitSettings = z.object({
  allowed_tools: z.string(),
  max_iterations: count,
  timeout: timeoutSeconds,
});

/** User-tunable settings; also the shape of `.lavista/config*.json`. */
export const runSettings = modelSettings.extend(limitSettings.shape);

export type ModelSettings = z.infer<typeof modelSettings>;
export type LimitSettings = z.infer<typeof limitSettings>;
export type RunSettings = z.infer<typeof runSettings>;

const nonblank = z.string().refine((value) => value.trim() !== "", "must not be blank");

/** One stage of Astra's plan; the first pending stage is the one being worked on. */
export const planStage = z.strictObject({
  title: nonblank,
  /** A concrete, checkable condition; a stage is marked done only when evidence meets it. */
  done_when: nonblank,
  status: z.enum(["pending", "done"]),
});

export type PlanStage = z.infer<typeof planStage>;

const runConfig = runSettings.extend({
  // Runs saved before effort could be chosen used the CLI defaults.
  claude_effort: modelSettings.shape.claude_effort.default(""),
  astra_effort: modelSettings.shape.astra_effort.default(""),
  goal: z.string(),
  project: z.string(),
  iteration: count,
  next_prompt: z.string(),
  // Runs saved before planning had no plan; their next review drafts one.
  plan: z.array(planStage).default([]),
  /** Allow rules the user approved while Claude worked; they apply to every later iteration of the run. */
  approved_tools: z.array(z.string()).default([]),
});

const runState = z.discriminatedUnion("stage", [
  runConfig.extend({ stage: z.literal(["plan", "claude", "review"]) }),
  runConfig.extend({ stage: z.literal("claude_running"), session_id: z.string() }),
  runConfig.extend({ stage: z.literal(["done", "needs_input"]), reason: z.string() }),
]);

export type RunState = z.infer<typeof runState>;
export type RunningState = Extract<RunState, { stage: "claude_running" }>;

const review = z.strictObject({
  decision: z.enum(["continue", "done", "needs_input"]),
  reason: nonblank,
  // The whole plan, as updated by this decision.
  plan: z.array(planStage),
  next_prompt: z.string(),
}).refine((value) => value.decision !== "continue" || value.next_prompt.trim() !== "", {
  message: "continue requires a next prompt",
  path: ["next_prompt"],
  // A goal that cannot be planned without the user's decision is asked about before any stage exists.
}).refine((value) => value.decision === "needs_input" || value.plan.length > 0, {
  message: "the plan must have at least one stage",
  path: ["plan"],
}).refine((value) => value.decision !== "done" || value.plan.every((stage) => stage.status === "done"), {
  message: "done requires every stage of the plan to be done",
  path: ["plan"],
}).refine((value) => value.decision !== "continue" || value.plan.some((stage) => stage.status === "pending"), {
  message: "continue requires a pending stage to work on",
  path: ["plan"],
});

export type Review = z.infer<typeof review>;

/** JSON Schema handed to Codex's structured output, derived from the same validator. */
export const reviewJsonSchema = (() => {
  const { $schema, ...schema } = z.toJSONSchema(review);
  return schema;
})();

export function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`Invalid ${label}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export const parseState = (value: unknown): RunState => parse(runState, value, "run state");
export const parseReview = (value: unknown): Review => parse(review, value, "Astra response");

/**
 * Completed stages are the record of progress: a revision may reopen one, but never drop it.
 * Only a plan not yet drawn up may stay empty.
 */
export function checkPlanRevision(previous: PlanStage[], next: PlanStage[]): void {
  if (previous.length > 0 && next.length === 0) {
    throw new Error("Astra's plan dropped every stage. Run `lavista resume` to ask again.");
  }
  const titles = new Set(next.map((stage) => stage.title));
  const dropped = previous.filter((stage) => stage.status === "done" && !titles.has(stage.title));
  if (dropped.length > 0) {
    throw new Error(`Astra's plan dropped completed stages: ${dropped.map((stage) => `"${stage.title}"`).join(", ")}. Run \`lavista resume\` to ask again.`);
  }
}

export function formatPlan(plan: PlanStage[]): string {
  return plan.map((stage, index) => `[${stage.status === "done" ? "x" : " "}] ${index + 1}. ${stage.title} — done when: ${stage.done_when}`).join("\n");
}
