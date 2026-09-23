import { execa } from "execa";
import type { Options } from "execa";
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
const writeTo = (file: FileHandle) => file.fd as Extract<Options["stdout"], number>;

const running = new Set<{ kill(signal: NodeJS.Signals): boolean }>();

/** Second stop request: skip the graceful period and SIGKILL every running CLI's process group. */
export function forceKillAll(): void {
  for (const subprocess of running) subprocess.kill("SIGKILL");
}

export const runProcess: ProcessRunner = async (invocation) => {
  const { command, args, input, cwd, stdoutPath, stderrPath, timeoutSeconds, signal, onLine } = invocation;
  signal.throwIfAborted();
  // Output goes straight to files rather than through pipes: a descendant that outlives the CLI
  // (e.g. a daemonized dev server) would otherwise hold the pipe open and block completion forever.
  const stdout = await open(stdoutPath, "w");
  const stderr = await open(stderrPath, "w");
  const follower = onLine ? await LineFollower.open(stdoutPath, onLine) : undefined;
  try {
    const subprocess = execa(command, args, {
      cwd,
      input,
      stdout: writeTo(stdout),
      stderr: writeTo(stderr),
      timeout: timeoutSeconds * 1000,
      cancelSignal: signal,
      // Signal the whole process group so cancellation reaches CLI subprocesses as well.
      killDescendants: true,
      forceKillAfterDelay: 5000,
      reject: false,
    });
    running.add(subprocess);
    const result = await subprocess.finally(() => running.delete(subprocess));
    if (!result.failed) return;
    if (result.isCanceled) throw new InterruptedError();
    if (result.timedOut) throw new Error(`${command} timed out`);
    throw new Error(`${result.shortMessage}\nSee ${stderrPath}`);
  } finally {
    await follower?.close();
    await stdout.close();
    await stderr.close();
  }
};
