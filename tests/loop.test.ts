import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgents, UsageLimitError } from "../src/agents.js";
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
  const runner: ProcessRunner = async ({ command, args, input, stdoutPath }) => {
    if (command === "claude") {
      sessions.push(args[args.indexOf("--session-id") + 1]!);
      writeFileSync(stdoutPath, JSON.stringify({ type: "result", subtype: "success", result: `evidence ${sessions.length}` }));
    } else {
      prompts.push(input);
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
  assert.match(readFileSync(store.step(2).prompt, "utf8"), /Finish result.txt/);
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

test("a usage limit stops the CLI immediately and the loop without reviewing", async (t) => {
  const store = fixture(t);
  const commands: string[] = [];
  const runner: ProcessRunner = async ({ command, onLine, signal }) => {
    commands.push(command);
    onLine?.(JSON.stringify({ type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "5-hour limit reached" }] } }) + "\n");
    // Like a CLI that keeps waiting: only the limit-triggered abort ends it.
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    throw new Error("aborted");
  };
  await assert.rejects(runLoop(store, createAgents(runner), signal(), quiet),
    (error) => error instanceof UsageLimitError && /5-hour limit reached[\s\S]*lavista retry/.test(error.message));
  assert.deepEqual(commands, ["claude"]);
  assert.equal(store.load().stage, "claude_running");
});

test("an Astra usage limit found only in stderr keeps the review resumable", async (t) => {
  const store = fixture(t);
  const runner: ProcessRunner = async ({ command, stdoutPath, stderrPath }) => {
    if (command === "claude") {
      writeFileSync(stdoutPath, JSON.stringify({ type: "result", subtype: "success" }));
      return;
    }
    writeFileSync(stderrPath, "ERROR: You've hit your usage limit. Try again in 3 days.\n");
    throw new Error("codex exited 1");
  };
  await assert.rejects(runLoop(store, createAgents(runner), signal(), quiet),
    (error) => error instanceof UsageLimitError && /Astra[\s\S]*usage limit[\s\S]*lavista resume/.test(error.message));
  assert.equal(store.load().stage, "review");
});

test("model flags are passed only when a model was chosen", async (t) => {
  const store = fixture(t);
  store.save({ ...store.load(), claude_model: "opus", astra_model: "" });
  const argsBy: Record<string, string[]> = {};
  const runner: ProcessRunner = async ({ command, args, stdoutPath }) => {
    argsBy[command] = args;
    if (command === "claude") writeFileSync(stdoutPath, JSON.stringify({ type: "result", subtype: "success" }));
    else writeFileSync(args[args.indexOf("--output-last-message") + 1]!, JSON.stringify({ decision: "done", reason: "ok", next_prompt: "" }));
  };
  await runLoop(store, createAgents(runner), signal(), quiet);
  assert.deepEqual(argsBy.claude?.slice(argsBy.claude.indexOf("--model"), argsBy.claude.indexOf("--model") + 2), ["--model", "opus"]);
  assert.ok(!argsBy.codex?.includes("--model"));
});
