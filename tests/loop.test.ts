import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgents } from "../src/agents.js";
import { runLoop } from "../src/loop.js";
import type { RunState } from "../src/model.js";
import type { ProcessRunner } from "../src/process.js";
import { RunStore } from "../src/store.js";

function fixture(t: { after: (fn: () => void) => void }): RunStore {
  const directory = mkdtempSync(join(tmpdir(), "lavista-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RunStore(directory);
  const state: RunState = {
    goal: "Create result.txt", project: directory, stage: "claude", iteration: 1,
    next_prompt: "Create result.txt", astra_model: "gpt-6-astra", claude_model: "",
    allowed_tools: "", max_iterations: 3, timeout: 10, max_history_bytes: 100000,
  };
  store.save(state);
  return store;
}

const signal = () => new AbortController().signal;
const quiet = () => {};

test("each iteration uses a fresh session and review includes all earlier evidence", async (t) => {
  const store = fixture(t);
  const sessions: string[] = [];
  const prompts: string[] = [];
  const runner: ProcessRunner = async ({ command, args, prompt, logPrefix }) => {
    if (command === "claude") {
      sessions.push(args[args.indexOf("--session-id") + 1]!);
      writeFileSync(`${logPrefix}.jsonl`, JSON.stringify({ type: "result", subtype: "success", result: `evidence ${sessions.length}` }));
    } else {
      prompts.push(prompt);
      writeFileSync(args[args.indexOf("--output-last-message") + 1]!, JSON.stringify({
        decision: prompts.length === 1 ? "continue" : "done", reason: "verified", next_prompt: "Finish result.txt",
      }));
    }
  };
  await runLoop(store, createAgents(runner), signal(), quiet);
  assert.equal(store.load().stage, "done");
  assert.equal(new Set(sessions).size, 2);
  assert.match(prompts[1]!, /evidence 1/);
  assert.match(prompts[1]!, /evidence 2/);
  assert.match(readFileSync(join(store.step(2), "prompt.txt"), "utf8"), /Finish result.txt/);
});

test("failed worker is persisted and never replayed by ordinary resume", async (t) => {
  const store = fixture(t);
  let calls = 0;
  const agents = createAgents(async () => { calls++; throw new Error("failed"); });
  await assert.rejects(runLoop(store, agents, signal(), quiet), /failed/);
  assert.equal(store.load().stage, "claude_running");
  await assert.rejects(runLoop(store, agents, signal(), quiet), /Previous Claude execution/);
  assert.equal(calls, 1);
});

test("iteration limit stops a continuing review before another worker starts", async (t) => {
  const store = fixture(t);
  store.save({ ...store.load(), max_iterations: 1 });
  let workers = 0;
  await runLoop(store, {
    async execute() { workers++; },
    async review() { return { decision: "continue", reason: "more work", next_prompt: "next task" }; },
  }, signal(), quiet);
  assert.equal(workers, 1);
  assert.equal(store.load().iteration, 2);
  assert.equal(store.load().stage, "claude");
});
