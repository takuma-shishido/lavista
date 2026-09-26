import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { parseState } from "./model.js";
import type { RunState } from "./model.js";

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveJson(path: string, value: unknown): void {
  writeFileAtomic.sync(path, JSON.stringify(value, null, 2) + "\n");
}

/** Files saved for one iteration (`001/`, `002/`, ...), or for the initial planning (`plan/`, Astra's files only). */
export class StepFiles {
  constructor(readonly directory: string) {}

  private file(name: string): string {
    return join(this.directory, name);
  }

  get prompt() { return this.file("prompt.txt"); }
  get claudeEvents() { return this.file("claude.jsonl"); }
  get claudeStderr() { return this.file("claude.stderr"); }
  get reviewPrompt() { return this.file("review-prompt.txt"); }
  get astraEvents() { return this.file("astra.jsonl"); }
  get astraStderr() { return this.file("astra.stderr"); }
  get reviewResponse() { return this.file("review-response.json"); }
  get review() { return this.file("review.json"); }
}

export class RunStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  get id(): string {
    return basename(this.directory);
  }

  get reviewSchema(): string {
    return join(this.directory, "review-schema.json");
  }

  /** The goal as the agents see it, with any answers the user gave, for the user to read. */
  get goalPath(): string {
    return join(this.directory, "goal.md");
  }

  private get statePath(): string {
    return join(this.directory, "state.json");
  }

  step(iteration: number): StepFiles {
    return new StepFiles(join(this.directory, String(iteration).padStart(3, "0")));
  }

  /** Astra's initial planning, before the first iteration. */
  createPlanStep(): StepFiles {
    const step = new StepFiles(join(this.directory, "plan"));
    mkdirSync(step.directory, { recursive: true });
    return step;
  }

  createStep(iteration: number): StepFiles {
    const step = this.step(iteration);
    mkdirSync(step.directory, { recursive: true });
    return step;
  }

  /** Move a failed attempt aside so a retry starts from an empty step directory. */
  archiveStep(iteration: number): void {
    const { directory } = this.step(iteration);
    renameSync(directory, `${directory}-attempt-${randomUUID()}`);
  }

  /** Create a new run directory; fails if it already exists. */
  create(state: RunState): void {
    mkdirSync(dirname(this.directory), { recursive: true });
    mkdirSync(this.directory);
    this.save(state);
    this.saveGoal(state.goal);
  }

  saveGoal(goal: string): void {
    writeFileSync(this.goalPath, `${goal}\n`);
  }

  load(): RunState {
    return parseState(readJson(this.statePath));
  }

  save(state: RunState): void {
    saveJson(this.statePath, state);
  }

  private get lockDirectory(): string {
    return join(this.directory, ".lavista-lock");
  }

  /** A lavista process holds this run's lock and is still alive. */
  get active(): boolean {
    try {
      const { pid } = readJson(join(this.lockDirectory, "owner.json")) as { pid: number };
      if (pid === process.pid) return true;
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: the process exists but belongs to someone else.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  // A plain directory lock without staleness detection: runs last up to 30 minutes per step and
  // mtime-based stale locks would be stolen after a laptop sleep. Stale locks are removed by hand.
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const lock = this.lockDirectory;
    try {
      mkdirSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error(`Run is locked: ${lock}. If a process was force-killed, verify it has stopped before removing this directory.`);
    }
    try {
      saveJson(join(lock, "owner.json"), { pid: process.pid });
      return await action();
    } finally {
      rmSync(lock, { recursive: true });
    }
  }
}
