#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createAgents, verifyClaudeResult } from "./agents.js";
import { runLoop } from "./loop.js";
import { positiveInteger } from "./model.js";
import type { RunState } from "./model.js";
import { runProcess } from "./process.js";
import { RunStore } from "./store.js";

const help = `lavista — Claude executes. Astra reviews. A fresh session takes the next step.

Usage:
  lavista start --project <directory> --prompt-file <file> --run-dir <new-directory>
  lavista resume <run-directory> [options]
  lavista status <run-directory>

Start options:
  --astra-model <model>       Default: gpt-6-astra
  --claude-model <model>      Default: Claude CLI's configured model
  --timeout <seconds>         Per CLI invocation; default: 1800

Start / resume options:
  --max-iterations <count>    Default: 5
  --max-history-bytes <bytes> Default: 1000000; never silently truncate history
  --allowed-tools <tools>    Claude tool permission rules

Resume options:
  --retry-worker             Explicitly retry an interrupted worker in a fresh session
  --review-worker            Review a saved successful worker result
  --input-file <file>        Answer a needs_input decision
`;

const stringOption = { type: "string" } as const;
const booleanOption = { type: "boolean" } as const;

function nonemptyFile(path: string): string {
  const content = readFileSync(path, "utf8").trim();
  if (!content) throw new Error(`File must not be empty: ${path}`);
  return content;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export async function main(args: string[], signal: AbortSignal): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    console.log(help);
    return;
  }
  if (!["start", "resume", "status"].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (process.platform === "win32") throw new Error("lavista currently supports macOS and Linux.");
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    help: { ...booleanOption, short: "h" },
    "max-iterations": stringOption, "max-history-bytes": stringOption, "allowed-tools": stringOption,
    project: stringOption, "prompt-file": stringOption, "run-dir": stringOption,
    "astra-model": stringOption, "claude-model": stringOption, timeout: stringOption,
    "retry-worker": booleanOption, "review-worker": booleanOption, "input-file": stringOption,
  } });
  if (values.help) { console.log(help); return; }
  const common = ["max-iterations", "max-history-bytes", "allowed-tools"];
  const permitted = command === "start"
    ? [...common, "project", "prompt-file", "run-dir", "astra-model", "claude-model", "timeout"]
    : command === "resume" ? [...common, "retry-worker", "review-worker", "input-file"] : [];
  for (const option of Object.keys(values)) {
    if (!permitted.includes(option)) throw new Error(`--${option} is not valid for ${command}`);
  }
  if (positionals.length !== (command === "start" ? 0 : 1)) throw new Error("Unexpected or missing positional arguments; use --help");
  const store = new RunStore(command === "start"
    ? required(values["run-dir"], "--run-dir")
    : required(positionals[0], "run directory"));

  if (command === "status") {
    console.log(JSON.stringify(store.load(), null, 2));
    return;
  }
  if (command === "start") {
    const project = resolve(required(values.project, "--project"));
    if (!statSync(project).isDirectory()) throw new Error("Project must be a directory");
    const goal = nonemptyFile(required(values["prompt-file"], "--prompt-file"));
    const state: RunState = {
      goal, project, stage: "claude", iteration: 1, next_prompt: goal,
      astra_model: values["astra-model"] ?? "gpt-6-astra",
      claude_model: values["claude-model"] ?? "",
      allowed_tools: values["allowed-tools"] ?? "",
      max_iterations: positiveInteger(Number(values["max-iterations"] ?? 5), "--max-iterations"),
      max_history_bytes: positiveInteger(Number(values["max-history-bytes"] ?? 1000000), "--max-history-bytes"),
      timeout: positiveInteger(Number(values.timeout ?? 1800), "--timeout"),
    };
    // Node timers cannot represent delays above a signed 32-bit millisecond value.
    if (state.timeout > 2147483) throw new Error("--timeout must be at most 2147483 seconds");
    mkdirSync(dirname(store.directory), { recursive: true });
    mkdirSync(store.directory);
    store.save(state);
  }

  await store.exclusive(async () => {
    if (command === "resume") {
      let state = store.load();
      if (values["max-iterations"] !== undefined) {
        state.max_iterations = positiveInteger(Number(values["max-iterations"]), "--max-iterations");
      }
      if (values["max-history-bytes"] !== undefined) {
        state.max_history_bytes = positiveInteger(Number(values["max-history-bytes"]), "--max-history-bytes");
      }
      if (values["allowed-tools"] !== undefined) state.allowed_tools = values["allowed-tools"];
      const retry = values["retry-worker"];
      const review = values["review-worker"];
      const input = values["input-file"];
      if ([retry, review, input].filter(Boolean).length > 1) {
        throw new Error("Choose only one of --retry-worker, --review-worker, --input-file");
      }
      if (retry || review) {
        if (state.stage !== "claude_running") throw new Error("Worker recovery requires claude_running state");
        const step = store.step(state.iteration);
        if (review) {
          verifyClaudeResult(join(step, "claude.jsonl"));
          state = { ...state, stage: "review" };
        } else {
          renameSync(step, `${step}-attempt-${randomUUID()}`);
          state = { ...state, stage: "claude" };
        }
      }
      if (input) {
        if (state.stage !== "needs_input") throw new Error("--input-file requires needs_input state");
        state = { ...state, stage: "review", goal: `${state.goal}\n\nUser clarification:\n${nonemptyFile(input)}` };
      }
      store.save(state);
    }
    await runLoop(store, createAgents(runProcess), signal);
  });
}

// Keep importable main free of signal handlers for tests and embedding.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Interrupted. Logs and state saved."));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await main(process.argv.slice(2), controller.signal);
  } catch (error) {
    console.error(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
