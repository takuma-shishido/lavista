import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { concurrentRun, createAgents, UsageLimitError } from "../src/agents.js";
import type { Runners } from "../src/agents.js";
import type { ClaudeInvocation } from "../src/claude.js";
import type { LoopEvent } from "../src/events.js";
import { runLoop } from "../src/loop.js";
import type { RunState } from "../src/model.js";
import type { ProcessRunner } from "../src/process.js";
import { readJson, RunStore } from "../src/store.js";

function fixture(t: { after: (fn: () => void) => void }): RunStore {
  const directory = mkdtempSync(join(tmpdir(), "lavista-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RunStore(directory);
  const state: RunState = {
    goal: "Create result.txt", project: directory, stage: "claude", iteration: 1,
    next_prompt: "Create result.txt", astra_model: "gpt-6-astra", claude_model: "", claude_effort: "", astra_effort: "",
    allowed_tools: "", max_iterations: 3, timeout: 10, plan: [], approved_tools: [],
  };
  store.save(state);
  return store;
}

const pending = { title: "Create result.txt", done_when: "result.txt exists", status: "pending" } as const;
const done = { ...pending, status: "done" } as const;

const signal = () => new AbortController().signal;
const quiet = () => {};

/** A successful Claude step, as its final stream-json event. */
const succeed = (path: string, extra: Record<string, unknown> = {}) =>
  writeFileSync(path, JSON.stringify({ type: "result", subtype: "success", ...extra }));
const succeedClaude = async ({ eventsPath }: ClaudeInvocation) => succeed(eventsPath);

test("each iteration uses a fresh session and review includes all earlier evidence", async (t) => {
  const store = fixture(t);
  const sessions: string[] = [];
  const prompts: string[] = [];
  const runners: Runners = {
    async claude({ sessionId, eventsPath }) {
      sessions.push(sessionId);
      succeed(eventsPath, { result: `evidence ${sessions.length}` });
    },
    async process({ args, input }) {
      prompts.push(input);
      writeFileSync(args[args.indexOf("--output-last-message") + 1]!, JSON.stringify({
        decision: prompts.length === 1 ? "continue" : "done", reason: "verified", next_prompt: "Finish result.txt",
        plan: [prompts.length === 1 ? pending : done],
      }));
    },
  };
  await runLoop(store, createAgents(runners), signal(), quiet);
  assert.equal(store.load().stage, "done");
  assert.equal(new Set(sessions).size, 2);
  // Astra gets every iteration's log by path, not its contents.
  assert.doesNotMatch(prompts[1]!, /evidence \d/);
  assert.ok(prompts[1]!.includes(JSON.stringify(store.step(1).claudeEvents)));
  assert.ok(prompts[1]!.includes(JSON.stringify(store.step(2).claudeEvents)));
  assert.ok(prompts[1]!.includes(JSON.stringify(store.step(1).review)));
  assert.ok(!prompts[1]!.includes(JSON.stringify(store.step(2).review)));
  assert.match(readFileSync(store.step(2).prompt, "utf8"), /Finish result.txt/);
});

test("Claude and Astra are told about the other runs working in the same project", async (t) => {
  const store = fixture(t);
  const claudePrompts: string[] = [];
  const astraPrompts: string[] = [];
  const runners: Runners = {
    async claude({ prompt, eventsPath }) {
      claudePrompts.push(prompt);
      succeed(eventsPath);
    },
    async process({ args, input }) {
      astraPrompts.push(input);
      writeFileSync(args[args.indexOf("--output-last-message") + 1]!, JSON.stringify({ decision: "done", reason: "verified", next_prompt: "", plan: [done] }));
    },
  };
  const other = concurrentRun({ ...store.load(), goal: "Port the parser\nDetails follow", plan: [done, { title: "Port lexer", done_when: "lexer tests pass", status: "pending" }] });
  await runLoop(store, createAgents(runners, quiet, () => [other]), signal(), quiet);
  assert.match(claudePrompts[0]!, /Other lavista runs work in this same project[\s\S]*- Goal: Port the parser\n  Current stage: Port lexer — done when: lexer tests pass\n/);
  assert.ok(astraPrompts[0]!.includes('"concurrent_runs": [\n    {\n      "goal": "Port the parser\\nDetails follow"'));
});

test("with no other runs, prompts carry no concurrency section", async (t) => {
  const store = fixture(t);
  let claudePrompt = "";
  await runLoop(store, createAgents({
    async claude({ prompt, eventsPath }) { claudePrompt = prompt; succeed(eventsPath); },
    async process({ args }) {
      writeFileSync(args[args.indexOf("--output-last-message") + 1]!, JSON.stringify({ decision: "done", reason: "verified", next_prompt: "", plan: [done] }));
    },
  }), signal(), quiet);
  assert.doesNotMatch(claudePrompt, /Other lavista runs/);
});

test("failed worker is persisted and never replayed by ordinary resume", async (t) => {
  const store = fixture(t);
  let calls = 0;
  const fail = async () => { calls++; throw new Error("failed"); };
  const agents = createAgents({ claude: fail, process: fail });
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
    async execute() { workers++; return []; },
    async plan() { throw new Error("unused"); },
    async review() { return { decision: "continue", reason: "more work", next_prompt: "next task", plan: [pending] }; },
  }, signal(), quiet);
  assert.equal(workers, 1);
  assert.equal(store.load().iteration, 2);
  assert.equal(store.load().stage, "claude");
});

