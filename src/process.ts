import { execa } from "execa";
import type { Options } from "execa";
import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { LineFollower } from "./follow.js";

/** Abort reason for a user-requested stop (Ctrl+C, SIGTERM or the TUI's stop key). */
export class InterruptedError extends Error {
  constructor() {
    super("Interrupted. Logs and state saved.");
  }
}

export interface Invocation {
  command: string;
  args: string[];
  input: string;
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
  /** Stop the CLI once neither stdout nor stderr has grown for this long; a working CLI is never cut off. */
  timeoutSeconds: number;
  signal: AbortSignal;
  /** Receives each stdout line (newline included) as it is written to `stdoutPath`. */
  onLine?: (line: string) => void;
}

export type ProcessRunner = (invocation: Invocation) => Promise<void>;

/**
 * An open file as a child's stdout/stderr. execa hands a numeric descriptor straight to spawn(),
 * but its option types only list small literal descriptor numbers.
 */
export const writeTo = (file: FileHandle) => file.fd as Extract<Options["stdout"], number>;

/** How often output is checked for growth; sub-second idle limits are checked at their own pace. */
const IDLE_CHECK_MS = 1000;

/**
 * Aborts once neither file has grown for `seconds`. Output goes to files, so growth is read from
 * their sizes: every line, including the heartbeats Claude writes while a long tool runs, counts.
 * Time spent while `waiting()` (e.g. for the user to answer a question) never counts as idle.
 */
export function idleWatchdog(paths: string[], seconds: number, waiting: () => boolean = () => false): { signal: AbortSignal; stop(): void } {
  const idle = new AbortController();
  const limit = seconds * 1000;
  let sizes = "";
  let changed = Date.now();
  const timer = setInterval(() => {
    const now = paths.map((path) => (existsSync(path) ? statSync(path).size : 0)).join(",");
    if (now !== sizes || waiting()) {
      sizes = now;
      changed = Date.now();
    } else if (Date.now() - changed >= limit) {
      idle.abort();
    }
  }, Math.min(IDLE_CHECK_MS, limit));
  return { signal: idle.signal, stop: () => clearInterval(timer) };
}

type Killable = { kill(signal: NodeJS.Signals): boolean };

const running = new Set<Killable>();

/** Second stop request: skip the graceful period and SIGKILL every running CLI's process group. */
export function forceKillAll(): void {
  for (const subprocess of running) subprocess.kill("SIGKILL");
}

/** Include a CLI in `forceKillAll` until it settles. */
export function track<T extends Killable & PromiseLike<unknown>>(subprocess: T): T {
  running.add(subprocess);
  subprocess.then(() => running.delete(subprocess), () => running.delete(subprocess));
  return subprocess;
}

/** The error for a CLI stopped by `idleWatchdog`. */
export function idleError(command: string, timeoutSeconds: number): Error {
  const next = command === "claude" ? "lavista retry" : "lavista resume";
  return new Error(`${command} stopped: no output for ${timeoutSeconds}s. Work files and logs are kept; `
    + `if it was still working, raise timeout in .lavista/config.local.json, then run \`${next}\`.`);
}

export const runProcess: ProcessRunner = async (invocation) => {
  const { command, args, input, cwd, stdoutPath, stderrPath, timeoutSeconds, signal, onLine } = invocation;
  signal.throwIfAborted();
  // Output goes straight to files rather than through pipes: a descendant that outlives the CLI
  // (e.g. a daemonized dev server) would otherwise hold the pipe open and block completion forever.
  const stdout = await open(stdoutPath, "w");
  const stderr = await open(stderrPath, "w");
  const follower = onLine ? await LineFollower.open(stdoutPath, onLine) : undefined;
  const idle = idleWatchdog([stdoutPath, stderrPath], timeoutSeconds);
  try {
    const subprocess = execa(command, args, {
      cwd,
      input,
      stdout: writeTo(stdout),
      stderr: writeTo(stderr),
      cancelSignal: AbortSignal.any([signal, idle.signal]),
      // Signal the whole process group so cancellation reaches CLI subprocesses as well.
      killDescendants: true,
      forceKillAfterDelay: 5000,
      reject: false,
    });
    const result = await track(subprocess);
    if (!result.failed) return;
    if (result.isCanceled && !signal.aborted && idle.signal.aborted) throw idleError(command, timeoutSeconds);
    if (result.isCanceled) throw new InterruptedError();
    throw new Error(`${result.shortMessage}\nSee ${stderrPath}`);
  } finally {
    idle.stop();
    await follower?.close();
    await stdout.close();
    await stderr.close();
  }
};
