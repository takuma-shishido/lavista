import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { limitSettings, parse, runSettings } from "./model.js";
import type { LimitSettings, RunSettings } from "./model.js";
import { readJson, RunStore } from "./store.js";

export const DEFAULT_SETTINGS: RunSettings = {
  astra_model: "gpt-6-astra",
  claude_model: "",
  allowed_tools: "",
  max_iterations: 5,
  timeout: 1800,
  max_history_bytes: 1_000_000,
};

// Every key is optional; unknown keys are rejected so typos do not silently fall back to defaults.
const configFile = z.strictObject(runSettings.shape).partial();

export type Config = z.infer<typeof configFile>;

/**
 * The project's `.lavista/` directory:
 * - `config.json` shared settings, `config.local.json` personal overrides (git-ignored)
 * - `runs/<id>/` one directory per run (git-ignored)
 */
export class Workspace {
  readonly project: string;
  readonly directory: string;

  constructor(project: string) {
    this.project = resolve(project);
    this.directory = join(this.project, ".lavista");
  }

  get configFiles(): string[] {
    return [join(this.directory, "config.json"), join(this.directory, "config.local.json")];
  }

  private get runsDirectory(): string {
    return join(this.directory, "runs");
  }

  /** Only what the config files set: `config.local.json` overrides `config.json`. */
  loadConfig(): Config {
    const layers = this.configFiles
      .filter((path) => existsSync(path))
      .map((path) => parse(configFile, readJson(path), path));
    return Object.assign({}, ...layers);
  }

  /** Limits and permissions from config over defaults; models are chosen per run instead. */
  loadLimits(): LimitSettings {
    return limitSettings.parse({ ...DEFAULT_SETTINGS, ...this.loadConfig() });
  }

  /** Allocate a new run directory named by its start time. */
  newRun(now = new Date()): RunStore {
    mkdirSync(this.runsDirectory, { recursive: true });
    const gitignore = join(this.directory, ".gitignore");
    if (!existsSync(gitignore)) writeFileSync(gitignore, "runs/\nconfig.local.json\n");
    const id = now.toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-");
    return new RunStore(join(this.runsDirectory, id));
  }

  /** The run with the given ID, or the most recently started one. */
  findRun(id?: string): RunStore {
    if (id !== undefined) return new RunStore(join(this.runsDirectory, id));
    const latest = existsSync(this.runsDirectory)
      ? readdirSync(this.runsDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .at(-1)
      : undefined;
    if (latest === undefined) throw new Error(`No runs in ${this.runsDirectory}. Start one with: lavista start <prompt-file>`);
    return new RunStore(join(this.runsDirectory, latest));
  }
}
