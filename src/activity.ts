import { z } from "zod";

/** One human-readable thing an agent did, derived from a line of its JSON event stream. */
export interface Activity {
  /** `limit`: the agent cannot continue until a usage/rate limit or billing problem is resolved. */
  kind: "info" | "text" | "thinking" | "tool" | "output" | "error" | "limit";
  text: string;
}

const MAX_TEXT = 400;

/** Collapse to one line: first non-empty line, with a count of what was cut. */
export function summarize(value: string): string {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const clipped = first.length > MAX_TEXT ? `${first.slice(0, MAX_TEXT)}…` : first;
  return lines.length > 1 ? `${clipped} (+${lines.length - 1} lines)` : clipped;
}

const LIMIT = /usage limit|limit reached|rate.?limit|quota|too many requests|\b429\b|credit balance|billing|out of credits/i;
// Transient retries the CLI handles itself; stopping on these would abort runs that recover.
const RETRYING = /reconnecting|retrying/i;

/**
 * Classify a message from an agent's *error channel* (never tool output or prose,
 * where words like "rate limit" are ordinary content).
 */
export function errorActivity(message: string): Activity {
  const text = summarize(message);
  return { kind: LIMIT.test(message) && !RETRYING.test(message) ? "limit" : "error", text };
}

function parseLine<T>(schema: z.ZodType<T>, line: string): T | undefined {
  try {
    const result = schema.safeParse(JSON.parse(line));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

// ---- Claude Code `--output-format stream-json` ----

const toolInput = z.record(z.string(), z.unknown());

/** The most telling argument of a tool call, e.g. the command for Bash or the path for Edit. */
export function describeInput(input: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return JSON.stringify(input);
}

const claudeBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), thinking: z.string() }),
  z.object({ type: z.literal("tool_use"), name: z.string(), input: toolInput }),
  z.object({
    type: z.literal("tool_result"),
    is_error: z.boolean().optional(),
    content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]).optional(),
  }),
]);

const claudeEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("system"), subtype: z.string(), model: z.string().optional() }),
  z.object({
    type: z.literal(["assistant", "user"]),
    message: z.object({ content: z.array(z.unknown()) }),
    // Set on synthetic messages reporting an API failure, e.g. "rate_limit" or "billing_error".
    error: z.string().optional(),
  }),
  // Written by lavista: the turn ended while Claude's background work still runs.
  z.object({ type: z.literal("lavista_waiting"), tasks: z.array(z.string()) }),
  z.object({
    type: z.literal("result"),
    subtype: z.string(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    num_turns: z.number().optional(),
    total_cost_usd: z.number().optional(),
    duration_ms: z.number().optional(),
  }),
]);

function claudeBlockActivity(value: unknown): Activity | undefined {
  const block = claudeBlock.safeParse(value);
  if (!block.success) return undefined;
  const { data } = block;
  switch (data.type) {
    case "text": return { kind: "text", text: summarize(data.text) };
    case "thinking": return { kind: "thinking", text: summarize(data.thinking) };
    case "tool_use": return { kind: "tool", text: `${data.name} ${summarize(describeInput(data.input))}` };
    case "tool_result": {
      const content = typeof data.content === "string"
        ? data.content
        : (data.content ?? []).map((part) => part.text ?? `[${part.type}]`).join("\n");
      return { kind: data.is_error ? "error" : "output", text: summarize(content) || "(no output)" };
    }
  }
}

export function parseClaudeLine(line: string): Activity[] {
  const event = parseLine(claudeEvent, line);
  switch (event?.type) {
    case undefined:
      return [];
    case "system":
      return event.subtype === "init" ? [{ kind: "info", text: `session started${event.model ? ` (${event.model})` : ""}` }] : [];
    case "assistant":
    case "user": {
      const activities = event.message.content.flatMap((block) => claudeBlockActivity(block) ?? []);
      if (event.error === undefined) return activities;
      const message = activities.map((activity) => activity.text).join(" ") || event.error;
      const limited = event.error === "rate_limit" || event.error === "billing_error";
      return [limited ? { kind: "limit", text: summarize(message) } : errorActivity(`${event.error}: ${message}`)];
    }
    case "lavista_waiting":
      return [{ kind: "info", text: summarize(`waiting for background work: ${event.tasks.join(", ")}`) }];
    case "result": {
      if (event.is_error) return [errorActivity(withResetTime(event.result ?? event.subtype))];
      const details = [
        event.num_turns !== undefined ? `${event.num_turns} turns` : undefined,
        event.duration_ms !== undefined ? `${Math.round(event.duration_ms / 1000)}s` : undefined,
        event.total_cost_usd !== undefined ? `$${event.total_cost_usd.toFixed(2)}` : undefined,
      ].filter(Boolean).join(", ");
      const text = `finished: ${event.subtype}${details ? ` (${details})` : ""}`;
      return [{ kind: event.subtype === "success" ? "info" : "error", text }];
    }
  }
}

