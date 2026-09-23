#!/usr/bin/env node
import { Command, CommanderError, Option } from "@commander-js/extra-typings";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAgents, UsageLimitError, verifyClaudeResult } from "./agents.js";
import { consoleReporter } from "./events.js";
import type { Reporter } from "./events.js";
import { runLoop } from "./loop.js";
import { CLAUDE_EFFORTS } from "./model.js";
import type { RunState } from "./model.js";
import { chooseModels, interactivePicker } from "./models.js";
import { forceKillAll, InterruptedError, runProcess } from "./process.js";
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

const isInteractive = () => Boolean(process.stdout.isTTY && process.stdin.isTTY);

function createProgram(signal: AbortSignal, workspace: Workspace) {
  // The TUI reads keys in raw mode, where Ctrl+C is a key press rather than SIGINT.
  const stop = new AbortController();
  const cancel = AbortSignal.any([signal, stop.signal]);
  const reporter = (store: RunStore): Reporter => isInteractive()
    ? tuiReporter(store, () => stop.abort(new InterruptedError()), forceKillAll)
    : consoleReporter();

  const run = async (store: RunStore) => {
    const { emit, close } = reporter(store);
    try {
      await runLoop(store, createAgents(runProcess, emit), cancel, emit);
    } finally {
      await close();
    }
  };

  /** Reload limits from config (models stay as chosen at start), apply a stage transition, then continue. */
  const resumeWith = (transition: (state: RunState, store: RunStore) => RunState) => async (id?: string) => {
    const store = workspace.findRun(id);
    await store.exclusive(async () => {
      const state: RunState = { ...store.load(), ...workspace.loadLimits() };
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
    .option("--claude-model <model>", "Claude model for the worker, e.g. claude-opus-5-5")
    .addOption(new Option("--claude-effort <level>", "Claude effort level").choices(CLAUDE_EFFORTS))
    .option("--astra-model <model>", "Codex model for Astra's reviews, e.g. gpt-6-astra")
    .option("--astra-effort <level>", "Codex reasoning effort, e.g. high")
    .addHelpText("after", "\nModels and efforts not given here or in .lavista/config*.json are picked from a list\n"
      + "(CLI defaults when not on a terminal). They are passed per run as flags; neither CLI's settings are changed.")
    .action(async (promptFile, options) => {
      const goal = nonemptyFile(promptFile);
      const config = workspace.loadConfig();
      const models = await chooseModels({
        claude_model: options.claudeModel ?? config.claude_model,
        claude_effort: options.claudeEffort ?? config.claude_effort,
        astra_model: options.astraModel ?? config.astra_model,
        astra_effort: options.astraEffort ?? config.astra_effort,
      }, isInteractive() ? interactivePicker() : undefined);
      const store = workspace.newRun();
      store.create({
        ...models, ...workspace.loadLimits(),
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
  // First Ctrl+C / SIGTERM stops gracefully; another one kills the agents immediately.
  const interrupt = () => (controller.signal.aborted ? forceKillAll() : controller.abort(new InterruptedError()));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await main(process.argv.slice(2), controller.signal);
  } catch (caught) {
    // Ctrl+C in a model picker ends the prompt with ExitPromptError.
    const error = caught instanceof Error && caught.name === "ExitPromptError" ? new InterruptedError() : caught;
    if (error instanceof CommanderError) {
      // Commander already printed help or the usage error.
      process.exitCode = error.exitCode;
    } else {
      console.error(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
      // 75 (EX_TEMPFAIL): a usage limit; the same command can succeed once it resets.
      process.exitCode = error instanceof InterruptedError ? 130 : error instanceof UsageLimitError ? 75 : 1;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
