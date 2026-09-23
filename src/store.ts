import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { parseState } from "./model.js";
import type { RunState } from "./model.js";

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveJson(path: string, value: unknown): void {
  writeFileAtomic.sync(path, JSON.stringify(value, null, 2) + "\n");
}

/** Files saved for one iteration (`001/`, `002/`, ...). */
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

  get reviewSchema(): string {
    return join(this.directory, "review-schema.json");
  }

  private get statePath(): string {
    return join(this.directory, "state.json");
  }

  step(iteration: number): StepFiles {
    return new StepFiles(join(this.directory, String(iteration).padStart(3, "0")));
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
  }

  load(): RunState {
    return parseState(readJson(this.statePath));
  }

  save(state: RunState): void {
    saveJson(this.statePath, state);
  }

  // A plain directory lock without staleness detection: runs last up to 30 minutes per step and
  // mtime-based stale locks would be stolen after a laptop sleep. Stale locks are removed by hand.
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const lock = join(this.directory, ".lavista-lock");
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
