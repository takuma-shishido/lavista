import { z } from "zod";

// Node timers cannot represent delays above a signed 32-bit millisecond value.
export const MAX_TIMEOUT_SECONDS = 2147483;

export const count = z.int().positive();
export const timeoutSeconds = count.max(MAX_TIMEOUT_SECONDS);

// Keep persisted field names compatible with the original Python runs.
const runConfig = z.object({
  goal: z.string(),
  project: z.string(),
  astra_model: z.string(),
  claude_model: z.string(),
  allowed_tools: z.string(),
  max_iterations: count,
  timeout: timeoutSeconds,
  max_history_bytes: count,
  iteration: count,
  next_prompt: z.string(),
});

const runState = z.discriminatedUnion("stage", [
  runConfig.extend({ stage: z.literal(["claude", "review"]) }),
  runConfig.extend({ stage: z.literal("claude_running"), session_id: z.string() }),
  runConfig.extend({ stage: z.literal(["done", "needs_input"]), reason: z.string() }),
]);

export type RunState = z.infer<typeof runState>;
export type RunningState = Extract<RunState, { stage: "claude_running" }>;

const nonblank = z.string().refine((value) => value.trim() !== "", "must not be blank");

const review = z.strictObject({
  decision: z.enum(["continue", "done", "needs_input"]),
  reason: nonblank,
  next_prompt: z.string(),
}).refine((value) => value.decision !== "continue" || value.next_prompt.trim() !== "", {
  message: "continue requires a next prompt",
  path: ["next_prompt"],
});

export type Review = z.infer<typeof review>;

/** JSON Schema handed to Codex's structured output, derived from the same validator. */
export const reviewJsonSchema = (() => {
  const { $schema, ...schema } = z.toJSONSchema(review);
  return schema;
})();

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`Invalid ${label}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export const parseState = (value: unknown): RunState => parse(runState, value, "run state");
export const parseReview = (value: unknown): Review => parse(review, value, "Astra response");
