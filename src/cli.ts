#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError, Option } from "@commander-js/extra-typings";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createAgents, verifyClaudeResult } from "./agents.js";
import { runLoop } from "./loop.js";
import { count, timeoutSeconds } from "./model.js";
import type { RunState } from "./model.js";
import { runProcess } from "./process.js";
import { RunStore } from "./store.js";

function numberArgument(schema: z.ZodType<number>) {
  return (value: string): number => {
    const result = schema.safeParse(Number(value));
    if (!result.success) throw new InvalidArgumentError(z.prettifyError(result.error));
    return result.data;
  };
}

const option = {
  maxIterations: () => new Option("--max-iterations <count>").argParser(numberArgument(count)),
  maxHistoryBytes: () => new Option("--max-history-bytes <bytes>", "never silently truncate history")
    .argParser(numberArgument(count)),
  allowedTools: () => new Option("--allowed-tools <tools>", "Claude tool permission rules"),
};

function nonemptyFile(path: string): string {
  const content = readFileSync(path, "utf8").trim();
  if (!content) throw new Error(`File must not be empty: ${path}`);
  return content;
}

async function run(store: RunStore, signal: AbortSignal): Promise<void> {
  await runLoop(store, createAgents(runProcess), signal);
}

interface ResumeOptions {
  maxIterations?: number;
  maxHistoryBytes?: number;
  allowedTools?: string;
  retryWorker?: true;
  reviewWorker?: true;
  inputFile?: string;
}

function resumedState(store: RunStore, options: ResumeOptions): RunState {
  const loaded = store.load();
  const state: RunState = {
    ...loaded,
    max_iterations: options.maxIterations ?? loaded.max_iterations,
    max_history_bytes: options.maxHistoryBytes ?? loaded.max_history_bytes,
    allowed_tools: options.allowedTools ?? loaded.allowed_tools,
  };
  if (options.retryWorker || options.reviewWorker) {
    if (state.stage !== "claude_running") throw new Error("Worker recovery requires claude_running state");
    if (options.reviewWorker) {
      verifyClaudeResult(store.step(state.iteration).claudeEvents);
      return { ...state, stage: "review" };
    }
    store.archiveStep(state.iteration);
    return { ...state, stage: "claude" };
  }
  if (options.inputFile !== undefined) {
    if (state.stage !== "needs_input") throw new Error("--input-file requires needs_input state");
    const answer = nonemptyFile(options.inputFile);
    return { ...state, stage: "review", goal: `${state.goal}\n\nUser clarification:\n${answer}` };
  }
  return state;
}

function createProgram(signal: AbortSignal) {
  const program = new Command("lavista")
    .description("Claude executes. Astra reviews. A fresh session takes the next step.")
    .exitOverride()
    .hook("preAction", () => {
      if (process.platform === "win32") throw new Error("lavista currently supports macOS and Linux.");
    });

  program.command("start")
    .description("Start a new run")
    .requiredOption("--project <directory>")
    .requiredOption("--prompt-file <file>", "UTF-8 file with the initial instructions")
    .requiredOption("--run-dir <new-directory>")
    .option("--astra-model <model>", "Codex model used by Astra", "gpt-6-astra")
    .option("--claude-model <model>", "default: Claude CLI's configured model")
    .option("--timeout <seconds>", "per CLI invocation", numberArgument(timeoutSeconds), 1800)
    .addOption(option.maxIterations().default(5))
    .addOption(option.maxHistoryBytes().default(1_000_000))
    .addOption(option.allowedTools())
    .action(async (options) => {
      const project = resolve(options.project);
      if (!statSync(project).isDirectory()) throw new Error("Project must be a directory");
      const goal = nonemptyFile(options.promptFile);
      const store = new RunStore(options.runDir);
      store.create({
        goal, project, stage: "claude", iteration: 1, next_prompt: goal,
        astra_model: options.astraModel,
        claude_model: options.claudeModel ?? "",
        allowed_tools: options.allowedTools ?? "",
        max_iterations: options.maxIterations,
        max_history_bytes: options.maxHistoryBytes,
        timeout: options.timeout,
      });
      await store.exclusive(() => run(store, signal));
    });

  program.command("resume")
    .description("Resume a stopped run")
    .argument("<run-directory>")
    .addOption(option.maxIterations())
    .addOption(option.maxHistoryBytes())
    .addOption(option.allowedTools())
    .addOption(new Option("--retry-worker", "explicitly retry an interrupted worker in a fresh session")
      .conflicts(["reviewWorker", "inputFile"]))
    .addOption(new Option("--review-worker", "review a saved successful worker result")
      .conflicts("inputFile"))
    .option("--input-file <file>", "answer a needs_input decision")
    .action(async (directory, options) => {
      const store = new RunStore(directory);
      await store.exclusive(async () => {
        store.save(resumedState(store, options));
        await run(store, signal);
      });
    });

  program.command("status")
    .description("Print the saved run state")
    .argument("<run-directory>")
    .action((directory) => {
      console.log(JSON.stringify(new RunStore(directory).load(), null, 2));
    });

  return program;
}

export async function main(args: string[], signal: AbortSignal): Promise<void> {
  await createProgram(signal).parseAsync(args, { from: "user" });
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
    if (error instanceof CommanderError) {
      // Commander already printed help or the usage error.
      process.exitCode = error.exitCode;
    } else {
      console.error(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = controller.signal.aborted ? 130 : 1;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
