#!/usr/bin/env node
import { Command, CommanderError, Option } from "@commander-js/extra-typings";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { concurrentRun, createAgents, UsageLimitError, verifyClaudeResult } from "./agents.js";
import { sdkClaude } from "./claude.js";
import { editText } from "./editor.js";
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

const GOAL_HELP = `Write the goal above, and the conditions under which it is complete.
Save and quit to start; leave it empty to cancel.`;

/**
 * Text from `file` when given, written in the editor on a terminal (starting from `file`'s text).
 * Off a terminal there is nobody to write it, so `file` is required.
 */
async function writeText(file: string | undefined, help: string, what: string): Promise<string> {
  const initial = file === undefined ? "" : nonemptyFile(file);
  if (!isInteractive()) {
    if (file === undefined) throw new Error(`Give the ${what} as a file; there is no terminal to open an editor on.`);
    return initial;
  }
  const text = await editText(initial, help);
  if (!text) throw new Error(`Cancelled: the ${what} is empty.`);
  return text;
}

function expectStage<S extends RunState["stage"]>(state: RunState, stage: S, command: string): asserts state is RunState & { stage: S } {
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
    const { emit, ask, close } = reporter(store);
    try {
      const concurrent = () => workspace.activeRuns(store).flatMap((other) => {
        try {
          return [concurrentRun(other.load())];
        } catch {
          return []; // Its state is being written or was never saved.
        }
      });
      await runLoop(store, createAgents({ process: runProcess, claude: sdkClaude(ask) }, emit, concurrent), cancel, emit);
    } finally {
      await close();
    }
  };

  /** Reload limits from config (models stay as chosen at start), apply a stage transition, then continue. */
  const resumeWith = (transition: (state: RunState, store: RunStore) => RunState | Promise<RunState>) => async (id?: string) => {
    const store = workspace.findRun(id, { idle: true });
    await store.exclusive(async () => {
      const state: RunState = { ...store.load(), ...workspace.loadLimits() };
      store.save(await transition(state, store));
      await run(store);
    });
  };

  const program = new Command("lavista")
    .description("Astra plans. Claude executes. Astra reviews and revises the plan. A fresh session takes the next step.\n"
      + "Runs in the current directory. Settings: .lavista/config.json, .lavista/config.local.json")
    .exitOverride()
    .hook("preAction", () => {
      if (process.platform === "win32") throw new Error("lavista currently supports macOS and Linux.");
    });

  program.command("start")
    .description("Start a new run: write the goal and completion criteria in your editor ($VISUAL, $EDITOR or vi)")
    .argument("[file]", "UTF-8 text to start the editor from; used as is when not on a terminal")
    .option("--claude-model <model>", "Claude model for the worker, e.g. claude-opus-5-5")
    .addOption(new Option("--claude-effort <level>", "Claude effort level").choices(CLAUDE_EFFORTS))
    .option("--astra-model <model>", "Codex model for Astra's reviews, e.g. gpt-6-astra")
    .option("--astra-effort <level>", "Codex reasoning effort, e.g. high")
    .addHelpText("after", "\nThe goal is saved with the run as .lavista/runs/<run>/goal.md.\n"
      + "Models and efforts not given here or in .lavista/config*.json are picked from a list\n"
      + "(CLI defaults when not on a terminal). They are passed per run as flags; neither CLI's settings are changed.")
    .action(async (file, options) => {
      const config = workspace.loadConfig();
      const models = await chooseModels({
        claude_model: options.claudeModel ?? config.claude_model,
        claude_effort: options.claudeEffort ?? config.claude_effort,
        astra_model: options.astraModel ?? config.astra_model,
        astra_effort: options.astraEffort ?? config.astra_effort,
      }, isInteractive() ? interactivePicker() : undefined);
      const goal = await writeText(file, GOAL_HELP, "goal");
      const store = workspace.newRun();
      store.create({
        ...models, ...workspace.loadLimits(),
        goal, project: workspace.project, stage: "plan", iteration: 1, next_prompt: goal, plan: [], approved_tools: [],
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
    .description("Answer a needs_input decision in your editor and let Astra decide again")
    .argument("[run]")
    .option("--file <file>", "UTF-8 text to start the editor from; used as is when not on a terminal")
    .action((id, options) => resumeWith(async (state, store) => {
      expectStage(state, "needs_input", "answer");
      const help = `Write your answer to Astra above. Leave it empty to cancel.\n\nAstra asks:\n${state.reason}`;
      const answer = await writeText(options.file, help, "answer");
      // A question asked while planning, before any iteration ran, is answered by planning again.
      const stage = existsSync(store.step(state.iteration).directory) ? "review" : "plan";
      const goal = `${state.goal}\n\nUser clarification:\n${answer}`;
      store.saveGoal(goal);
      return { ...state, stage, goal };
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
