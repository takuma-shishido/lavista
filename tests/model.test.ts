import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReview, parseState, reviewJsonSchema } from "../src/model.js";

test("review JSON schema is strict so Codex structured output accepts it", () => {
  assert.deepEqual(reviewJsonSchema, {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["continue", "done", "needs_input"] },
      reason: { type: "string" },
      next_prompt: { type: "string" },
    },
    required: ["decision", "reason", "next_prompt"],
    additionalProperties: false,
  });
});

test("review parsing rejects extra fields, blank reasons and empty continue prompts", () => {
  const valid = { decision: "done", reason: "verified", next_prompt: "" };
  assert.deepEqual(parseReview(valid), valid);
  assert.throws(() => parseReview({ ...valid, extra: 1 }), /Invalid Astra response/);
  assert.throws(() => parseReview({ ...valid, reason: " " }), /Invalid Astra response/);
  assert.throws(() => parseReview({ ...valid, decision: "continue" }), /next prompt/);
  assert.throws(() => parseReview({ ...valid, decision: "maybe" }), /Invalid Astra response/);
});

test("state parsing enforces stage-specific fields and numeric limits", () => {
  const base = {
    goal: "g", project: "/p", astra_model: "a", claude_model: "", allowed_tools: "",
    max_iterations: 1, timeout: 10, max_history_bytes: 100, iteration: 1, next_prompt: "g",
  };
  assert.equal(parseState({ ...base, stage: "claude" }).stage, "claude");
  assert.throws(() => parseState({ ...base, stage: "claude_running" }), /session_id/);
  assert.throws(() => parseState({ ...base, stage: "done" }), /reason/);
  assert.throws(() => parseState({ ...base, stage: "unknown" }), /Invalid run state/);
  assert.throws(() => parseState({ ...base, stage: "claude", timeout: 2147484 }), /timeout/);
  assert.throws(() => parseState({ ...base, stage: "claude", iteration: 0 }), /iteration/);
});