test("a usage limit stops the CLI immediately and the loop without reviewing", async (t) => {
  const store = fixture(t);
  const commands: string[] = [];
  const runners: Runners = {
    async claude({ onLine, signal }) {
      commands.push("claude");
      onLine?.(JSON.stringify({ type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "5-hour limit reached" }] } }) + "\n");
      // Like a CLI that keeps waiting: only the limit-triggered abort ends it.
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("aborted");
    },
    async process({ command }) { commands.push(command); },
  };
  await assert.rejects(runLoop(store, createAgents(runners), signal(), quiet),
    (error) => error instanceof UsageLimitError && /5-hour limit reached[\s\S]*lavista retry/.test(error.message));
  assert.deepEqual(commands, ["claude"]);
  assert.equal(store.load().stage, "claude_running");
});

test("an Astra usage limit found only in stderr keeps the review resumable", async (t) => {
  const store = fixture(t);
  const runner: ProcessRunner = async ({ stderrPath }) => {
    writeFileSync(stderrPath, "ERROR: You've hit your usage limit. Try again in 3 days.\n");
    throw new Error("codex exited 1");
  };
  await assert.rejects(runLoop(store, createAgents({ claude: succeedClaude, process: runner }), signal(), quiet),
    (error) => error instanceof UsageLimitError && /Astra[\s\S]*usage limit[\s\S]*lavista resume/.test(error.message));
  assert.equal(store.load().stage, "review");
});

test("models and efforts are passed only when chosen", async (t) => {
  const store = fixture(t);
  store.save({ ...store.load(), claude_model: "claude-opus-5-5", claude_effort: "high", astra_model: "", astra_effort: "xhigh" });
  let claude: ClaudeInvocation | undefined;
  let codex: string[] = [];
  const runners: Runners = {
    async claude(invocation) {
      claude = invocation;
      succeed(invocation.eventsPath);
    },
    async process({ args }) {
      codex = args;
      writeFileSync(args[args.indexOf("--output-last-message") + 1]!, JSON.stringify({ decision: "done", reason: "ok", next_prompt: "", plan: [done] }));
    },
  };
  await runLoop(store, createAgents(runners), signal(), quiet);
  assert.equal(claude?.model, "claude-opus-5-5");
  assert.equal(claude?.effort, "high");
  assert.ok(!codex.includes("--model"));
  assert.equal(codex[codex.indexOf("-c") + 1], 'model_reasoning_effort="xhigh"');

  // Nothing chosen: nothing passed, so each CLI keeps its own settings.
  store.save({ ...store.load(), stage: "claude", claude_model: "", claude_effort: "", astra_model: "", astra_effort: "" });
  await runLoop(store, createAgents(runners), signal(), quiet);
  assert.equal(claude?.model, "");
  assert.equal(claude?.effort, "");
  assert.ok(!codex.includes("--model") && !codex.includes("-c"));
});

