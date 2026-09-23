import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentName } from "../src/events.js";
import { parseState } from "../src/model.js";
import { chooseModels, effortChoices, parseCodexCatalog } from "../src/models.js";
import type { ModelPicker } from "../src/models.js";

const catalog = parseCodexCatalog(JSON.stringify({ models: [
  { slug: "gpt-6-astra", description: "Frontier", visibility: "list", default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "medium" }, { effort: "ultra" }], extra: 1 },
  { slug: "codex-auto-review", visibility: "hide" },
  { slug: "gpt-5.5", description: null, supported_reasoning_levels: [{ effort: "minimal" }, { effort: "low" }] },
  { name: "missing slug" },
] }));

test("Codex catalog lists visible models with their reasoning levels", () => {
  assert.deepEqual(catalog, [
    { value: "gpt-6-astra", description: "Frontier", defaultEffort: "medium",
      efforts: [{ value: "low", description: "Fast" }, { value: "medium" }, { value: "ultra" }] },
    { value: "gpt-5.5", efforts: [{ value: "minimal" }, { value: "low" }] },
  ]);
  assert.deepEqual(parseCodexCatalog("not json"), []);
  assert.deepEqual(parseCodexCatalog(JSON.stringify({ other: [] })), []);
});

test("effort choices follow the chosen model", () => {
  assert.deepEqual(effortChoices("astra", "gpt-5.5", catalog).map((choice) => choice.value), ["minimal", "low"]);
  // Unknown or CLI-default model: every level any Codex model accepts.
  assert.deepEqual(effortChoices("astra", "", catalog).map((choice) => choice.value), ["low", "medium", "ultra", "minimal"]);
  assert.deepEqual(effortChoices("claude", "claude-opus-5-5", []).map((choice) => choice.value), ["low", "medium", "high", "xhigh", "max"]);
});

function recordingPicker(asked: string[]): ModelPicker {
  return {
    model: async (agent: AgentName) => {
      asked.push(`${agent} model`);
      return agent === "claude" ? "claude-opus-5-5" : "gpt-5.5";
    },
    effort: async (agent: AgentName, model: string) => {
      asked.push(`${agent} effort for ${model}`);
      return agent === "claude" ? "high" : "low";
    },
  };
}

test("flags and config win; the rest is picked, model before its effort", async () => {
  const asked: string[] = [];
  assert.deepEqual(await chooseModels({ claude_model: "claude-sonnet-5", astra_effort: "" }, recordingPicker(asked)), {
    claude_model: "claude-sonnet-5", claude_effort: "high", astra_model: "gpt-5.5", astra_effort: "",
  });
  // An empty string is an explicit choice of the CLI default, so it is not asked again.
  assert.deepEqual(asked, ["claude effort for claude-sonnet-5", "astra model"]);
});

test("without a picker everything is left to the CLIs, except Astra's default model", async () => {
  assert.deepEqual(await chooseModels({}), { claude_model: "", claude_effort: "", astra_model: "gpt-6-astra", astra_effort: "" });
  await assert.rejects(chooseModels({ claude_effort: "extreme" }), /Claude effort must be one of/);
});

test("runs saved before effort existed load with CLI-default effort", () => {
  const state = parseState({
    goal: "g", project: "/p", astra_model: "gpt-6-astra", claude_model: "", allowed_tools: "",
    max_iterations: 1, timeout: 10, max_history_bytes: 100, iteration: 1, next_prompt: "g", stage: "claude",
  });
  assert.equal(state.claude_effort, "");
  assert.equal(state.astra_effort, "");
});
