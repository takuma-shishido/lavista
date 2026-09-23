import assert from "node:assert/strict";
import { test } from "node:test";
import stringWidth from "string-width";
import { claudeModelMismatch, parseClaudeLine, parseCodexLine, summarize } from "../src/activity.js";
import { displayText, ICONS } from "../src/events.js";

const line = (value: unknown) => JSON.stringify(value);

test("Claude stream-json events become readable activity", () => {
  assert.deepEqual(parseClaudeLine(line({ type: "system", subtype: "init", model: "claude-sonnet-5" })),
    [{ kind: "info", text: "session started (claude-sonnet-5)" }]);
  assert.deepEqual(parseClaudeLine(line({ type: "assistant", message: { content: [
    { type: "thinking", thinking: "Plan the change" },
    { type: "text", text: "I'll run the tests." },
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test", description: "Run tests" } },
  ] } })), [
    { kind: "thinking", text: "Plan the change" },
    { kind: "text", text: "I'll run the tests." },
    { kind: "tool", text: "Bash npm test" },
  ]);
  assert.deepEqual(parseClaudeLine(line({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "t1", content: "pass 3\nfail 0\n", is_error: false },
    { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "denied" }], is_error: true },
  ] } })), [
    { kind: "output", text: "pass 3 (+1 lines)" },
    { kind: "error", text: "denied" },
  ]);
  assert.deepEqual(parseClaudeLine(line({ type: "result", subtype: "success", num_turns: 4, duration_ms: 12400, total_cost_usd: 0.1234 })),
    [{ kind: "info", text: "finished: success (4 turns, 12s, $0.12)" }]);
});

test("Codex exec --json events become readable activity", () => {
  assert.deepEqual(parseCodexLine(line({ type: "thread.started", thread_id: "x" })), [{ kind: "info", text: "session started" }]);
  assert.deepEqual(parseCodexLine(line({ type: "item.started", item: { id: "1", type: "command_execution", command: "bash -lc ls", status: "in_progress" } })),
    [{ kind: "tool", text: "$ bash -lc ls" }]);
  assert.deepEqual(parseCodexLine(line({ type: "item.completed", item: { id: "1", type: "command_execution", command: "bash -lc ls", aggregated_output: "a.txt\nb.txt\n", exit_code: 0 } })),
    [{ kind: "output", text: "ok: a.txt (+1 lines)" }]);
  assert.deepEqual(parseCodexLine(line({ type: "item.completed", item: { id: "2", type: "command_execution", command: "false", aggregated_output: "", exit_code: 1 } })),
    [{ kind: "error", text: "exit 1" }]);
  assert.deepEqual(parseCodexLine(line({ type: "item.completed", item: { id: "3", type: "reasoning", text: "Checking tests" } })),
    [{ kind: "thinking", text: "Checking tests" }]);
  assert.deepEqual(parseCodexLine(line({ type: "item.completed", item: { id: "4", type: "agent_message", text: "{\"decision\":\"done\"}" } })),
    [{ kind: "text", text: "{\"decision\":\"done\"}" }]);
  assert.deepEqual(parseCodexLine(line({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } })),
    [{ kind: "info", text: "finished (10 in / 5 out tokens)" }]);
  assert.deepEqual(parseCodexLine(line({ type: "turn.failed", error: { message: "model not found" } })),
    [{ kind: "error", text: "model not found" }]);
});

test("unknown or malformed lines are ignored rather than stopping the run", () => {
  assert.deepEqual(parseClaudeLine("not json"), []);
  assert.deepEqual(parseClaudeLine(line({ type: "stream_event", event: {} })), []);
  assert.deepEqual(parseCodexLine(line({ type: "item.completed", item: { type: "future_item" } })), []);
  assert.equal(summarize("x".repeat(500)).length, 401);
});

test("usage limits are recognised only on error channels", () => {
  assert.deepEqual(parseClaudeLine(line({ type: "assistant", error: "rate_limit",
    message: { content: [{ type: "text", text: "5-hour limit reached ∙ resets 3pm" }] } })),
  [{ kind: "limit", text: "5-hour limit reached ∙ resets 3pm" }]);
  const [result] = parseClaudeLine(line({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1790000000" }));
  assert.equal(result?.kind, "limit");
  assert.match(result?.text ?? "", /^Claude AI usage limit reached \(resets .+\)$/);
  assert.equal(parseClaudeLine(line({ type: "result", subtype: "success", is_error: true, result: "Invalid API key" }))[0]?.kind, "error");
  assert.equal(parseCodexLine(line({ type: "error", message: "You've hit your usage limit. Try again in 2 hours." }))[0]?.kind, "limit");
  assert.equal(parseCodexLine(line({ type: "turn.failed", error: { message: "exceeded retry limit, last status: 429 Too Many Requests" } }))[0]?.kind, "limit");
  // Transient retries and ordinary content must not stop the run.
  assert.equal(parseCodexLine(line({ type: "error", message: "Reconnecting... 1/5 (429 Too Many Requests)" }))[0]?.kind, "error");
  assert.equal(parseClaudeLine(line({ type: "assistant", message: { content: [{ type: "text", text: "I'll add rate limit handling." }] } }))[0]?.kind, "text");
  assert.equal(parseClaudeLine(line({ type: "user", message: { content: [{ type: "tool_result", content: "429 Too Many Requests", is_error: true }] } }))[0]?.kind, "error");
});

test("a different model than the requested full name is flagged", () => {
  const init = (model: string) => line({ type: "system", subtype: "init", model });
  assert.deepEqual(claudeModelMismatch("claude-opus-5-5", init("claude-opus-5")),
    [{ kind: "error", text: "requested claude-opus-5-5, but Claude started claude-opus-5" }]);
  assert.deepEqual(claudeModelMismatch("claude-opus-5-5", init("claude-opus-5-5")), []);
  assert.deepEqual(claudeModelMismatch("claude-haiku-4-5", init("claude-haiku-4-5-20251001")), []);
  assert.deepEqual(claudeModelMismatch("opus", init("claude-opus-5")), []);
  assert.deepEqual(claudeModelMismatch("", init("claude-opus-5")), []);
  assert.deepEqual(claudeModelMismatch("claude-opus-5-5", line({ type: "result", subtype: "success" })), []);
});

test("icons are one column in every terminal and text is made measurable", () => {
  for (const icon of Object.values(ICONS)) {
    assert.equal(stringWidth(icon), 1, icon);
    assert.ok(!/\p{Extended_Pictographic}/u.test(icon), `${icon} may render as a two-column emoji`);
  }
  assert.equal(displayText("1\t---"), "1  ---");
  assert.equal(displayText("\u001b[31mred\u001b[0m\r\nnext\u0007"), "red next ");
  assert.equal(displayText("⏺ ok"), "⏺️ ok");
  assert.equal(stringWidth(displayText("⏺ ok")), 5);
  assert.equal(displayText("✅ already emoji"), "✅ already emoji");
  assert.equal(displayText("⏺️ kept"), "⏺️ kept");
});
