import { execa } from "execa";

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

export const runProcess: ProcessRunner = async (invocation) => {
  const { command, args, input, cwd, stdoutPath, stderrPath, timeoutSeconds, signal, onLine } = invocation;
  signal.throwIfAborted();
  const tee = function* (line: string) {
    onLine?.(line);
    yield line;
  };
  const result = await execa(command, args, {
    cwd,
    input,
    stdout: [{ file: stdoutPath }, { transform: tee, preserveNewlines: true }],
    stderr: { file: stderrPath },
    timeout: timeoutSeconds * 1000,
    cancelSignal: signal,
    // Signal the whole process group so cancellation reaches CLI subprocesses as well.
    killDescendants: true,
    forceKillAfterDelay: 5000,
    reject: false,
  });
  if (!result.failed) return;
  if (result.isCanceled) throw new InterruptedError();
  if (result.timedOut) throw new Error(`${command} timed out`);
  throw new Error(`${result.shortMessage}\nSee ${stderrPath}`);
};
