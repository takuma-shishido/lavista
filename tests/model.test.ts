import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPlanRevision, parseReview, parseState, reviewJsonSchema } from "../src/model.js";

test("review JSON schema is strict so Codex structured output accepts it", () => {
  assert.deepEqual(reviewJsonSchema, {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["continue", "done", "needs_input"] },
      reason: { type: "string" },
      plan: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            done_when: { type: "string" },
            status: { type: "string", enum: ["pending", "done"] },
          },
          required: ["title", "done_when", "status"],
          additionalProperties: false,
        },
      },
      next_prompt: { type: "string" },
    },
    required: ["decision", "reason", "plan", "next_prompt"],
    additionalProperties: false,
  });
});

test("review parsing rejects extra fields, blank reasons and empty continue prompts", () => {
  const valid = { decision: "done", reason: "verified", next_prompt: "", plan: [{ title: "t", done_when: "w", status: "done" }] };
  assert.deepEqual(parseReview(valid), valid);
  assert.throws(() => parseReview({ ...valid, extra: 1 }), /Invalid Astra response/);
  assert.throws(() => parseReview({ ...valid, reason: " " }), /Invalid Astra response/);
  assert.throws(() => parseReview({ ...valid, decision: "continue" }), /next prompt/);
  assert.throws(() => parseReview({ ...valid, decision: "maybe" }), /Invalid Astra response/);
});

test("review decisions must agree with the plan", () => {
  const stage = { title: "t", done_when: "w", status: "pending" } as const;
  const review = { decision: "continue", reason: "r", next_prompt: "go", plan: [stage] };
  assert.deepEqual(parseReview(review), review);
  assert.throws(() => parseReview({ ...review, plan: [] }), /at least one stage/);
  assert.throws(() => parseReview({ ...review, decision: "done" }), /every stage of the plan to be done/);
  assert.throws(() => parseReview({ ...review, plan: [{ ...stage, status: "done" }] }), /pending stage/);
  assert.throws(() => parseReview({ ...review, plan: [{ ...stage, done_when: " " }] }), /blank/);
  assert.doesNotThrow(() => parseReview({ ...review, decision: "needs_input", next_prompt: "" }));
  // Asked before planning: there is no stage yet.
  assert.doesNotThrow(() => parseReview({ ...review, decision: "needs_input", next_prompt: "", plan: [] }));
  assert.throws(() => parseReview({ ...review, decision: "done", plan: [] }), /at least one stage/);
});

test("a plan revision may reopen a completed stage but not drop it", () => {
  const finished = { title: "a", done_when: "w", status: "done" } as const;
  assert.doesNotThrow(() => checkPlanRevision([finished], [{ ...finished, status: "pending" }]));
  assert.throws(() => checkPlanRevision([finished], [{ ...finished, title: "b" }]), /dropped completed stages: "a"/);
  assert.doesNotThrow(() => checkPlanRevision([{ ...finished, status: "pending" }], [{ ...finished, title: "b" }]));
  assert.throws(() => checkPlanRevision([{ ...finished, status: "pending" }], []), /dropped every stage/);
  assert.doesNotThrow(() => checkPlanRevision([], []));
});

test("state parsing enforces stage-specific fields and numeric limits", () => {
  const base = {
    goal: "g", project: "/p", astra_model: "a", claude_model: "", allowed_tools: "",
    max_iterations: 1, timeout: 10, iteration: 1, next_prompt: "g",
  };
  assert.equal(parseState({ ...base, stage: "claude" }).stage, "claude");
  // Runs saved before planning existed load with an empty plan.
  assert.deepEqual(parseState({ ...base, stage: "claude" }).plan, []);
  assert.equal(parseState({ ...base, stage: "plan" }).stage, "plan");
  assert.throws(() => parseState({ ...base, stage: "claude_running" }), /session_id/);
  assert.throws(() => parseState({ ...base, stage: "done" }), /reason/);
  assert.throws(() => parseState({ ...base, stage: "unknown" }), /Invalid run state/);
  assert.throws(() => parseState({ ...base, stage: "claude", timeout: 2147484 }), /timeout/);
  assert.throws(() => parseState({ ...base, stage: "claude", iteration: 0 }), /iteration/);
});
