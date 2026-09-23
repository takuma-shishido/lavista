import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseState } from "./model.js";
import type { RunState } from "./model.js";

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveJson(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}

export class RunStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  step(iteration: number): string {
    return join(this.directory, String(iteration).padStart(3, "0"));
  }

  load(): RunState {
    return parseState(readJson(join(this.directory, "state.json")));
  }

  save(state: RunState): void {
    saveJson(join(this.directory, "state.json"), state);
  }

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
