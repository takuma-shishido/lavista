import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export interface Invocation {
  command: string;
  args: string[];
  prompt: string;
  cwd: string;
  logPrefix: string;
  timeoutSeconds: number;
  signal: AbortSignal;
}

export type ProcessRunner = (invocation: Invocation) => Promise<void>;

export const runProcess: ProcessRunner = async (invocation) => {
  const { command, args, prompt, cwd, logPrefix, timeoutSeconds, signal } = invocation;
  signal.throwIfAborted();
  const stdout = openSync(`${logPrefix}.jsonl`, "w");
  let stderr: number | undefined;
  try {
    stderr = openSync(`${logPrefix}.stderr`, "w");
    await new Promise<void>((resolve, reject) => {
      // A separate process group lets cancellation reach CLI subprocesses as well.
      const child = spawn(command, args, { cwd, detached: true, stdio: ["pipe", stdout, stderr!] });
      let failure: Error | undefined;
      let forceKill: NodeJS.Timeout | undefined;

      const killGroup = (name: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            failure ??= error as Error;
          }
        }
      };
      const stop = (reason: Error) => {
        if (failure) return;
        failure = reason;
        killGroup("SIGTERM");
        forceKill = setTimeout(() => killGroup("SIGKILL"), 5000);
      };
      const abort = () => stop(new Error("Interrupted. Logs and state saved."));
      const timer = setTimeout(() => stop(new Error(`${command} timed out`)), timeoutSeconds * 1000);
      signal.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => { failure ??= error; });
      child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") stop(error);
      });
      child.once("close", (code, exitSignal) => {
        clearTimeout(timer);
        // Kill any remaining descendants even if the CLI leader exited on SIGTERM.
        if (forceKill) {
          clearTimeout(forceKill);
          killGroup("SIGKILL");
        }
        signal.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`${command} exited ${code ?? exitSignal}; see ${logPrefix}.stderr`));
        else resolve();
      });
      child.stdin!.end(prompt);
      if (signal.aborted) abort();
    });
  } finally {
    closeSync(stdout);
    if (stderr !== undefined) closeSync(stderr);
  }
};
