#!/usr/bin/env node
import { Command, CommanderError } from "@commander-js/extra-typings";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAgents, verifyClaudeResult } from "./agents.js";
import { consoleReporter } from "./events.js";
import type { Reporter } from "./events.js";
import { runLoop } from "./loop.js";
import type { RunState } from "./model.js";
import { InterruptedError, runProcess } from "./process.js";
import type { RunStore } from "./store.js";
import { tuiReporter } from "./tui/index.js";
import { Workspace } from "./workspace.js";

function nonemptyFile(path: string): string {
  const content = readFileSync(path, "utf8").trim();
  if (!content) throw new Error(`File must not be empty: ${path}`);
  return content;
}

function expectStage(state: RunState, stage: RunState["stage"], command: string): void {
  if (state.stage !== stage) throw new Error(`lavista ${command} requires the ${stage} stage, but the run is in ${state.stage}`);
}

function createProgram(signal: AbortSignal, workspace: Workspace) {
  // The TUI reads keys in raw mode, where Ctrl+C is a key press rather than SIGINT.
  const stop = new AbortController();
  const cancel = AbortSignal.any([signal, stop.signal]);
  const reporter = (store: RunStore): Reporter => process.stdout.isTTY && process.stdin.isTTY
    ? tuiReporter(store.id, store.directory, () => stop.abort(new InterruptedError()))
    : consoleReporter();

  const run = async (store: RunStore) => {
    const { emit, close } = reporter(store);
    try {
      await runLoop(store, createAgents(runProcess, emit), cancel, emit);
    } finally {
      await close();
    }
  };

  /** Reload settings from config, apply a stage transition, then continue the loop. */
  const resumeWith = (transition: (state: RunState, store: RunStore) => RunState) => async (id?: string) => {
    const store = workspace.findRun(id);
    await store.exclusive(async () => {
      const state: RunState = { ...store.load(), ...workspace.loadSettings() };
      store.save(transition(state, store));
      await run(store);
    });
  };

  const program = new Command("lavista")
    .description("Claude executes. Astra reviews. A fresh session takes the next step.\n"
      + "Runs in the current directory. Settings: .lavista/config.json, .lavista/config.local.json")
    .exitOverride()
    .hook("preAction", () => {
      if (process.platform === "win32") throw new Error("lavista currently supports macOS and Linux.");
    });

  program.command("start")
    .description("Start a new run from a UTF-8 file with the goal and completion criteria")
    .argument("<prompt-file>")
    .action(async (promptFile) => {
      const goal = nonemptyFile(promptFile);
      const store = workspace.newRun();
      store.create({
        ...workspace.loadSettings(),
        goal, project: workspace.project, stage: "claude", iteration: 1, next_prompt: goal,
      });
      await store.exclusive(() => run(store));
    });

  program.command("resume")
    .description("Continue a stopped run (default: latest) with the current config")
    .argument("[run]")
    .action(resumeWith((state) => state));

  program.command("retry")
    .description("Retry an interrupted or failed Claude step in a fresh session")
    .argument("[run]")
    .action(resumeWith((state, store) => {
      expectStage(state, "claude_running", "retry");
      store.archiveStep(state.iteration);
      return { ...state, stage: "claude" };
    }));

  program.command("review")
    .description("Send a saved successful Claude result to Astra")
    .argument("[run]")
    .action(resumeWith((state, store) => {
      expectStage(state, "claude_running", "review");
      verifyClaudeResult(store.step(state.iteration).claudeEvents);
      return { ...state, stage: "review" };
    }));

  program.command("answer")
    .description("Answer a needs_input decision and let Astra decide again")
    .argument("<file>")
    .argument("[run]")
    .action((file, id) => resumeWith((state) => {
      expectStage(state, "needs_input", "answer");
      return { ...state, stage: "review", goal: `${state.goal}\n\nUser clarification:\n${nonemptyFile(file)}` };
    })(id));

  program.command("status")
    .description("Print the saved run state (default: latest run)")
    .argument("[run]")
    .action((id) => {
      console.log(JSON.stringify(workspace.findRun(id).load(), null, 2));
    });

  return program;
}

export async function main(args: string[], signal: AbortSignal, workspace = new Workspace(process.cwd())): Promise<void> {
  await createProgram(signal, workspace).parseAsync(args, { from: "user" });
}

// Keep importable main free of signal handlers for tests and embedding.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new InterruptedError());
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
      process.exitCode = error instanceof InterruptedError ? 130 : 1;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