/** Claude reports usage limits as "…|<unix seconds>"; show the reset time readably. */
function withResetTime(message: string): string {
  const match = /^(.*)\|(\d{10})$/.exec(message.trim());
  if (!match) return message;
  return `${match[1]} (resets ${new Date(Number(match[2]) * 1000).toLocaleString()})`;
}

/**
 * Warn when Claude starts a different model than the full name requested, e.g. an older one.
 * Aliases such as `opus` are resolved by the CLI and cannot be compared.
 */
export function claudeModelMismatch(requested: string, line: string): Activity[] {
  const event = parseLine(claudeEvent, line);
  if (event?.type !== "system" || event.subtype !== "init" || !event.model) return [];
  if (!requested.startsWith("claude-") || event.model.startsWith(requested)) return [];
  return [{ kind: "error", text: `requested ${requested}, but Claude started ${event.model}` }];
}

// ---- Codex `exec --json` ----

const codexItem = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_message"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({
    type: z.literal("command_execution"),
    command: z.string(),
    aggregated_output: z.string().optional(),
    exit_code: z.number().nullable().optional(),
  }),
  z.object({ type: z.literal("file_change"), changes: z.array(z.object({ path: z.string() })) }),
  z.object({ type: z.literal("mcp_tool_call"), server: z.string(), tool: z.string() }),
  z.object({ type: z.literal("web_search"), query: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

const codexEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thread.started") }),
  z.object({ type: z.literal(["item.started", "item.completed"]), item: z.unknown() }),
  z.object({
    type: z.literal("turn.completed"),
    usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
  }),
  z.object({ type: z.literal("turn.failed"), error: z.object({ message: z.string() }) }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

function codexItemActivity(phase: "item.started" | "item.completed", value: unknown): Activity | undefined {
  const item = codexItem.safeParse(value);
  if (!item.success) return undefined;
  const { data } = item;
  // Commands are shown when they start and again with their result; everything else once, when complete.
  if (phase === "item.started") {
    return data.type === "command_execution" ? { kind: "tool", text: `$ ${summarize(data.command)}` } : undefined;
  }
  switch (data.type) {
    case "agent_message": return { kind: "text", text: summarize(data.text) };
    case "reasoning": return { kind: "thinking", text: summarize(data.text) };
    case "command_execution": {
      const output = summarize(data.aggregated_output ?? "");
      const failed = data.exit_code !== undefined && data.exit_code !== null && data.exit_code !== 0;
      return { kind: failed ? "error" : "output", text: `${failed ? `exit ${data.exit_code}` : "ok"}${output ? `: ${output}` : ""}` };
    }
    case "file_change": return { kind: "tool", text: `edit ${data.changes.map((change) => change.path).join(", ")}` };
    case "mcp_tool_call": return { kind: "tool", text: `${data.server}.${data.tool}` };
    case "web_search": return { kind: "tool", text: `search ${data.query}` };
    case "error": return errorActivity(data.message);
  }
}

export function parseCodexLine(line: string): Activity[] {
  const event = parseLine(codexEvent, line);
  switch (event?.type) {
    case undefined:
      return [];
    case "thread.started":
      return [{ kind: "info", text: "session started" }];
    case "item.started":
    case "item.completed":
      return [codexItemActivity(event.type, event.item) ?? []].flat();
    case "turn.completed":
      return [{ kind: "info", text: event.usage
        ? `finished (${event.usage.input_tokens} in / ${event.usage.output_tokens} out tokens)`
        : "finished" }];
    case "turn.failed":
      return [errorActivity(event.error.message)];
    case "error":
      return [errorActivity(event.message)];
  }
}
