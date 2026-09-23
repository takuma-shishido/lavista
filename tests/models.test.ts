import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseModels, parseCodexCatalog } from "../src/models.js";
import type { AgentName } from "../src/events.js";

test("Codex catalog lists only models Codex shows in its own picker", () => {
  const catalog = JSON.stringify({ models: [
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", description: "Frontier", visibility: "list", extra: 1 },
    { slug: "codex-auto-review", visibility: "hide" },
    { slug: "gpt-5.5", description: null },
    { name: "missing slug" },
  ] });
  assert.deepEqual(parseCodexCatalog(catalog), [
    { value: "gpt-6-astra", description: "Frontier" },
    { value: "gpt-5.5" },
  ]);
  assert.deepEqual(parseCodexCatalog("not json"), []);
  assert.deepEqual(parseCodexCatalog(JSON.stringify({ other: [] })), []);
});

test("models come from flags or config first, then the picker, then defaults", async () => {
  const asked: AgentName[] = [];
  const pick = async (agent: AgentName) => {
    asked.push(agent);
    return `${agent}-picked`;
  };
  assert.deepEqual(await chooseModels({ claude_model: "opus", astra_model: "gpt-5.5" }, pick),
    { claude_model: "opus", astra_model: "gpt-5.5" });
  assert.deepEqual(asked, []);
  // An empty string is an explicit choice of the CLI default, not "unspecified".
  assert.deepEqual(await chooseModels({ claude_model: "" }, pick), { claude_model: "", astra_model: "astra-picked" });
  assert.deepEqual(asked, ["astra"]);
  assert.deepEqual(await chooseModels({}), { claude_model: "", astra_model: "gpt-6-astra" });
});