test("Astra plans before any work, Claude sees the plan, and each review revises it", async (t) => {
  const store = fixture(t);
  store.save({ ...store.load(), stage: "plan" });
  const calls: string[] = [];
  const claudeInputs: string[] = [];
  const investigate = { title: "Investigate", done_when: "findings recorded", status: "pending" } as const;
  const respond = (args: string[], value: unknown) =>
    writeFileSync(args[args.indexOf("--output-last-message") + 1]!, JSON.stringify(value));
  const claude = async ({ prompt, eventsPath }: ClaudeInvocation) => {
    calls.push("claude");
    claudeInputs.push(prompt);
    succeed(eventsPath);
  };
  const runner: ProcessRunner = async ({ command, args, input }) => {
    calls.push(command);
    if (calls.length === 1) {
      assert.doesNotMatch(input, /history/);
      assert.match(input, /Write next_prompt, and the title and done_when of every stage you add, in English/);
      respond(args, { decision: "continue", reason: "investigate first", next_prompt: "Investigate", plan: [investigate, pending] });
    } else if (calls.length === 3) {
      assert.match(input, /"plan": \[\s*\{\s*"title": "Investigate"/);
      assert.match(input, /in English[\s\S]*Keep the titles of existing\s+stages exactly as they are/);
      respond(args, { decision: "continue", reason: "found it", next_prompt: "Create it", plan: [{ ...investigate, status: "done" }, pending] });
    } else {
      respond(args, { decision: "done", reason: "verified", next_prompt: "", plan: [{ ...investigate, status: "done" }, done] });
    }
  };
  await runLoop(store, createAgents({ claude, process: runner }), signal(), quiet);
  assert.deepEqual(calls, ["codex", "claude", "codex", "claude", "codex"]);
  assert.match(claudeInputs[0]!, /\[ \] 1\. Investigate — done when: findings recorded[\s\S]*Current task:\nInvestigate/);
  assert.match(claudeInputs[1]!, /\[x\] 1\. Investigate[\s\S]*\[ \] 2\. Create result.txt/);
  assert.ok(claudeInputs.every((input) => input.includes("Working rules:\n- Start any command")));
  const state = store.load();
  assert.equal(state.stage, "done");
  assert.ok(state.plan.every((stage) => stage.status === "done"));
  assert.deepEqual((readJson(join(store.directory, "plan", "review.json")) as { plan: unknown }).plan, [investigate, pending]);
});

test("a goal that needs the user's decision is asked about before any stage is planned", async (t) => {
  const store = fixture(t);
  store.save({ ...store.load(), stage: "plan" });
  const events: LoopEvent[] = [];
  const runner: ProcessRunner = async ({ args }) => {
    writeFileSync(args[args.indexOf("--output-last-message") + 1]!, JSON.stringify({
      decision: "needs_input", reason: "Transliterate accents or keep them?", next_prompt: "", plan: [],
    }));
  };
  await runLoop(store, createAgents({ claude: succeedClaude, process: runner }), signal(), (event) => events.push(event));
  const state = store.load();
  assert.equal(state.stage, "needs_input");
  assert.equal(state.stage === "needs_input" && state.reason, "Transliterate accents or keep them?");
  assert.deepEqual(state.plan, []);
  assert.ok(events.some((event) => event.type === "notice" && event.message.includes("Transliterate accents")));
});

test("a review that drops a completed stage is rejected and stays resumable", async (t) => {
  const store = fixture(t);
  store.save({ ...store.load(), stage: "review", plan: [done, { ...pending, title: "Second" }] });
  store.createStep(1);
  writeFileSync(store.step(1).claudeEvents, JSON.stringify({ type: "result", subtype: "success" }));
  writeFileSync(store.step(1).prompt, "p");
  const runner: ProcessRunner = async ({ args }) => {
    writeFileSync(args[args.indexOf("--output-last-message") + 1]!, JSON.stringify({
      decision: "continue", reason: "simplified", next_prompt: "Second", plan: [{ ...pending, title: "Second" }],
    }));
  };
  await assert.rejects(runLoop(store, createAgents({ claude: succeedClaude, process: runner }), signal(), quiet), /dropped completed stages: "Create result.txt"/);
  assert.equal(store.load().stage, "review");
});

test("denied tool calls are reported and the step still goes to review", async (t) => {
  const store = fixture(t);
  const events: LoopEvent[] = [];
  const runners: Runners = {
    async claude({ eventsPath }) {
      succeed(eventsPath, { permission_denials: [{ tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "llvm-dwarfdump a.out" } }] });
    },
    async process({ args }) {
      writeFileSync(args[args.indexOf("--output-last-message") + 1]!, JSON.stringify({ decision: "done", reason: "ok", next_prompt: "", plan: [done] }));
    },
  };
  await runLoop(store, createAgents(runners, (event) => events.push(event)), signal(), (event) => events.push(event));
  assert.equal(store.load().stage, "done");
  assert.ok(events.some((event) => event.type === "notice" && /1 tool call\(s\) were denied[\s\S]*Bash llvm-dwarfdump a\.out/.test(event.message)));
});

test("rules approved for the run are saved at once and allowed in later iterations", async (t) => {
  const store = fixture(t);
  store.save({ ...store.load(), allowed_tools: "Bash(npm test)" });
  const allowed: string[][] = [];
  let reviews = 0;
  const runners: Runners = {
    async claude({ allowedTools, eventsPath, onApprove }) {
      allowed.push(allowedTools);
      if (allowed.length === 1) {
        onApprove?.(["Bash(llvm-dwarfdump *)"]);
        assert.deepEqual(store.load().approved_tools, ["Bash(llvm-dwarfdump *)"]);
      }
      succeed(eventsPath);
    },
    async process({ args }) {
      reviews++;
      writeFileSync(args[args.indexOf("--output-last-message") + 1]!, JSON.stringify(reviews === 1
        ? { decision: "continue", reason: "more", next_prompt: "Next", plan: [pending] }
        : { decision: "done", reason: "ok", next_prompt: "", plan: [done] }));
    },
  };
  await runLoop(store, createAgents(runners), signal(), quiet);
  assert.deepEqual(allowed, [["Bash(npm test)"], ["Bash(npm test)", "Bash(llvm-dwarfdump *)"]]);
  assert.deepEqual(store.load().approved_tools, ["Bash(llvm-dwarfdump *)"]);
});
