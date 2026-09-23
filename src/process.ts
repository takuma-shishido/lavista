import { execa } from "execa";

export interface Invocation {
  command: string;
  args: string[];
  input: string;
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
  timeoutSeconds: number;
  signal: AbortSignal;
}

export type ProcessRunner = (invocation: Invocation) => Promise<void>;

export const runProcess: ProcessRunner = async (invocation) => {
  const { command, args, input, cwd, stdoutPath, stderrPath, timeoutSeconds, signal } = invocation;
  signal.throwIfAborted();
  const result = await execa(command, args, {
    cwd,
    input,
    stdout: { file: stdoutPath },
    stderr: { file: stderrPath },
    timeout: timeoutSeconds * 1000,
    cancelSignal: signal,
    // Signal the whole process group so cancellation reaches CLI subprocesses as well.
    killDescendants: true,
    forceKillAfterDelay: 5000,
    reject: false,
  });
  if (!result.failed) return;
  if (result.isCanceled) throw new Error("Interrupted. Logs and state saved.");
  if (result.timedOut) throw new Error(`${command} timed out`);
  throw new Error(`${result.shortMessage}\nSee ${stderrPath}`);
};
